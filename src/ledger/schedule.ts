import type { Ledger, UserAccount, DistributionRecord } from "../types.js";
import { USDC_DECIMALS, CIRBTC_DECIMALS, DEFAULT_DCA_TOKEN } from "./constants.js";
import { logger } from "../logger.js";

export interface UserSpend {
  address: string;
  spend: number; // USDC this user's schedule wants to spend this run
  tokenOut: string; // the token this user DCAs into (symbol); default DEFAULT_DCA_TOKEN
  sizeMultiplier?: number; // smart-mode dynamic-sizing factor applied this run (1 = ordinary)
}

/**
 * Group scheduled spends by their target token. Each group is settled as ONE
 * pooled swap (USDC → that token) and distributed pro-rata within the group, so
 * users who pick different tokens are never mixed into the same swap.
 */
export function groupSpendsByToken(spends: UserSpend[]): Map<string, UserSpend[]> {
  const groups = new Map<string, UserSpend[]>();
  for (const s of spends) {
    const key = s.tokenOut || DEFAULT_DCA_TOKEN;
    const g = groups.get(key);
    if (g) g.push(s); else groups.set(key, [s]);
  }
  return groups;
}

export interface ScheduleResult {
  spends: UserSpend[];
  totalUsdc: number;
}

// Optional live market context, used to gate "smart"-mode users. drawdownPct is
// the current cirBTC drawdown from its recent high (0–1); fearGreedIndex is the
// 0–100 Fear & Greed reading (null when unavailable).
export interface MarketContext {
  drawdownPct?: number;
  fearGreedIndex?: number | null;
}

// Cap per-user elapsed time so a long outage doesn't trigger a huge catch-up buy.
const MAX_CATCHUP_DAYS = 2;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}
// UTC Monday (as YYYY-MM-DD) of the week containing `ms`.
function utcWeekStart(ms: number): string {
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0=Sun
  const diff = (dow + 6) % 7; // days since Monday
  return utcDate(ms - diff * DAY_MS);
}

// Remaining cap after the rolling window's spend so far (with window rollover).
function remainingCap(capStr: string | undefined, spentStr: string | undefined, windowKey: string | undefined, currentKey: string): number {
  const cap = Number.parseFloat(capStr ?? "0");
  if (!(cap > 0)) return Infinity; // no cap configured
  const spent = windowKey === currentKey ? Number.parseFloat(spentStr ?? "0") : 0;
  return Math.max(0, cap - spent);
}

// Is a rich-schedule user due to run at `now`? Interval frequencies compare
// against lastChargedAt; weekly checks the UTC weekday + once-per-day.
function isDueNow(user: UserAccount, now: number): boolean {
  const lastMs = new Date(user.lastChargedAt ?? user.firstSeen).getTime();
  const elapsedH = (now - lastMs) / HOUR_MS;
  switch (user.dcaFrequency) {
    case "hours": {
      const every = Math.max(1, Math.min(24, Math.floor(user.dcaEveryHours ?? 24)));
      return elapsedH >= every - 0.01;
    }
    case "days": {
      const every = Math.max(1, Math.floor(user.dcaEveryDays ?? 1));
      return elapsedH >= every * 24 - 0.5;
    }
    case "weekly": {
      const days = Array.isArray(user.dcaWeekdays) ? user.dcaWeekdays : [];
      const today = new Date(now).getUTCDay();
      if (days.indexOf(today) < 0) return false;
      return utcDate(lastMs) !== utcDate(now); // at most once per UTC day
    }
    case "daily":
    default:
      return elapsedH >= 24 - 0.5;
  }
}

// Does a "smart"-mode user's market condition pass this run?
function smartConditionMet(user: UserAccount, market: MarketContext): boolean {
  if (user.dcaSmartMinDipPct != null && user.dcaSmartMinDipPct > 0) {
    const dip = (market.drawdownPct ?? 0) * 100;
    if (dip < user.dcaSmartMinDipPct) return false;
  }
  if (user.dcaSmartFearBelow != null && user.dcaSmartFearBelow > 0) {
    const fg = market.fearGreedIndex;
    if (fg == null || fg >= user.dcaSmartFearBelow) return false;
  }
  return true;
}

// --- Smart-mode dynamic sizing ---
// Turns the binary "buy / skip" gate into a continuous knob: when a smart user
// does buy, the amount scales with how cheap the market looks. Driven by real,
// external signals (Fear & Greed from the market analyst; cirBTC drawdown when a
// live price exists), bounded to a safe range — and the caller still clamps the
// result by the user's daily/weekly caps, wallet balance, and clampDecision, so
// the multiplier can never breach a hard limit.
const SMART_DIP_REF = 0.10;   // a 10% drawdown contributes +1.0x
const SMART_DIP_CAP = 2.0;    // …capped so an extreme dip alone can't exceed +2.0x
const SMART_FEAR_WEIGHT = 1.0; // extreme fear (0) → +1.0x, extreme greed (100) → −1.0x
const SMART_MIN_MULT = 0.5;   // never buy less than half the base
const SMART_MAX_MULT = 3.0;   // never buy more than triple the base

