import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { HistoryEntry, Reflection } from "../types.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";
import { totalSpent } from "../history/store.js";

const reflectionSchema = z.object({
  insight: z.string().min(1),
  patterns: z.array(z.string()),
  strategyAdjustment: z.string().min(1),
  confidenceLevel: z.enum(["low", "medium", "high"]),
  tags: z.array(z.string()),
});

const REFLECTION_TOOL = {
  name: "record_reflection",
  description: "Record your reflection on this DCA run. Analyze what happened, what patterns you see, and what to adjust next time.",
  input_schema: {
    type: "object" as const,
    properties: {
      insight: {
        type: "string" as const,
        description: "1-2 sentence key takeaway from this run. What is the most important observation?",
      },
      patterns: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Recurring patterns you observe across recent runs (e.g., 'consistently clamped by daily cap', 'error streak recovering').",
      },
      strategyAdjustment: {
        type: "string" as const,
        description: "What should the agent do differently in the next run? Be specific and actionable.",
      },
      confidenceLevel: {
        type: "string" as const,
        enum: ["low", "medium", "high"],
        description: "How confident are you in this reflection given the available data?",
      },
      tags: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Categorization tags for retrieval, e.g. 'pacing', 'clamping', 'error-recovery', 'budget', 'market-timing'.",
      },
    },
    required: ["insight", "patterns", "strategyAdjustment", "confidenceLevel", "tags"],
  },
};

const SYSTEM_PROMPT = `You are a reflective DCA agent reviewing the outcome of your latest run. Your job is to generate a concise, honest reflection that will help your future self make better decisions.

Analyze what happened in this run in the context of recent history. Look for:
- Patterns in clamping, errors, or skips
- Whether your pacing strategy is working
- What constraints are binding most often
- Whether your past strategy adjustments are being effective

Call record_reflection with your analysis. Be specific and actionable — vague reflections like "keep monitoring" are not useful.`;

export async function generateReflection(
  apiKey: string,
  latestEntry: HistoryEntry,
  recentHistory: HistoryEntry[],
  allHistory: HistoryEntry[],
): Promise<Reflection | null> {
  try {
    const client = new Anthropic({ apiKey });
    const dayNumber = allHistory.length;
    const cumSpent = totalSpent(allHistory);

    const userPrompt = `Latest run result:\n${JSON.stringify(latestEntry, null, 2)}\n\nRecent history (last 8 runs):\n${JSON.stringify(
      recentHistory.slice(-8).map((e) => ({
        date: e.date,
        status: e.status,
        requested: e.requestedAmountUsdc,
        executed: e.clampedAmountUsdc,
        boundBy: e.boundBy,
        reasoning: e.reasoning,
      })),
      null,
      2,
    )}\n\nDay ${dayNumber} of campaign. Cumulative spent: ${cumSpent} USDC.\n\nReflect on this run and call record_reflection.`;

    const response = await withRetry(
      () =>
        client.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
          tools: [REFLECTION_TOOL] as Anthropic.Tool[],
          tool_choice: { type: "tool" as const, name: "record_reflection" },
        }),
      { maxRetries: 2, label: "Reflection API" },
    );

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      logger.warn("Reflection: no tool call in response");
      return null;
    }

    const parsed = reflectionSchema.safeParse(toolBlock.input);
    if (!parsed.success) {
      logger.warn(`Reflection validation failed: ${parsed.error.message}`);
      return null;
    }

    return {
      id: `ref-${Date.now()}`,
      date: latestEntry.date,
      timestamp: new Date().toISOString(),
      runStatus: latestEntry.status,
      insight: parsed.data.insight,
      patterns: parsed.data.patterns,
      strategyAdjustment: parsed.data.strategyAdjustment,
      confidenceLevel: parsed.data.confidenceLevel,
      cumulativeSpentUsdc: cumSpent,
      dayNumber,
      walletBalance: latestEntry.walletUsdcBalance ?? "unknown",
      tags: parsed.data.tags,
    };
  } catch (err) {
    logger.warn("Reflection generation failed (non-fatal)", err);
    return null;
  }
}
