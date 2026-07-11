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
}

export interface DecisionContext {
  date: string;
  dayCount: number;
  walletUsdcBalance: string;
  guardrails: GuardrailConfig;
  dcaStrategy: DcaStrategy;
  remainingCampaignBudgetUsdc?: string;
  alreadySpentTodayUsdc: string;
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
  cirBtcBalance: string;
  totalDeposited: string;
  totalSwapped: string;
  totalWithdrawnCirBtc: string;
  totalWithdrawnUsdc: string;
  firstSeen: string;
  lastActivity: string;
}

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
  totalUsdcSwapped: string;
  totalCirBtcReceived: string;
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
