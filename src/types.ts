export type RunStatus =
  | "success"
  | "dry_run"
  | "skipped_insufficient_balance"
  | "skipped_llm_declined"
  | "skipped_guardrail_clamped"
  | "error_rpc"
  | "error_llm_api"
  | "error_llm_invalid_output"
  | "error_swap_failed"
  | "error_config"
  | "error_unexpected";

export interface GuardrailConfig {
  maxDailyUsdc: string;
  minUsdcReserve: string;
  minSwapUsdc: string;
  campaignTotalBudgetUsdc?: string;
  campaignDurationDays?: number;
}

export interface DcaStrategy {
  baseAmountUsdc: string;
  dipMildThreshold: number;
  dipModerateThreshold: number;
  dipStrongThreshold: number;
  dipMildMultiplier: number;
  dipModerateMultiplier: number;
  dipStrongMultiplier: number;
  // Phase 1 dip-ladder: a 4th (deepest) tier, plus knobs for balance-aware
  // allocation and dynamic-volatility threshold widening.
  dipDeepThreshold: number;
  dipDeepMultiplier: number;
  ladderVolatilityWiden: number; // multiply tier thresholds by this when volatile
  ladderMaxBalanceFraction: number; // deepest tier's cap as a fraction of available balance
}

export interface HistoryEntry {
  date: string; // ISO date, e.g. 2026-07-08
  timestamp: string; // full ISO timestamp of the run
  status: RunStatus;
  requestedAmountUsdc?: string; // what Claude proposed
  clampedAmountUsdc?: string; // what guardrails.ts actually allowed
  boundBy?: string; // which constraint(s) bound the clamped amount
  tokenOut: string;
  reasoning?: string; // Claude's stated reasoning
  txHash?: string;
  explorerUrl?: string;
  amountOut?: string;
  walletUsdcBalance?: string;
  message?: string; // human-readable summary, especially for skip/error cases
  // Present when a smart-mode user took part in this run: the market snapshot and
  // the base (sensitivity 1) size multiplier it produced — the on-chain audit of
  // the agent's dynamic sizing this run. `source` says whether the agent chose the
  // multiplier ("llm") or the deterministic formula did ("formula"); when the
  // agent chose it, `proposedMultiplier` is its pre-clamp value.
  smartSizing?: {
    fearGreed: number | null;
    drawdownPct: number;
    multiplier: number;
    source?: "llm" | "formula";
    proposedMultiplier?: number | null;
  };
}

export interface DecisionContext {
  date: string;
  dayCount: number;
  walletUsdcBalance: string;
  guardrails: GuardrailConfig;
  dcaStrategy: DcaStrategy;
  remainingCampaignBudgetUsdc?: string;
  alreadySpentTodayUsdc: string;
  // Code-measured cirBTC-route outage. outageDurationDays is DISTINCT calendar
  // days; outageConsecutiveRuns is the trailing failed-run tally. The agent must
  // cite the days figure and never derive days from the run count.
  outageConsecutiveRuns: number;
  outageDurationDays: number;
  recentHistory: Array<{
    date: string;
    status: RunStatus;
    amountUsdc?: string;
    reasoningSummary?: string;
  }>;
}

export interface ClaudeDecision {
  proceed: boolean;
  amountUsdc: string;
  reasoning: string;
}

export interface ClampedDecision {
  proceed: boolean;
  amountUsdc: string;
  boundBy: string;
  skipReason?: "llm_declined" | "invalid_llm_amount" | "below_dust_threshold" | "daily_cap_exhausted";
}

// ---- Per-User Ledger Types ----

export interface UserAccount {
  address: string;
  usdcBalance: string;
  cirBtcBalance: string; // canonical cirBTC holding; mirrors tokenBalances["cirBTC"]
  // Per-token holdings (symbol → balance string), for users who DCA into tokens
  // other than cirBTC. cirBtcBalance stays the source of truth for cirBTC so
  // older ledgers and the dashboard keep working unchanged.
  tokenBalances?: Record<string, string>;
  totalDeposited: string;
  totalSwapped: string;
  totalWithdrawnCirBtc: string;
  totalWithdrawnUsdc: string;
  firstSeen: string;
  lastActivity: string;
  // Per-user recurring DCA (Cách B). Optional for backward compatibility with
  // ledgers written before this feature; code fills defaults when absent.
  dcaRatePerDay?: string; // USDC/day this user's schedule spends
  dcaRateIsCustom?: boolean; // true once the user sets it themselves (don't auto-recompute)
  dcaPaused?: boolean; // user paused their DCA
  // Execution mode:
  //   "auto"   — the scheduled cron runs on the user's frequency.
  //   "manual" — cron skips this user; they only buy on demand from the UI.
  //   "smart"  — like auto, but each scheduled run is additionally gated on
  //              market conditions (min dip and/or Fear & Greed below N).
  dcaMode?: "auto" | "manual" | "smart";

