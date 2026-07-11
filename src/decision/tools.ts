import type { HistoryEntry, Reflection, DcaStrategy, PriceSnapshot } from "../types.js";
import { analyzePrices, analyzeRealPrices, type DipConfig } from "../price/tracker.js";

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

export const CHECK_PRICE_ACTION_TOOL = {
  name: "check_price_action",
  description:
    "Analyze cirBTC price action from swap history to detect dips and recommend DCA amount adjustments. Returns current implied price, drawdown from high, dip signal strength (none/mild/moderate/strong), and a recommended multiplier for the base DCA amount. Call this BEFORE deciding your amount to take advantage of price dips.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

export function computePriceAction(
  history: HistoryEntry[],
  strategy: DcaStrategy,
): Record<string, unknown> {
  const dipConfig: DipConfig = {
    mildThreshold: strategy.dipMildThreshold,
    moderateThreshold: strategy.dipModerateThreshold,
    strongThreshold: strategy.dipStrongThreshold,
    mildMultiplier: strategy.dipMildMultiplier,
    moderateMultiplier: strategy.dipModerateMultiplier,
    strongMultiplier: strategy.dipStrongMultiplier,
  };
  const analysis = analyzePrices(history, dipConfig);
  return {
    baseAmountUsdc: strategy.baseAmountUsdc,
    suggestedAmountUsdc: (parseFloat(strategy.baseAmountUsdc) * analysis.dipMultiplier).toFixed(6),
    currentImpliedPrice: analysis.currentPrice !== null ? analysis.currentPrice.toFixed(6) : null,
    change24h: analysis.change24h !== null ? (analysis.change24h * 100).toFixed(2) + "%" : null,
    change7d: analysis.change7d !== null ? (analysis.change7d * 100).toFixed(2) + "%" : null,
    drawdownFromHigh: analysis.drawdownFromHigh !== null ? (analysis.drawdownFromHigh * 100).toFixed(2) + "%" : null,
    highestPrice: analysis.highestPrice?.toFixed(6) ?? null,
    lowestPrice: analysis.lowestPrice?.toFixed(6) ?? null,
    dipSignal: analysis.dipSignal,
    dipMultiplier: analysis.dipMultiplier,
    recentPrices: analysis.priceHistory.slice(-7).map((s) => ({
      date: s.date,
      price: s.impliedPrice.toFixed(6),
    })),
    recommendation: analysis.recommendation,
  };
}

export const COMPUTE_DIP_LADDER_TOOL = {
  name: "compute_dip_ladder",
  description:
    "Compute the dip-buying ladder: a set of drawdown tiers (mild → moderate → strong → deep) where a deeper dip allocates more. Returns each tier's threshold, whether it is currently triggered by the price drawdown, and a balance-aware recommended amount for the deepest triggered tier. Thresholds auto-widen when volatility is high. Use this to size buys on dips without over- or under-spending the available balance.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

interface LadderTierDef {
  name: string;
  threshold: number;
  multiplier: number;
  balanceFraction: number;
}

export function computeDipLadder(
  history: HistoryEntry[],
  strategy: DcaStrategy,
  walletUsdcBalance: string,
  minReserve: string,
  realSnapshots?: PriceSnapshot[],
): Record<string, unknown> {
  const dipConfig: DipConfig = {
    mildThreshold: strategy.dipMildThreshold,
    moderateThreshold: strategy.dipModerateThreshold,
    strongThreshold: strategy.dipStrongThreshold,
    mildMultiplier: strategy.dipMildMultiplier,
    moderateMultiplier: strategy.dipModerateMultiplier,
    strongMultiplier: strategy.dipStrongMultiplier,
  };
  const base = parseFloat(strategy.baseAmountUsdc);
  const available = Math.max(0, parseFloat(walletUsdcBalance) - parseFloat(minReserve));

  // Prefer the REAL cirBTC price series (Phase 2) when we have enough points;
  // fall back to the implied-from-own-swaps price otherwise.
  const real = analyzeRealPrices(realSnapshots ?? [], dipConfig);
  const useReal = real.pointCount >= 2 && real.drawdownFromHigh !== null;

  let drawdown: number | null;
  let cv: number;
  let priceSource: string;
  if (useReal) {
    drawdown = real.drawdownFromHigh;
    cv = real.volatilityCv ?? 0;
    priceSource = "real_cirbtc_feed";
  } else {
    const analysis = analyzePrices(history, dipConfig);
    drawdown = analysis.drawdownFromHigh;
    const prices = analysis.priceHistory.map((s) => s.impliedPrice).slice(-7);
    if (analysis.drawdownFromHigh === null || analysis.priceHistory.length < 2) {
      return {
        status: "insufficient_data",
        priceSource: "none",
        currentDrawdown: null,
        availableBalanceUsdc: available.toFixed(6),
        recommendedAmountUsdc: Math.min(base, available).toFixed(6),
        recommendation: "Not enough price history (real or implied) to build a dip ladder. Use the base DCA amount.",
      };
    }
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length;
    cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    priceSource = "implied_from_swaps";
  }

  const volatile = cv > 0.15;
  const widen = volatile ? strategy.ladderVolatilityWiden : 1.0;

  // Deeper tier = larger balance fraction. Mild/moderate/strong scale up to the
  // configurable deepest cap.
  const deepFraction = strategy.ladderMaxBalanceFraction;
  const tierDefs: LadderTierDef[] = [
    { name: "mild", threshold: strategy.dipMildThreshold, multiplier: strategy.dipMildMultiplier, balanceFraction: deepFraction * 0.2 },
    { name: "moderate", threshold: strategy.dipModerateThreshold, multiplier: strategy.dipModerateMultiplier, balanceFraction: deepFraction * 0.4 },
    { name: "strong", threshold: strategy.dipStrongThreshold, multiplier: strategy.dipStrongMultiplier, balanceFraction: deepFraction * 0.7 },
    { name: "deep", threshold: strategy.dipDeepThreshold, multiplier: strategy.dipDeepMultiplier, balanceFraction: deepFraction },
  ];

  const absDrawdown = Math.abs(drawdown ?? 0);
  let activeTier: LadderTierDef | null = null;

  const tiers = tierDefs.map((tier) => {
    const effectiveThreshold = tier.threshold * widen;
    const triggered = absDrawdown >= effectiveThreshold;
    if (triggered) activeTier = tier; // tierDefs are ascending → last triggered is deepest
    // Balance-aware target: base×multiplier, capped by the tier's balance fraction.
    const baseTarget = base * tier.multiplier;
    const balanceCap = tier.balanceFraction * available;
    const tierAllocation = Math.min(baseTarget, balanceCap);
    return {
      name: tier.name,
      drawdownThreshold: (effectiveThreshold * 100).toFixed(1) + "%",
      baseMultiplier: tier.multiplier,
      maxBalanceFraction: (tier.balanceFraction * 100).toFixed(0) + "%",
      triggered,
      tierAllocationUsdc: tierAllocation.toFixed(6),
    };
  });

  let recommended: number;
  let recommendation: string;
  if (activeTier) {
    const t = activeTier as LadderTierDef;
    const baseTarget = base * t.multiplier;
    const balanceCap = t.balanceFraction * available;
    recommended = Math.min(baseTarget, balanceCap);
    recommendation =
      `Price is ${(absDrawdown * 100).toFixed(1)}% off its high — the '${t.name}' tier is triggered` +
      `${volatile ? " (thresholds widened for high volatility)" : ""}. ` +
      `Recommend ${recommended.toFixed(6)} USDC (base ×${t.multiplier} = ${baseTarget.toFixed(6)}, ` +
      `capped at ${(t.balanceFraction * 100).toFixed(0)}% of available = ${balanceCap.toFixed(6)}).`;
  } else {
    recommended = Math.min(base, available);
    recommendation = `Price is only ${(absDrawdown * 100).toFixed(1)}% off its high — no dip tier triggered. Use the base amount ${recommended.toFixed(6)} USDC.`;
  }

  return {
    status: "ok",
    priceSource,
    currentDrawdown: (absDrawdown * 100).toFixed(2) + "%",
    volatility: { coeffOfVariation: (cv * 100).toFixed(2) + "%", volatile, thresholdsWidenedBy: widen },
    availableBalanceUsdc: available.toFixed(6),
    baseAmountUsdc: strategy.baseAmountUsdc,
    activeTier: activeTier ? (activeTier as LadderTierDef).name : null,
    tiers,
    recommendedAmountUsdc: recommended.toFixed(6),
    recommendation,
  };
}

export const GET_CIRBTC_PRICE_TOOL = {
  name: "get_cirbtc_price",
  description:
    "Get the REAL cirBTC market price (USD) from Circle's on-chain token-rates feed, plus drawdown from recent high, 24h/7d change, and volatility computed over the stored real-price series. Prefer this over check_price_action (which only infers price from the agent's own swaps). If the real series is still short, it says so.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

export function computeCirBtcPrice(
  realSnapshots: PriceSnapshot[],
  strategy: DcaStrategy,
): Record<string, unknown> {
  const dipConfig: DipConfig = {
    mildThreshold: strategy.dipMildThreshold,
    moderateThreshold: strategy.dipModerateThreshold,
    strongThreshold: strategy.dipStrongThreshold,
    mildMultiplier: strategy.dipMildMultiplier,
    moderateMultiplier: strategy.dipModerateMultiplier,
    strongMultiplier: strategy.dipStrongMultiplier,
  };
  const a = analyzeRealPrices(realSnapshots, dipConfig);
  if (a.pointCount === 0) {
    return {
      status: "no_data",
      recommendation: "No real cirBTC price recorded yet. The feed will populate over upcoming runs; use implied price for now.",
    };
  }
  const pct = (x: number | null) => (x === null ? null : (x * 100).toFixed(2) + "%");
  return {
    status: a.pointCount >= 2 ? "ok" : "bootstrapping",
    currentPriceUsd: a.currentPrice?.toFixed(2) ?? null,
    highestPriceUsd: a.highestPrice?.toFixed(2) ?? null,
    lowestPriceUsd: a.lowestPrice?.toFixed(2) ?? null,
    drawdownFromHigh: pct(a.drawdownFromHigh),
    change24h: pct(a.change24h),
    change7d: pct(a.change7d),
    volatilityCv: pct(a.volatilityCv),
    dipSignal: a.dipSignal,
    dipMultiplier: a.dipMultiplier,
    dataPoints: a.pointCount,
    note: a.pointCount < 2 ? "Only one real price point so far — drawdown/changes need more history." : undefined,
  };
}

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

export const ASSESS_MARKET_REGIME_TOOL = {
  name: "assess_market_regime",
  description:
    "Classify the current market regime by analyzing price volatility, momentum, and trend direction from swap history. Returns regime classification (trending_up, trending_down, ranging, volatile), volatility metrics, momentum score, and a risk-adjusted allocation recommendation.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

export function computeMarketRegime(history: HistoryEntry[]): Record<string, unknown> {
  const successful = history.filter(
    (e) => (e.status === "success" || e.status === "dry_run") && e.clampedAmountUsdc && e.amountOut,
  );
  if (successful.length < 3) {
    return {
      regime: "insufficient_data",
      confidence: 0,
      volatility: null,
      momentum: null,
      recommendation: "Not enough swap history to classify market regime. Use base DCA amount.",
    };
  }

  const prices = successful.map((e) => parseFloat(e.clampedAmountUsdc!) / parseFloat(e.amountOut!));
  const recent = prices.slice(-7);

  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, p) => a + (p - mean) ** 2, 0) / recent.length;
  const stdDev = Math.sqrt(variance);
  const coeffOfVariation = mean > 0 ? stdDev / mean : 0;

  let momentum = 0;
  if (recent.length >= 2) {
    const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
    const secondHalf = recent.slice(Math.floor(recent.length / 2));
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    momentum = avgFirst > 0 ? (avgSecond - avgFirst) / avgFirst : 0;
  }

  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]! > recent[i - 1]!) { consecutiveUp++; consecutiveDown = 0; }
    else { consecutiveDown++; consecutiveUp = 0; }
  }

  let regime: string;
  let confidence: number;
  let recommendation: string;

  if (coeffOfVariation > 0.15) {
    regime = "volatile";
    confidence = Math.min(90, Math.round(coeffOfVariation * 400));
    recommendation = "High volatility detected. Reduce allocation by 10-20% unless a clear dip signal overrides. Avoid chasing momentum.";
  } else if (momentum > 0.03 && consecutiveUp >= 2) {
    regime = "trending_up";
    confidence = Math.min(85, Math.round(Math.abs(momentum) * 1000 + consecutiveUp * 10));
    recommendation = "Uptrend detected. Slightly larger allocations are favorable as momentum supports price. Watch for reversal signals.";
  } else if (momentum < -0.03 && consecutiveDown >= 2) {
    regime = "trending_down";
    confidence = Math.min(85, Math.round(Math.abs(momentum) * 1000 + consecutiveDown * 10));
    recommendation = "Downtrend detected. Use dip-buying thresholds aggressively — prices may continue lower, offering better entry points.";
  } else {
    regime = "ranging";
    confidence = Math.min(75, Math.round((1 - coeffOfVariation * 5) * 75));
    recommendation = "Market is range-bound. Stick close to base DCA amount — no clear directional edge.";
  }

  return {
    regime,
    confidence,
    volatility: { coeffOfVariation: (coeffOfVariation * 100).toFixed(2) + "%", stdDev: stdDev.toFixed(6) },
    momentum: { score: (momentum * 100).toFixed(2) + "%", consecutiveUp, consecutiveDown },
    recentPriceCount: recent.length,
    recommendation,
  };
}

