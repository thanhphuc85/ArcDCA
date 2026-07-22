import Anthropic from "@anthropic-ai/sdk";
import type { MarketBrief } from "../types.js";
import { SMART_MIN_MULT, SMART_DEFAULT_MAX_MULT } from "../ledger/schedule.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";

const SIZING_MODEL = "claude-haiku-4-5-20251001";

export interface SmartSizingProposal {
  multiplier: number;    // clamped to [SMART_MIN_MULT, SMART_DEFAULT_MAX_MULT]
  rawMultiplier: number; // what the agent proposed, before the clamp
  deviation: number;     // multiplier − 1, fed to per-user sizing as the market read
  rationale: string;
}

/** Clamp the agent's proposed multiplier into the hard, code-owned envelope. */
export function clampProposedMultiplier(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(SMART_MIN_MULT, Math.min(SMART_DEFAULT_MAX_MULT, raw));
}

const SIZING_TOOL = {
  name: "set_size_multiplier",
  description: "Choose how much to scale this run's dollar-cost-averaging buys relative to the baseline (1.0 = normal).",
  input_schema: {
    type: "object" as const,
    properties: {
      multiplier: {
        type: "number" as const,
        description: `Size multiplier in [${SMART_MIN_MULT}, ${SMART_DEFAULT_MAX_MULT}]. >1 buys more (dips, fear, oversold); <1 buys less (froth, greed); 1.0 = neutral.`,
      },
      rationale: {
        type: "string" as const,
        description: "One sentence: the market read behind this multiplier.",
      },
    },
    required: ["multiplier", "rationale"],
  },
};

const SIZING_SYSTEM = `You size dollar-cost-averaging buys for an autonomous agent. Given a market brief, choose a single multiplier that scales this run's buys, then call set_size_multiplier.

Principles:
- DCA thesis: accumulate steadily; never swing violently. 1.0 is the default.
- Buy MORE (>1) into weakness — drawdowns, extreme fear, oversold conditions.
- Buy LESS (<1) into froth — strong rallies, extreme greed.
- Be measured: most runs stay near 1.0. Reserve the extremes for clear, strong signals.
- Your number is bounded and re-clamped by code afterwards; give your honest read within the range, not a number gamed against the clamp.`;

function buildSizingPrompt(ctx: { brief: MarketBrief | null; drawdownPct: number; recentReflections?: string[] }): string {
  const { brief, drawdownPct, recentReflections } = ctx;
  const lines: string[] = ["# Market context for sizing this DCA run\n"];
  lines.push(`- cirBTC drawdown from recent high: ${(drawdownPct * 100).toFixed(1)}%`);
  if (brief) {
    lines.push(`- Sentiment: ${brief.sentiment} (confidence ${brief.confidence}%)`);
    lines.push(`- Fear & Greed: ${brief.fearGreedIndex ?? "n/a"} (${brief.fearGreedLabel})`);
    lines.push(`- BTC 24h change: ${brief.btcChange24h}, price ${brief.btcPrice}`);
    lines.push(`- On-chain activity: ${brief.onChainActivity}`);
    if (brief.keyInsights?.length) lines.push(`- Analyst insights:\n${brief.keyInsights.map((i) => "  • " + i).join("\n")}`);
    lines.push(`- Analyst allocation bias: ${brief.allocationBias}`);
  } else {
    lines.push("- Market brief unavailable this run — lean neutral unless the drawdown alone is a strong signal.");
  }
  if (recentReflections?.length) {
    lines.push(`\nRecent self-reflections:\n${recentReflections.map((r) => "  • " + r).join("\n")}`);
  }
  lines.push("\nChoose the size multiplier and call set_size_multiplier.");
  return lines.join("\n");
}

/**
 * Ask the agent to size this run's buys within the smart-sizing envelope. The
 * returned multiplier is already clamped to [SMART_MIN_MULT, SMART_DEFAULT_MAX_MULT];
 * `deviation` (= multiplier − 1) is what per-user sizing consumes, and each user's
 * sensitivity/max-multiplier still bound it further. Best-effort: any failure
 * returns null, and the caller falls back to the deterministic formula — the agent
 * gets bounded agency over the amount, never unbounded control.
 */
export async function proposeSmartMultiplier(
  apiKey: string,
  ctx: { brief: MarketBrief | null; drawdownPct: number; recentReflections?: string[] },
): Promise<SmartSizingProposal | null> {
  try {
    const client = new Anthropic({ apiKey });
    const response = await withRetry(
      () => client.messages.create({
        model: SIZING_MODEL,
        max_tokens: 512,
        system: SIZING_SYSTEM,
        messages: [{ role: "user", content: buildSizingPrompt(ctx) }],
        tools: [SIZING_TOOL] as Anthropic.Tool[],
        tool_choice: { type: "tool" as const, name: "set_size_multiplier" },
      }),
      { maxRetries: 2, label: "Sizing agent" },
    );

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      logger.warn("Sizing agent produced no tool call — falling back to formula");
      return null;
    }
    const input = block.input as { multiplier: number; rationale: string };
    const raw = Number(input.multiplier);
    if (!Number.isFinite(raw)) {
      logger.warn("Sizing agent returned a non-numeric multiplier — falling back to formula");
      return null;
    }
    const multiplier = clampProposedMultiplier(raw);
    logger.info(`Sizing agent: ×${multiplier.toFixed(2)} (proposed ${raw.toFixed(2)}) — ${input.rationale}`);
    return { multiplier, rawMultiplier: raw, deviation: multiplier - 1, rationale: input.rationale };
  } catch (err) {
    logger.warn(`Sizing agent failed (non-fatal): ${(err as Error).message}`);
    return null;
  }
}