/**
 * How much a smart-mode buy scales this run, in [SMART_MIN_MULT, SMART_MAX_MULT].
 * Buy MORE in dips and fear, LESS in froth; a neutral or unknown market returns
 * exactly 1.0 (ordinary DCA), so missing data can only be safe.
 */
export function smartSizeMultiplier(market: MarketContext): number {
  let mult = 1;
  const dd = market.drawdownPct ?? 0;
  if (dd > 0) mult += Math.min(SMART_DIP_CAP, dd / SMART_DIP_REF);
  const fg = market.fearGreedIndex;
  if (fg != null && Number.isFinite(fg)) mult += ((50 - fg) / 50) * SMART_FEAR_WEIGHT;
  return Math.max(SMART_MIN_MULT, Math.min(SMART_MAX_MULT, mult));
}

/**
 * Deterministic per-user recurring DCA. Each active user contributes a spend
 * this run; the agent swaps the SUM. Two models coexist:
 *   • Rich schedule (dcaFrequency set): spend a fixed dcaAmountPerRun whenever
 *     the user's cadence is due, gated by smart conditions and daily/weekly caps.
 *   • Legacy (no dcaFrequency): rate/day × elapsed at the fixed 07/13/19 UTC
 *     slots, honoring dcaRunsPerDay.
 */
export function computeScheduledSpends(ledger: Ledger, nowIso: string, market: MarketContext = {}, defaultToken: string = DEFAULT_DCA_TOKEN): ScheduleResult {
  const now = new Date(nowIso).getTime();
  const utcHour = new Date(nowIso).getUTCHours();
  const legacySlot = utcHour < 12 ? 0 : utcHour < 18 ? 1 : 2;
  const isLegacySlotHour = utcHour === 7 || utcHour === 13 || utcHour === 19;
  const dayKey = utcDate(now);
  const weekKey = utcWeekStart(now);
  const spends: UserSpend[] = [];
  let total = 0;

  for (const user of Object.values(ledger.users)) {
    if (user.dcaPaused) continue;
    if (user.dcaMode === "manual") continue; // manual users only buy on demand
    const balance = Number.parseFloat(user.usdcBalance ?? "0");
    if (!(balance > 0)) continue;

    let spend = 0;
    let sizeMultiplier = 1;

    if (user.dcaFrequency) {
      // --- Rich schedule ---
      if (!isDueNow(user, now)) continue;
      if (user.dcaMode === "smart" && !smartConditionMet(user, market)) continue;
      let amount = Number.parseFloat(user.dcaAmountPerRun ?? "0");
      if (!(amount > 0)) continue;
      // Smart mode scales the buy by how cheap the market looks (dip + fear),
      // bounded — then the caps below still clamp the result.
      if (user.dcaMode === "smart") {
        sizeMultiplier = smartSizeMultiplier(market);
        amount *= sizeMultiplier;
      }
      // Honor daily + weekly caps.
      amount = Math.min(
        amount,
        remainingCap(user.dcaDailyCapUsdc, user.dcaSpentDayUsdc, user.dcaSpentDayDate, dayKey),
        remainingCap(user.dcaWeeklyCapUsdc, user.dcaSpentWeekUsdc, user.dcaSpentWeekStart, weekKey),
      );
      spend = Number.parseFloat(Math.min(amount, balance).toFixed(USDC_DECIMALS));
    } else {
      // --- Legacy rate/day model at fixed slots ---
      if (!isLegacySlotHour) continue;
      const runsPerDay = user.dcaRunsPerDay === 1 || user.dcaRunsPerDay === 2 ? user.dcaRunsPerDay : 3;
      if (runsPerDay === 1 && legacySlot !== 0) continue;
      if (runsPerDay === 2 && legacySlot === 1) continue;
      const rate = Number.parseFloat(user.dcaRatePerDay ?? "0");
      if (!(rate > 0)) continue;
      const lastMs = new Date(user.lastChargedAt ?? user.firstSeen).getTime();
      let elapsedDays = (now - lastMs) / DAY_MS;
      if (!(elapsedDays > 0)) continue;
      elapsedDays = Math.min(elapsedDays, MAX_CATCHUP_DAYS);
      spend = Number.parseFloat(Math.min(rate * elapsedDays, balance).toFixed(USDC_DECIMALS));
    }

    if (spend > 0) {
      const entry: UserSpend = { address: user.address, spend, tokenOut: user.dcaTokenOut || defaultToken };
      if (user.dcaMode === "smart") entry.sizeMultiplier = sizeMultiplier; // smart-mode annotation only
      spends.push(entry);
      total += spend;
    }
  }

  return { spends, totalUsdc: Number.parseFloat(total.toFixed(USDC_DECIMALS)) };
}

/**
 * Attribute an executed swap back to the per-user schedule for ONE token group:
 * each user gets the received token in proportion to their scheduled spend, and
 * their USDC is debited by the amount actually executed (scaled down if a
 * guardrail capped the group total below schedule). `tokenSymbol`/`tokenDecimals`
 * default to cirBTC, so existing single-token callers are unchanged.
 */
