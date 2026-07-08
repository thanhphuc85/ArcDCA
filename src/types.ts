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