export const EVALUATE_RISK_TOOL = {
  name: "evaluate_risk",
  description:
    "Compute a composite risk score (0-100) based on portfolio concentration, price volatility, error/skip streaks, and spending pace. Higher score = more risk. Use this to adjust allocation size — reduce when risk is high, increase when risk is low.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

export function computeRiskScore(
  history: HistoryEntry[],
  walletBalance: string,
  alreadySpentToday: string,
  maxDaily: string,
): Record<string, unknown> {
  const factors: Array<{ name: string; score: number; weight: number; detail: string }> = [];

  const successful = history.filter((e) => e.status === "success" || e.status === "dry_run");
  const prices = successful
    .filter((e) => e.clampedAmountUsdc && e.amountOut)
    .map((e) => parseFloat(e.clampedAmountUsdc!) / parseFloat(e.amountOut!));
  if (prices.length >= 3) {
    const recent = prices.slice(-7);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, p) => a + (p - mean) ** 2, 0) / recent.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const volScore = Math.min(100, Math.round(cv * 500));
    factors.push({ name: "volatility", score: volScore, weight: 0.3, detail: `CV=${(cv * 100).toFixed(1)}%` });
  }

  const last10 = history.slice(-10);
  let errorStreak = 0;
  for (let i = last10.length - 1; i >= 0; i--) {
    if (last10[i]!.status.startsWith("error_") || last10[i]!.status.startsWith("skipped_")) errorStreak++;
    else break;
  }
  const streakScore = Math.min(100, errorStreak * 25);
  factors.push({ name: "error_streak", score: streakScore, weight: 0.2, detail: `${errorStreak} consecutive` });

  const balance = parseFloat(walletBalance);
  const spent = parseFloat(alreadySpentToday);
  const max = parseFloat(maxDaily);
  const utilizationRatio = max > 0 ? spent / max : 0;
  const utilScore = Math.min(100, Math.round(utilizationRatio * 100));
  factors.push({ name: "daily_utilization", score: utilScore, weight: 0.15, detail: `${(utilizationRatio * 100).toFixed(0)}% of daily cap` });

  const totalSpent = successful.reduce((s, e) => s + parseFloat(e.clampedAmountUsdc ?? "0"), 0);
  const concentrationRatio = balance > 0 ? totalSpent / (totalSpent + balance) : 0;
  const concScore = Math.min(100, Math.round(concentrationRatio * 120));
  factors.push({ name: "concentration", score: concScore, weight: 0.2, detail: `${(concentrationRatio * 100).toFixed(0)}% deployed` });

  const recentSuccess = last10.filter((e) => e.status === "success" || e.status === "dry_run").length;
  const successRate = last10.length > 0 ? recentSuccess / last10.length : 1;
  const reliabilityScore = Math.min(100, Math.round((1 - successRate) * 100));
  factors.push({ name: "reliability", score: reliabilityScore, weight: 0.15, detail: `${(successRate * 100).toFixed(0)}% success rate` });

  const composite = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0));
  let level: string;
  let recommendation: string;
  if (composite <= 30) {
    level = "low";
    recommendation = "Risk is low. You can increase allocation up to 20% above standard.";
  } else if (composite <= 60) {
    level = "medium";
    recommendation = "Risk is moderate. Use standard allocation with no adjustment.";
  } else {
    level = "high";
    recommendation = "Risk is elevated. Consider reducing allocation by 15-30% unless a strong dip signal overrides.";
  }

  return {
    compositeScore: composite,
    level,
    factors: factors.map((f) => ({ name: f.name, score: f.score, weight: f.weight, detail: f.detail })),
    recommendation,
  };
}

export const GET_MARKET_BRIEF_TOOL = {
  name: "get_market_brief",
  description:
    "Retrieve the market brief prepared by the Market Analyst agent. Contains: BTC price, 24h change, Fear & Greed index, on-chain trading volume on Arc Testnet, overall sentiment assessment, and an allocation bias recommendation. Call this early in your analysis to incorporate external market context.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

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