export function applyScheduledDistribution(
  ledger: Ledger,
  spends: UserSpend[],
  executedUsdc: string,
  tokenReceived: string,
  runTimestamp: string,
  tokenSymbol: string = DEFAULT_DCA_TOKEN,
  tokenDecimals: number = CIRBTC_DECIMALS,
): DistributionRecord | null {
  const scheduledTotal = spends.reduce((s, x) => s + x.spend, 0);
  const executed = Number.parseFloat(executedUsdc);
  const received = Number.parseFloat(tokenReceived);
  if (scheduledTotal <= 0 || executed <= 0 || received <= 0) return null;

  const scale = Math.min(1, executed / scheduledTotal); // guardrail may cap total below schedule

  const allocations: DistributionRecord["allocations"] = [];
  let sumUsdc = 0;
  let sumTok = 0;

  for (const { address, spend } of spends) {
    const user = ledger.users[address];
    if (!user) continue;
    const fraction = spend / scheduledTotal;
    const usdcShare = Number.parseFloat((spend * scale).toFixed(USDC_DECIMALS));
    const tokShare = Number.parseFloat((fraction * received).toFixed(tokenDecimals));
    allocations.push({
      address,
      usdcShare: usdcShare.toFixed(USDC_DECIMALS),
      cirBtcShare: tokShare.toFixed(tokenDecimals), // received-token share (field kept for back-compat)
      poolFraction: fraction.toFixed(8),
    });
    sumUsdc += usdcShare;
    sumTok += tokShare;
  }

  // Assign the rounding remainder to the largest contributor so the books close
  // EXACTLY. The remainder is signed: per-share rounding can push the sum a hair
  // above OR below the executed/received totals, and both directions must be
  // absorbed (an earlier version only handled the positive side, leaving a
  // sub-micro over-debit when rounding overshot). Sub-token magnitude, clamped
  // so a share can never go negative.
  if (allocations.length > 0) {
    const largest = allocations.reduce((max, a) => (parseFloat(a.poolFraction) > parseFloat(max.poolFraction) ? a : max));
    largest.usdcShare = Math.max(0, parseFloat(largest.usdcShare) + (executed - sumUsdc)).toFixed(USDC_DECIMALS);
    largest.cirBtcShare = Math.max(0, parseFloat(largest.cirBtcShare) + (received - sumTok)).toFixed(tokenDecimals);
  }

  const isCirBtc = tokenSymbol === "cirBTC";
  const nowMs = new Date(runTimestamp).getTime();
  const dayKey = utcDate(nowMs);
  const weekKey = utcWeekStart(nowMs);
  for (const alloc of allocations) {
    const user = ledger.users[alloc.address];
    if (!user) continue;
    const share = parseFloat(alloc.usdcShare);
    const tok = parseFloat(alloc.cirBtcShare);
    user.usdcBalance = Math.max(0, parseFloat(user.usdcBalance) - share).toFixed(USDC_DECIMALS);
    // Credit the per-token holding; mirror cirBtcBalance so older readers keep
    // working. Seed a missing cirBTC entry from the legacy cirBtcBalance field.
    const balances = (user.tokenBalances ??= {});
    const prior = parseFloat(balances[tokenSymbol] ?? (isCirBtc ? user.cirBtcBalance : "0"));
    balances[tokenSymbol] = (prior + tok).toFixed(tokenDecimals);
    if (isCirBtc) user.cirBtcBalance = balances[tokenSymbol]!;
    user.totalSwapped = (parseFloat(user.totalSwapped) + share).toFixed(USDC_DECIMALS);
    // Roll the daily/weekly spend windows forward, resetting when they lapse.
    const daySpent = user.dcaSpentDayDate === dayKey ? parseFloat(user.dcaSpentDayUsdc ?? "0") : 0;
    user.dcaSpentDayUsdc = (daySpent + share).toFixed(USDC_DECIMALS);
    user.dcaSpentDayDate = dayKey;
    const weekSpent = user.dcaSpentWeekStart === weekKey ? parseFloat(user.dcaSpentWeekUsdc ?? "0") : 0;
    user.dcaSpentWeekUsdc = (weekSpent + share).toFixed(USDC_DECIMALS);
    user.dcaSpentWeekStart = weekKey;
    user.lastChargedAt = runTimestamp;
    user.lastActivity = runTimestamp;
  }

  const record: DistributionRecord = {
    runTimestamp,
    tokenOut: tokenSymbol,
    totalUsdcSwapped: executedUsdc,
    totalCirBtcReceived: tokenReceived, // received-token total (field kept for back-compat)
    allocations,
    timestamp: new Date().toISOString(),
  };
  ledger.distributions.push(record);
  logger.info(`Distribution: ${executedUsdc} USDC / ${tokenReceived} ${tokenSymbol} across ${allocations.length} user(s)`);
  return record;
}
