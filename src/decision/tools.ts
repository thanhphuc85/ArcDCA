import type { HistoryEntry, Reflection } from "../types.js";

const SUCCESS_STATUSES = new Set(["success", "dry_run"]);

export const ANALYSIS_TOOLS = [
  {
    name: "analyze_spending_pace",
    description:
      "Compute spending pacing metrics: total spent, daily average, projected days of budget remaining, and whether the current pace is ahead/behind/on-track relative to the campaign plan. Call this before deciding an amount so you can pace spending appropriately.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "review_history",
    description:
      "Get a detailed view of recent run history including which guardrail constraints bound each decision, what was requested vs executed, error patterns, and the trend in wallet balance over time. Use this to learn from past clamping and avoid repeating rejected amounts.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number" as const,
          description: "Number of recent entries to review (default 10, max 30).",
        },
      },
      required: [] as string[],
    },
  },
  {
    name: "compute_allocation",
    description:
      "Given your desired amount, preview what the guardrails would do: which cap binds, what the clamped amount would be, and whether it would pass or be rejected as dust. Use this to test different amounts before committing to your final decision.",
    input_schema: {
      type: "object" as const,
      properties: {
        proposedAmountUsdc: {
          type: "string" as const,
          description: "The USDC amount you want to test, as a decimal string e.g. '0.75'.",
        },
      },
      required: ["proposedAmountUsdc"],
    },
  },
];

export const RECALL_REFLECTIONS_TOOL = {
  name: "recall_reflections",
  description:
    "Search your memory for past reflections and strategy insights from previous runs. Use this early in your analysis to recall what you learned from past decisions, patterns you observed, and strategy adjustments you planned. Filter by tags to find relevant lessons.",
  input_schema: {
    type: "object" as const,
    properties: {
      tags: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Optional tags to filter by, e.g. ['pacing', 'clamping', 'error-recovery']. Leave empty for most recent reflections.",
      },
      limit: {
        type: "number" as const,
        description: "Max reflections to return (default 5, max 10).",
      },
    },
    required: [] as string[],
  },
};

export function retrieveReflections(
  reflections: Reflection[],
  tags?: string[],
  limit?: number,
): { reflections: Array<{ date: string; insight: string; patterns: string[]; strategyAdjustment: string; tags: string[]; confidence: string }>; totalStored: number } {
  const cap = Math.min(Math.max(limit ?? 5, 1), 10);
  let results: Reflection[];
  if (tags && tags.length > 0) {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    results = reflections.filter((r) => r.tags.some((t) => tagSet.has(t.toLowerCase())));
  } else {
    results = reflections;
  }
  return {
    reflections: results.slice(-cap).map((r) => ({
      date: r.date,
      insight: r.insight,
      patterns: r.patterns,
      strategyAdjustment: r.strategyAdjustment,
      tags: r.tags,
      confidence: r.confidenceLevel,
    })),
    totalStored: reflections.length,
  };
}

export const DECISION_TOOL = {
  name: "record_dca_decision",
  description:
    "Record your final DCA decision after analyzing the data. Call this exactly once, after you have used the analysis tools to inform your choice.",
  input_schema: {
    type: "object" as const,
    properties: {
      proceed: { type: "boolean" as const, description: "Whether to execute a swap today." },
      amountUsdc: {
        type: "string" as const,
        description: "Recommended USDC amount to spend, as a decimal string, e.g. '0.75'.",
      },
      reasoning: {
        type: "string" as const,
        description: "1-3 sentence explanation referencing the analysis you performed.",
      },
    },
    required: ["proceed", "amountUsdc", "reasoning"],
  },
};

export interface PacingMetrics {
  totalSpentUsdc: string;
  totalRuns: number;
  successfulRuns: number;
  averagePerRun: string;
  campaignBudgetUsdc: string | null;
  remainingBudgetUsdc: string | null;
  campaignDurationDays: number | null;
  daysElapsed: number;
  projectedDaysRemaining: string;
  paceAssessment: string;
}

