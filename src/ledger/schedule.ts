import type { Ledger, DistributionRecord } from "../types.js";
import { USDC_DECIMALS, CIRBTC_DECIMALS } from "./constants.js";
import { logger } from "../logger.js";

export interface UserSpend {
  address: string;
  spend: number; // USDC this user's schedule wants to spend this run
}

export interface ScheduleResult {
  spends: UserSpend[];
  totalUsdc: number;
}

// Cap per-user elapsed time so a long outage doesn't trigger a huge catch-up buy.
const MAX_CATCHUP_DAYS = 2;

/**
 * Cách B — deterministic per-user recurring DCA. For each active user, the amount
 * to spend this run = their rate/day × days elapsed since we last charged them,
 * capped by their own USDC balance. The run swaps the SUM of these.
 */
export function computeScheduledSpends(ledger: Ledger, nowIso: string): ScheduleResult {
  const now = new Date(nowIso).getTime();
  const spends: UserSpend[] = [];
  let total = 0;

  for (const user of Object.values(ledger.users)) {
    if (user.dcaPaused) continue;
    // Manual-mode users are excluded from the scheduled cron; they only buy
    // when they trigger it themselves from the dashboard.
    if (user.dcaMode === "manual") continue;
    const rate = Number.parseFloat(user.dcaRatePerDay ?? "0");
    const balance = Number.parseFloat(user.usdcBalance ?? "0");
    if (!(rate > 0) || !(balance > 0)) continue;

    const lastIso = user.lastChargedAt ?? user.firstSeen;
    const lastMs = new Date(lastIso).getTime();
    let elapsedDays = (now - lastMs) / (24 * 3600 * 1000);
    if (!(elapsedDays > 0)) continue;
    elapsedDays = Math.min(elapsedDays, MAX_CATCHUP_DAYS);

    const intended = rate * elapsedDays;
    const spend = Number.parseFloat(Math.min(intended, balance).toFixed(USDC_DECIMALS));
    if (spend > 0) {
      spends.push({ address: user.address, spend });
      total += spend;
    }
  }

  return { spends, totalUsdc: Number.parseFloat(total.toFixed(USDC_DECIMALS)) };
}

/**
 * Attribute an executed swap back to the per-user schedule: each user gets cirBTC
 * in proportion to their scheduled spend, and their USDC is debited by the amount
 * actually executed (scaled down if a guardrail capped the total below schedule).
 */
export function applyScheduledDistribution(
  ledger: Ledger,
  spends: UserSpend[],
  executedUsdc: string,
  cirBtcReceived: string,
  runTimestamp: string,
): DistributionRecord | null {
  const scheduledTotal = spends.reduce((s, x) => s + x.spend, 0);
  const executed = Number.parseFloat(executedUsdc);
  const received = Number.parseFloat(cirBtcReceived);
  if (scheduledTotal <= 0 || executed <= 0 || received <= 0) return null;

  const scale = Math.min(1, executed / scheduledTotal); // guardrail may cap total below schedule

  const allocations: DistributionRecord["allocations"] = [];
  let sumUsdc = 0;
  let sumBtc = 0;

  for (const { address, spend } of spends) {
    const user = ledger.users[address];
    if (!user) continue;
    const fraction = spend / scheduledTotal;
    const usdcShare = Number.parseFloat((spend * scale).toFixed(USDC_DECIMALS));
    const cirBtcShare = Number.parseFloat((fraction * received).toFixed(CIRBTC_DECIMALS));
    allocations.push({
      address,
      usdcShare: usdcShare.toFixed(USDC_DECIMALS),
      cirBtcShare: cirBtcShare.toFixed(CIRBTC_DECIMALS),
      poolFraction: fraction.toFixed(8),
    });
    sumUsdc += usdcShare;
    sumBtc += cirBtcShare;
  }

  // Assign rounding remainder to the largest contributor.
  const usdcRemainder = executed - sumUsdc;
  const btcRemainder = received - sumBtc;
  if ((usdcRemainder > 0 || btcRemainder > 0) && allocations.length > 0) {
    const largest = allocations.reduce((max, a) => (parseFloat(a.poolFraction) > parseFloat(max.poolFraction) ? a : max));
    if (usdcRemainder > 0) largest.usdcShare = (parseFloat(largest.usdcShare) + usdcRemainder).toFixed(USDC_DECIMALS);
    if (btcRemainder > 0) largest.cirBtcShare = (parseFloat(largest.cirBtcShare) + btcRemainder).toFixed(CIRBTC_DECIMALS);
  }

  for (const alloc of allocations) {
    const user = ledger.users[alloc.address];
    if (!user) continue;
    user.usdcBalance = Math.max(0, parseFloat(user.usdcBalance) - parseFloat(alloc.usdcShare)).toFixed(USDC_DECIMALS);
    user.cirBtcBalance = (parseFloat(user.cirBtcBalance) + parseFloat(alloc.cirBtcShare)).toFixed(CIRBTC_DECIMALS);
    user.totalSwapped = (parseFloat(user.totalSwapped) + parseFloat(alloc.usdcShare)).toFixed(USDC_DECIMALS);
    user.lastChargedAt = runTimestamp;
    user.lastActivity = runTimestamp;
  }

  const record: DistributionRecord = {
    runTimestamp,
    totalUsdcSwapped: executedUsdc,
    totalCirBtcReceived: cirBtcReceived,
    allocations,
    timestamp: new Date().toISOString(),
  };
  ledger.distributions.push(record);
  logger.info(`Rate-based distribution: ${executedUsdc} USDC / ${cirBtcReceived} cirBTC across ${allocations.length} user(s)`);
  return record;
}