  // --- Rich schedule (new model). When dcaFrequency is set, the scheduler uses
  //     dcaAmountPerRun + the cadence below instead of the legacy rate/day. ---
  dcaFrequency?: "daily" | "hours" | "days" | "weekly";
  dcaEveryHours?: number;    // frequency "hours": run every N hours (1–24)
  dcaEveryDays?: number;     // frequency "days": run every N days
  dcaWeekdays?: number[];    // frequency "weekly": UTC weekdays, 0=Sun … 6=Sat
  dcaAmountPerRun?: string;  // USDC spent per execution (new sizing model)
  dcaDailyCapUsdc?: string;  // max USDC/day (absent or "0" = no cap)
  dcaWeeklyCapUsdc?: string; // max USDC/week (absent or "0" = no cap)
  dcaSmartMinDipPct?: number;  // smart: only run if drawdown-from-high ≥ this %
  dcaSmartFearBelow?: number;  // smart: only run if Fear & Greed index < this
  dcaSmartSensitivity?: number; // smart: how hard the market read scales the buy (default 1)
  dcaSmartMaxMult?: number;     // smart: ceiling on the size multiplier (default 3)
  // Which token this user dollar-cost-averages into (symbol, see
  // SUPPORTED_DCA_TOKENS). Absent = the default (cirBTC). The user picks it; the
  // agent only advises. Users choosing different tokens are pooled per-token —
  // one swap per token group each run.
  dcaTokenOut?: string;

  // Rolling spend windows, maintained by applyScheduledDistribution, used to
  // enforce the daily/weekly caps. Dates are UTC YYYY-MM-DD.
  dcaSpentDayUsdc?: string;
  dcaSpentDayDate?: string;
  dcaSpentWeekUsdc?: string;
  dcaSpentWeekStart?: string; // UTC Monday of the tracked week

  // --- Legacy model (kept for backward compatibility) ---
  // How many scheduled runs per day at the fixed 07/13/19 UTC slots. Only used
  // for accounts that predate the rich schedule (no dcaFrequency set).
  dcaRunsPerDay?: 1 | 2 | 3;

  lastChargedAt?: string; // ISO timestamp of the last run that spent for this user
}

// Default deploy horizon (days) used to derive a user's auto rate = deposit / horizon.
export const DEFAULT_DCA_HORIZON_DAYS = 30;

export interface DepositRecord {
  id: string;
  txHash: string;
  from: string;
  amount: string;
  blockNumber: number;
  recordedAt: string;
}

export interface DistributionRecord {
  runTimestamp: string;
  tokenOut?: string; // which token this group bought (absent = cirBTC, for old records)
  totalUsdcSwapped: string;
  totalCirBtcReceived: string; // received-token total; name kept for back-compat
  allocations: Array<{
    address: string;
    usdcShare: string;
    cirBtcShare: string;
    poolFraction: string;
  }>;
  timestamp: string;
}

export type WithdrawalStatus = "pending" | "processing" | "completed" | "failed";
export type WithdrawalToken = "USDC" | "cirBTC";

export interface WithdrawalRequest {
  id: string;
  address: string;
  token: WithdrawalToken;
  amount: string;
  status: WithdrawalStatus;
  requestedAt: string;
  processedAt?: string;
  txHash?: string;
  error?: string;
}

export interface Ledger {
  version: 1;
  lastScannedBlock: number;
  users: Record<string, UserAccount>;
  deposits: DepositRecord[];
  distributions: DistributionRecord[];
  withdrawals: WithdrawalRequest[];
}

// ---- Real cirBTC price feed (Phase 2) ----

export interface PriceSnapshot {
  date: string; // ISO date
  timestamp: string; // full ISO timestamp
  priceUsd: number; // real cirBTC price in USD (from Circle Swap Kit getTokenRates)
  source: string; // e.g. "circle_swapkit"
}

// ---- External Market Data Types ----

export interface MarketData {
  btcPriceUsd: number;
  btcChange24h: number;
  btcVolume24h: number;
  btcMarketCap: number;
  priceHistory7d: Array<{ timestamp: number; price: number }>;
  fetchedAt: string;
}

export interface FearGreedData {
  value: number;
  classification: string;
  timestamp: string;
}

export interface OnChainVolume {
  usdcTransferCount: number;
  usdcVolumeTotal: string;
  cirBtcTransferCount: number;
  cirBtcVolumeTotal: string;
  blockRange: { from: number; to: number };
  periodHours: number;
}

export interface MarketBrief {
  sentiment: "very_bearish" | "bearish" | "neutral" | "bullish" | "very_bullish";
  confidence: number;
  btcPrice: string;
  btcChange24h: string;
  fearGreedIndex: number | null;
  fearGreedLabel: string;
  onChainActivity: "low" | "moderate" | "high";
  keyInsights: string[];
  allocationBias: string;
  rawData: {
    market?: MarketData;
    fearGreed?: FearGreedData;
    onChainVolume?: OnChainVolume;
  };
  generatedAt: string;
  model: string;
}

export interface Reflection {
  id: string;
  date: string;
  timestamp: string;
  runStatus: RunStatus;
  insight: string;
  patterns: string[];
  strategyAdjustment: string;
  confidenceLevel: "low" | "medium" | "high";
  cumulativeSpentUsdc: string;
  dayNumber: number;
  walletBalance: string;
  tags: string[];
}