export function computePacingMetrics(
  history: HistoryEntry[],
  campaignBudgetUsdc?: string,
  campaignDurationDays?: number,
): PacingMetrics {
  const successful = history.filter((e) => SUCCESS_STATUSES.has(e.status));
  const totalSpent = successful.reduce((s, e) => s + Number.parseFloat(e.clampedAmountUsdc ?? "0"), 0);
  const avgPerRun = successful.length > 0 ? totalSpent / successful.length : 0;

  const uniqueDates = new Set(history.map((e) => e.date));
  const daysElapsed = uniqueDates.size;

  let remainingBudget: number | null = null;
  let projectedDaysRemaining = "unknown";
  let paceAssessment = "no campaign budget configured — spending at daily cap";

  if (campaignBudgetUsdc) {
    remainingBudget = Math.max(0, Number.parseFloat(campaignBudgetUsdc) - totalSpent);
    if (avgPerRun > 0) {
      const runsLeft = remainingBudget / avgPerRun;
      projectedDaysRemaining = runsLeft.toFixed(1);
    }

    if (campaignDurationDays) {
      const daysLeft = Math.max(0, campaignDurationDays - daysElapsed);
      const idealDailySpend = daysLeft > 0 ? remainingBudget / daysLeft : 0;
      const actualDailyAvg = daysElapsed > 0 ? totalSpent / daysElapsed : 0;

      if (daysElapsed === 0) paceAssessment = "campaign just started";
      else if (actualDailyAvg > idealDailySpend * 1.15) paceAssessment = "ahead of pace — consider reducing daily amount";
      else if (actualDailyAvg < idealDailySpend * 0.85) paceAssessment = "behind pace — consider increasing daily amount";
      else paceAssessment = "on track";
    }
  }

  return {
    totalSpentUsdc: totalSpent.toFixed(6),
    totalRuns: history.length,
    successfulRuns: successful.length,
    averagePerRun: avgPerRun.toFixed(6),
    campaignBudgetUsdc: campaignBudgetUsdc ?? null,
    remainingBudgetUsdc: remainingBudget !== null ? remainingBudget.toFixed(6) : null,
    campaignDurationDays: campaignDurationDays ?? null,
    daysElapsed,
    projectedDaysRemaining,
    paceAssessment,
  };
}

export interface DetailedHistoryEntry {
  date: string;
  status: string;
  requestedAmountUsdc: string | null;
  executedAmountUsdc: string | null;
  boundBy: string | null;
  walletBalance: string | null;
  reasoning: string | null;
  wasClampedDown: boolean;
}

export function buildDetailedHistory(history: HistoryEntry[], limit: number): DetailedHistoryEntry[] {
  const capped = Math.min(Math.max(limit, 1), 30);
  return history.slice(-capped).map((e) => ({
    date: e.date,
    status: e.status,
    requestedAmountUsdc: e.requestedAmountUsdc ?? null,
    executedAmountUsdc: e.clampedAmountUsdc ?? null,
    boundBy: e.boundBy ?? null,
    walletBalance: e.walletUsdcBalance ?? null,
    reasoning: e.reasoning ?? null,
    wasClampedDown:
      e.requestedAmountUsdc !== undefined &&
      e.clampedAmountUsdc !== undefined &&
      Number.parseFloat(e.clampedAmountUsdc) < Number.parseFloat(e.requestedAmountUsdc),
  }));
}

export interface AllocationPreview {
  proposedAmountUsdc: string;
  clampedAmountUsdc: string;
  wouldProceed: boolean;
  bindingConstraint: string;
  allCaps: Record<string, string>;
}

export function previewAllocation(
  proposedAmountUsdc: string,
  walletUsdcBalance: string,
  minReserve: string,
  maxDailyUsdc: string,
  minSwapUsdc: string,
  alreadySpentToday: string,
  remainingCampaignBudget?: string,
): AllocationPreview {
  const proposed = Number.parseFloat(proposedAmountUsdc);
  const caps: Record<string, number> = {
    proposed_amount: proposed,
    max_daily_usdc: Number.parseFloat(maxDailyUsdc),
    wallet_available_after_reserve: Math.max(0, Number.parseFloat(walletUsdcBalance) - Number.parseFloat(minReserve)),
    remaining_daily_cap: Math.max(0, Number.parseFloat(maxDailyUsdc) - Number.parseFloat(alreadySpentToday)),
  };
  if (remainingCampaignBudget) {
    caps.remaining_campaign_budget = Number.parseFloat(remainingCampaignBudget);
  }

  let bindingConstraint = "proposed_amount";
  let minVal = Number.POSITIVE_INFINITY;
  for (const [name, val] of Object.entries(caps)) {
    if (val < minVal) {
      minVal = val;
      bindingConstraint = name;
    }
  }

  const clamped = Math.max(0, minVal);
  const dust = Number.parseFloat(minSwapUsdc);

  return {
    proposedAmountUsdc,
    clampedAmountUsdc: clamped.toFixed(6),
    wouldProceed: clamped >= dust,
    bindingConstraint,
    allCaps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.toFixed(6)])),
  };
}
