import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { DecisionContext, ClaudeDecision, HistoryEntry, Reflection } from "../types.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";
import {
  ANALYSIS_TOOLS,
  DECISION_TOOL,
  RECALL_REFLECTIONS_TOOL,
  computePacingMetrics,
  buildDetailedHistory,
  previewAllocation,
  retrieveReflections,
} from "./tools.js";

export class DecisionError extends Error {
  readonly kind: "api" | "invalid_output";

  constructor(message: string, kind: "api" | "invalid_output", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DecisionError";
    this.kind = kind;
  }
}

const decisionSchema = z.object({
  proceed: z.boolean(),
  amountUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/, "must be a decimal string with up to 6 decimal places"),
  reasoning: z.string().min(1),
});

const MODEL = "claude-sonnet-5";
const MAX_TURNS = 6;

export interface DecisionDeps {
  history: HistoryEntry[];
  reflections: Reflection[];
  walletUsdcBalance: string;
  alreadySpentTodayUsdc: string;
  remainingCampaignBudgetUsdc?: string;
}

function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: DecisionContext,
  deps: DecisionDeps,
): string {
  switch (toolName) {
    case "analyze_spending_pace":
      return JSON.stringify(
        computePacingMetrics(
          deps.history,
          context.guardrails.campaignTotalBudgetUsdc,
          context.guardrails.campaignDurationDays,
        ),
        null,
        2,
      );

    case "review_history":
      return JSON.stringify(
        buildDetailedHistory(deps.history, (toolInput.limit as number) ?? 10),
        null,
        2,
      );

    case "compute_allocation":
      return JSON.stringify(
        previewAllocation(
          toolInput.proposedAmountUsdc as string,
          deps.walletUsdcBalance,
          context.guardrails.minUsdcReserve,
          context.guardrails.maxDailyUsdc,
          context.guardrails.minSwapUsdc,
          deps.alreadySpentTodayUsdc,
          deps.remainingCampaignBudgetUsdc,
        ),
        null,
        2,
      );

    case "recall_reflections":
      return JSON.stringify(
        retrieveReflections(
          deps.reflections,
          (toolInput.tags as string[]) ?? [],
          (toolInput.limit as number) ?? 5,
        ),
        null,
        2,
      );

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

export async function getClaudeDecision(
  apiKey: string,
  context: DecisionContext,
  deps: DecisionDeps,
): Promise<ClaudeDecision> {
  const client = new Anthropic({ apiKey });
  const allTools = [RECALL_REFLECTIONS_TOOL, ...ANALYSIS_TOOLS, DECISION_TOOL];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildUserPrompt(context) },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await withRetry(
      () =>
        client.messages.create({
          model: MODEL,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages,
          tools: allTools as Anthropic.Tool[],
          ...(turn >= MAX_TURNS - 1
            ? { tool_choice: { type: "tool" as const, name: DECISION_TOOL.name } }
            : {}),
        }),
      {
        maxRetries: 3,
        label: "Claude API",
        shouldRetry: (err) => !(err instanceof DecisionError && err.kind === "invalid_output"),
      },
    );

    const toolUseBlocks = response.content.filter(
      (block) => block.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      throw new DecisionError("Claude response contained no tool calls", "invalid_output");
    }

    for (const block of toolUseBlocks) {
      if (block.type !== "tool_use") continue;
      if (block.name === DECISION_TOOL.name) {
        const parsed = decisionSchema.safeParse(block.input);
        if (!parsed.success) {
          throw new DecisionError(
            `Claude decision output failed validation: ${parsed.error.message}`,
            "invalid_output",
          );
        }
        logger.info(`Claude decision reached after ${turn + 1} turn(s)`);
        return parsed.data;
      }
    }

    messages.push({ role: "assistant", content: response.content as Anthropic.MessageParam["content"] });

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks
      .filter((block) => block.type === "tool_use")
      .map((block) => {
        const tu = block as Anthropic.ToolUseBlock;
        logger.info(`Claude called tool: ${tu.name}`);
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: handleToolCall(tu.name, tu.input as Record<string, unknown>, context, deps),
        };
      });

    messages.push({ role: "user", content: toolResults });
  }

  throw new DecisionError(`Claude did not produce a decision within ${MAX_TURNS} turns`, "invalid_output");
}
