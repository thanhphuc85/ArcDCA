import type { AppConfig } from "./config.js";
import { createWallet } from "./wallet.js";
import { readHistory, appendEntry, recentHistory, dayCount, alreadySpentToday, remainingCampaignBudget } from "./history/store.js";
import { readReflections, appendReflection } from "./history/reflectionStore.js";
import { getClaudeDecision, DecisionError } from "./decision/client.js";
import { generateReflection } from "./decision/reflect.js";
import { clampDecision } from "./decision/guardrails.js";
import { executeSwap, SwapExecutionError } from "./swap/swapKit.js";
import type { DecisionContext, HistoryEntry, RunStatus } from "./types.js";
import { logger } from "./logger.js";
import { notifyAll } from "./notify.js";

export interface RunOutcome {
  entry: HistoryEntry;
  isFatal: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return nowIso().slice(0, 10);
}

async function writeAndReturn(
  entry: HistoryEntry,
  isFatal = false,
  discordWebhookUrl?: string,
  reflectionCtx?: { apiKey: string; allHistory: HistoryEntry[] },
): Promise<RunOutcome> {
  await appendEntry(entry);
  await notifyAll(entry, discordWebhookUrl);
  if (reflectionCtx) {
    const updatedHistory = [...reflectionCtx.allHistory, entry];
    const reflection = await generateReflection(
      reflectionCtx.apiKey,
      entry,
      updatedHistory.slice(-8),
      updatedHistory,
    );
    if (reflection) {
      await appendReflection(reflection);
      logger.info(`Reflection saved: ${reflection.insight.slice(0, 80)}…`);
    }
  }
  return { entry, isFatal };
}

export async function runDailyDca(config: AppConfig): Promise<RunOutcome> {
  const date = today();
  const timestamp = nowIso();

  let usdcBalance: string;
  let walletAddress: `0x${string}`;
  try {
    const wallet = await createWallet(config.circleApiKey, config.circleEntitySecret, config.walletId);
    walletAddress = wallet.address;
    usdcBalance = await wallet.getUsdcTokenBalance();
  } catch (err) {
    logger.error("Failed to read wallet USDC balance", err);
    return writeAndReturn({
      date,
      timestamp,
      status: "error_rpc",
      tokenOut: config.tokenOut,
      message: `Circle Wallets balance check failed: ${(err as Error).message}`,
    }, false, config.discordWebhookUrl);
  }

  const history = await readHistory();
  const reflections = await readReflections();
  const refCtx = { apiKey: config.anthropicApiKey, allHistory: history };
  const minReserve = Number.parseFloat(config.guardrails.minUsdcReserve);
  if (Number.parseFloat(usdcBalance) <= minReserve) {
    logger.info(`Balance ${usdcBalance} USDC is at or below reserve ${minReserve} USDC, skipping`);
    return writeAndReturn({
      date,
      timestamp,
      status: "skipped_insufficient_balance",
      tokenOut: config.tokenOut,
      walletUsdcBalance: usdcBalance,
      message: `Wallet balance ${usdcBalance} USDC is at or below the configured minimum reserve ${minReserve} USDC`,
    }, false, config.discordWebhookUrl, refCtx);
  }

  const context: DecisionContext = {
    date,
    dayCount: dayCount(history),
    walletUsdcBalance: usdcBalance,
    guardrails: config.guardrails,
    dcaStrategy: config.dcaStrategy,
    remainingCampaignBudgetUsdc: remainingCampaignBudget(history, config.guardrails.campaignTotalBudgetUsdc),
    alreadySpentTodayUsdc: alreadySpentToday(history, date),
    recentHistory: recentHistory(history).map((e) => ({
      date: e.date,
      status: e.status,
      amountUsdc: e.clampedAmountUsdc,
      reasoningSummary: e.reasoning,
    })),
  };

  let decision;
  try {
    decision = await getClaudeDecision(config.anthropicApiKey, context, {
      history,
      reflections,
      walletUsdcBalance: usdcBalance,
      alreadySpentTodayUsdc: context.alreadySpentTodayUsdc,
      remainingCampaignBudgetUsdc: context.remainingCampaignBudgetUsdc,
      dcaStrategy: config.dcaStrategy,
    });
  } catch (err) {
    const status: RunStatus =
      err instanceof DecisionError && err.kind === "invalid_output" ? "error_llm_invalid_output" : "error_llm_api";
    logger.error("Claude decision call failed", err);
    return writeAndReturn({
      date,
      timestamp,
      status,
      tokenOut: config.tokenOut,
      walletUsdcBalance: usdcBalance,
      message: `Claude decision failed: ${(err as Error).message}`,
    }, false, config.discordWebhookUrl, refCtx);
  }

  const clamped = clampDecision(decision, {
    guardrails: config.guardrails,
    walletUsdcBalance: usdcBalance,
    alreadySpentTodayUsdc: context.alreadySpentTodayUsdc,
    remainingCampaignBudgetUsdc: context.remainingCampaignBudgetUsdc,
  });

  if (!clamped.proceed) {
    const status: RunStatus = clamped.skipReason === "llm_declined" ? "skipped_llm_declined" : "skipped_guardrail_clamped";
    logger.info(`Not proceeding: ${clamped.skipReason} (bound by ${clamped.boundBy})`);
    return writeAndReturn({
      date,
      timestamp,
      status,
      requestedAmountUsdc: decision.amountUsdc,
      clampedAmountUsdc: "0",
      boundBy: clamped.boundBy,
      tokenOut: config.tokenOut,
      reasoning: decision.reasoning,
      walletUsdcBalance: usdcBalance,
      message: `Skipped: ${clamped.skipReason}`,
    }, false, config.discordWebhookUrl, refCtx);
  }

  try {
    const swapResult = await executeSwap({
      circleApiKey: config.circleApiKey,
      circleEntitySecret: config.circleEntitySecret,
      walletAddress,
      kitKey: config.kitKey,
      tokenOut: config.tokenOut,
      amountUsdc: clamped.amountUsdc,
      dryRun: config.dryRun,
    });

    logger.info(swapResult.dryRun ? "Dry run: swap skipped" : `Swap executed: ${swapResult.txHash}`);

    return writeAndReturn({
      date,
      timestamp,
      status: swapResult.dryRun ? "dry_run" : "success",
      requestedAmountUsdc: decision.amountUsdc,
      clampedAmountUsdc: clamped.amountUsdc,
      boundBy: clamped.boundBy,
      tokenOut: config.tokenOut,
      reasoning: decision.reasoning,
      txHash: swapResult.txHash,
      explorerUrl: swapResult.explorerUrl,
      amountOut: swapResult.amountOut,
      walletUsdcBalance: usdcBalance,
      message: swapResult.dryRun
        ? `[DRY RUN] Would have swapped ${clamped.amountUsdc} USDC -> ${config.tokenOut}`
        : `Swapped ${clamped.amountUsdc} USDC -> ${config.tokenOut}`,
    }, false, config.discordWebhookUrl, refCtx);
  } catch (err) {
    const category = err instanceof SwapExecutionError ? err.category : "unknown";
    logger.error(`Swap execution failed [${category}]`, err);
    return writeAndReturn({
      date,
      timestamp,
      status: "error_swap_failed",
      requestedAmountUsdc: decision.amountUsdc,
      clampedAmountUsdc: clamped.amountUsdc,
      boundBy: clamped.boundBy,
      tokenOut: config.tokenOut,
      reasoning: decision.reasoning,
      walletUsdcBalance: usdcBalance,
      message: `Swap failed [${category}]: ${(err as Error).message}`,
    }, false, config.discordWebhookUrl, refCtx);
  }
}
