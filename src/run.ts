import type { AppConfig } from "./config.js";
import { createWallet } from "./wallet.js";
import { readHistory, appendEntry, recentHistory, dayCount, alreadySpentToday, remainingCampaignBudget, outageStreak } from "./history/store.js";
import { readReflections, appendReflection } from "./history/reflectionStore.js";
import { readLedger, writeLedger, ensureDefaultRates } from "./ledger/store.js";
import { scanDeposits } from "./ledger/scanner.js";
import { computeScheduledSpends, applyScheduledDistribution, groupSpendsByToken, smartSizeMultiplier } from "./ledger/schedule.js";
import { computeAllowanceSpends, pullUsdcFromUser, sendTokenToUser } from "./ledger/allowance.js";
import { requestWithdrawal, processPendingWithdrawals } from "./ledger/withdraw.js";
import { ARC_TESTNET_RPC, ARC_USDC_CONTRACT, ARC_CIRBTC_CONTRACT, dcaTokenInfo } from "./ledger/constants.js";
import { getClaudeDecision } from "./decision/client.js";
import { generateReflection } from "./decision/reflect.js";
import { runMarketAnalyst } from "./decision/analyst.js";
import { fetchAllMarketData } from "./market/external.js";
import { fetchCirBtcPriceUsd } from "./price/priceFeed.js";
import { readPrices, appendPrice } from "./price/priceStore.js";
import { executeSwap, SwapExecutionError } from "./swap/swapKit.js";
import type { DecisionContext, HistoryEntry, Ledger, RunStatus } from "./types.js";
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

/**
 * Emit one run that produced several history entries — one per token group in a
 * multi-token run. Appends and notifies each, then reflects ONCE for the whole
 * run (reflection is an AI call), on the last entry as the representative
 * outcome. Returns that entry as the run's RunOutcome.
 */
async function emitRunEntries(
  entries: HistoryEntry[],
  discordWebhookUrl?: string,
  reflectionCtx?: { apiKey: string; allHistory: HistoryEntry[] },
): Promise<RunOutcome> {
  for (const e of entries) {
    await appendEntry(e);
    await notifyAll(e, discordWebhookUrl);
  }
  const primary = entries[entries.length - 1]!;
  if (reflectionCtx && entries.length > 0) {
    const updatedHistory = [...reflectionCtx.allHistory, ...entries];
    const reflection = await generateReflection(reflectionCtx.apiKey, primary, updatedHistory.slice(-8), updatedHistory);
    if (reflection) {
      await appendReflection(reflection);
      logger.info(`Reflection saved: ${reflection.insight.slice(0, 80)}…`);
    }
  }
  return { entry: primary, isFatal: false };
}

async function saveLedger(ledger: Ledger): Promise<void> {
  try {
    await writeLedger(ledger);
  } catch (err) {
    logger.error("Failed to write ledger", err);
  }
}

export async function runDailyDca(config: AppConfig): Promise<RunOutcome> {
  const date = today();
  const timestamp = nowIso();

  let usdcBalance: string;
  let wallet;
  try {
    wallet = await createWallet(config.circleApiKey, config.circleEntitySecret, config.walletId);
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

  // --- Per-user ledger: scan deposits + process withdrawals ---
  const ledger = await readLedger();

  try {
    await scanDeposits(ledger, wallet.address, ARC_TESTNET_RPC, ARC_USDC_CONTRACT);
  } catch (err) {
    logger.error("Deposit scan failed (non-fatal)", err);
  }

  // Back-fill default rates for accounts that predate per-user DCA.
  const filled = ensureDefaultRates(ledger);
  if (filled > 0) logger.info(`Back-filled default DCA rate for ${filled} pre-existing user(s)`);

  if (config.withdrawalInput) {
    try {
      requestWithdrawal(ledger, config.withdrawalInput.address, config.withdrawalInput.token, config.withdrawalInput.amount);
    } catch (err) {
      logger.error("Withdrawal request failed", err);
    }
  }

  try {
    await processPendingWithdrawals(ledger, wallet);
  } catch (err) {
    logger.error("Withdrawal processing failed (non-fatal)", err);
  }

  await saveLedger(ledger);

  // --- Existing DCA flow ---
  const history = await readHistory();
  const reflections = await readReflections();
  const refCtx = { apiKey: config.anthropicApiKey, allHistory: history };

  // --- Multi-agent: fetch external data + run Market Analyst ---
  logger.info("Fetching external market data…");
  const rawMarketData = await fetchAllMarketData();
  const marketBrief = await runMarketAnalyst(
    config.anthropicApiKey,
    rawMarketData.market,
    rawMarketData.fearGreed,
    rawMarketData.onChainVolume,
  );

  // --- Phase 2: record the REAL cirBTC price and build a persisted series ---
  let cirBtcPriceSnapshots = await readPrices();
  if (config.kitKey) {
    const realPrice = await fetchCirBtcPriceUsd(config.kitKey);
    if (realPrice) {
      const snapshot = {
        date, timestamp,
        priceUsd: realPrice.priceUsd,
        source: "circle_swapkit",
      };
      try {
        await appendPrice(snapshot);
        cirBtcPriceSnapshots = [...cirBtcPriceSnapshots, snapshot];
        logger.info(`Recorded real cirBTC price: $${realPrice.priceUsd.toFixed(2)}`);
      } catch (err) {
        logger.error("Failed to persist cirBTC price (non-fatal)", err);
      }
    }
  }

  const minSwapUsdc = Number.parseFloat(config.guardrails.minSwapUsdc);

  // --- Non-custodial allowance mode (gated by ALLOWANCE_MODE) ---
  // Instead of spending a pooled deposit, pull each user's scheduled amount from
  // their own wallet via transferFrom, swap the sum, and send cirBTC back.
  if (config.allowanceMode) {
    const { spends, totalUsdc } = await computeAllowanceSpends(ledger, ARC_TESTNET_RPC, ARC_USDC_CONTRACT, wallet.address, timestamp);
    logger.info(`Allowance mode: ${spends.length} active user(s), total pull ${totalUsdc} USDC`);

    if (totalUsdc < minSwapUsdc) {
      return writeAndReturn({
        date, timestamp, status: "skipped_guardrail_clamped",
        requestedAmountUsdc: totalUsdc.toFixed(6), clampedAmountUsdc: "0", boundBy: "allowance_below_min",
        tokenOut: config.tokenOut, walletUsdcBalance: usdcBalance,
        message: `Allowance mode: ${spends.length} user(s), total ${totalUsdc.toFixed(6)} < min swap ${minSwapUsdc}`,
      }, false, config.discordWebhookUrl, refCtx);
    }

    if (config.dryRun) {
      return writeAndReturn({
        date, timestamp, status: "dry_run",
        requestedAmountUsdc: totalUsdc.toFixed(6), clampedAmountUsdc: totalUsdc.toFixed(6),
        tokenOut: config.tokenOut, walletUsdcBalance: usdcBalance,
        message: `[DRY RUN] Allowance mode would pull ${totalUsdc.toFixed(6)} USDC from ${spends.length} wallet(s) → swap → send cirBTC back`,
      }, false, config.discordWebhookUrl, refCtx);
    }

    // LIVE: pull each user's amount via transferFrom.
    const pulled: Array<{ user: string; amount: number }> = [];
    for (const s of spends) {
      try {
        await pullUsdcFromUser({
          apiKey: config.circleApiKey, entitySecret: config.circleEntitySecret, walletId: config.walletId,
          usdcContract: ARC_USDC_CONTRACT, agentAddress: wallet.address, user: s.user, amountUsdc: s.amount.toFixed(6),
        });
        pulled.push({ user: s.user, amount: s.amount });
      } catch (err) {
        logger.error(`transferFrom pull failed for ${s.user} (non-fatal)`, err);
      }
    }
    const pulledTotal = pulled.reduce((a, x) => a + x.amount, 0);
    if (pulledTotal < minSwapUsdc) {
      return writeAndReturn({
        date, timestamp, status: "error_swap_failed", tokenOut: config.tokenOut, walletUsdcBalance: usdcBalance,
        message: `Allowance mode: pulled only ${pulledTotal.toFixed(6)} USDC (< min swap ${minSwapUsdc})`,
      }, false, config.discordWebhookUrl, refCtx);
    }

    try {
      const swapResult = await executeSwap({
        circleApiKey: config.circleApiKey, circleEntitySecret: config.circleEntitySecret,
        walletAddress: wallet.address, kitKey: config.kitKey, tokenOut: config.tokenOut,
        amountUsdc: pulledTotal.toFixed(6), dryRun: false,
      });
      if (swapResult.amountOut) {
        const totalOut = Number.parseFloat(swapResult.amountOut);
        for (const p of pulled) {
          const share = ((p.amount / pulledTotal) * totalOut).toFixed(8);
          try {
            // sendTokenToUser now waits for on-chain confirmation and throws if
            // the send-back reverts — so the ledger is credited ONLY after the
            // cirBTC has actually reached the user's wallet, never on a failed or
            // unconfirmed send.
            await sendTokenToUser({
              apiKey: config.circleApiKey, entitySecret: config.circleEntitySecret, walletId: config.walletId,
              tokenContract: ARC_CIRBTC_CONTRACT, user: p.user, amount: share,
            });
            const u = ledger.users[p.user.toLowerCase()];
            if (u) {
              u.cirBtcBalance = (Number.parseFloat(u.cirBtcBalance) + Number.parseFloat(share)).toFixed(8);
              u.totalSwapped = (Number.parseFloat(u.totalSwapped) + p.amount).toFixed(6);
              u.lastChargedAt = timestamp;
              u.lastActivity = timestamp;
            }
          } catch (err) {
            logger.error(`cirBTC send-back failed for ${p.user} (non-fatal); ledger not credited`, err);
          }
        }
        await saveLedger(ledger);
      }
      return writeAndReturn({
        date, timestamp, status: "success",
        requestedAmountUsdc: totalUsdc.toFixed(6), clampedAmountUsdc: pulledTotal.toFixed(6),
        tokenOut: config.tokenOut, txHash: swapResult.txHash, explorerUrl: swapResult.explorerUrl, amountOut: swapResult.amountOut,
        walletUsdcBalance: usdcBalance,
        reasoning: `Allowance mode: pulled ${pulledTotal.toFixed(6)} USDC from ${pulled.length} wallet(s), swapped, sent cirBTC back.`,
        message: `Allowance DCA: pulled + swapped ${pulledTotal.toFixed(6)} USDC across ${pulled.length} user(s)`,
      }, false, config.discordWebhookUrl, refCtx);
    } catch (err) {
      const category = err instanceof SwapExecutionError ? err.category : "unknown";
      logger.error(`Allowance swap failed [${category}]`, err);
      return writeAndReturn({
        date, timestamp, status: "error_swap_failed", clampedAmountUsdc: pulledTotal.toFixed(6),
        tokenOut: config.tokenOut, walletUsdcBalance: usdcBalance,
        message: `Allowance swap failed [${category}]: ${(err as Error).message}`,
      }, false, config.discordWebhookUrl, refCtx);
    }
  }

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

  // --- Cách B: deterministic per-user schedule-driven sizing ---
  // The buy amount is the SUM of each active user's scheduled spend; the agent
  // no longer sizes the buy. Smart-mode users are additionally gated on live
  // market context (cirBTC drawdown from recent high + Fear & Greed).
  const recentPrices = cirBtcPriceSnapshots.slice(-30).map((s) => s.priceUsd).filter((p) => p > 0);
  const priceHigh = recentPrices.length ? Math.max(...recentPrices) : 0;
  const priceNow = recentPrices.length ? recentPrices[recentPrices.length - 1]! : 0;
  const drawdownPct = priceHigh > 0 && priceNow > 0 ? Math.max(0, (priceHigh - priceNow) / priceHigh) : 0;
  const schedule = computeScheduledSpends(ledger, timestamp, {
    drawdownPct,
    fearGreedIndex: marketBrief?.fearGreedIndex ?? null,
  });
  const scheduledTotal = schedule.totalUsdc;
  const available = Number.parseFloat(usdcBalance) - minReserve;
  const minSwap = Number.parseFloat(config.guardrails.minSwapUsdc);
  const executable = Math.max(0, Math.min(scheduledTotal, available));
  const executableStr = executable.toFixed(6);

  if (executable < minSwap) {
    logger.info(`Scheduled spend ${scheduledTotal} USDC (executable ${executable}) below min swap ${minSwap}; skipping`);
    return writeAndReturn({
      date,
      timestamp,
      status: "skipped_guardrail_clamped",
      requestedAmountUsdc: scheduledTotal.toFixed(6),
      clampedAmountUsdc: "0",
      boundBy: scheduledTotal < minSwap ? "scheduled_below_min" : "wallet_available_after_reserve",
      tokenOut: config.tokenOut,
      walletUsdcBalance: usdcBalance,
      message: `No buy this run: ${schedule.spends.length} active user(s), scheduled ${scheduledTotal.toFixed(6)} USDC, executable ${executable.toFixed(6)} < min swap ${minSwap}`,
    }, false, config.discordWebhookUrl, refCtx);
  }

  // Advisory market commentary (non-fatal). Sizing is deterministic; the agent's
  // reasoning is kept only to enrich the dashboard's AI insights + reflections.
  let reasoning = `Rate-based DCA: ${schedule.spends.length} active user(s), executing ${executableStr} USDC this run.`;
  try {
    const outage = outageStreak(history);
    const context: DecisionContext = {
      date,
      dayCount: dayCount(history, date),
      walletUsdcBalance: usdcBalance,
      guardrails: config.guardrails,
      dcaStrategy: config.dcaStrategy,
      remainingCampaignBudgetUsdc: remainingCampaignBudget(history, config.guardrails.campaignTotalBudgetUsdc),
      alreadySpentTodayUsdc: alreadySpentToday(history, date),
      outageConsecutiveRuns: outage.consecutiveRuns,
      outageDurationDays: outage.days,
      recentHistory: recentHistory(history).map((e) => ({
        date: e.date,
        status: e.status,
        amountUsdc: e.clampedAmountUsdc,
        reasoningSummary: e.reasoning,
      })),
    };
    const commentary = await getClaudeDecision(config.anthropicApiKey, context, {
      history,
      reflections,
      walletUsdcBalance: usdcBalance,
      alreadySpentTodayUsdc: context.alreadySpentTodayUsdc,
      remainingCampaignBudgetUsdc: context.remainingCampaignBudgetUsdc,
      dcaStrategy: config.dcaStrategy,
      marketBrief,
      cirBtcPriceSnapshots,
    });
    if (commentary?.reasoning) reasoning = commentary.reasoning;
  } catch (err) {
    logger.warn(`Advisory commentary failed (non-fatal): ${(err as Error).message}`);
  }

  // --- Multi-token settlement: one pooled swap per token group ---
  // Each user DCAs into their chosen token (default config.tokenOut). Group the
  // run by token, size each group by its share of the wallet-clamped executable
  // total, and settle ONE USDC -> token swap per group. A failed or sub-minimum
  // group never blocks the others. Guardrails stay global: `scale` carries the
  // wallet-reserve clamp across every group uniformly.
  const scale = scheduledTotal > 0 ? executable / scheduledTotal : 0;
  const groups = groupSpendsByToken(schedule.spends);
  const tokens = [...groups.keys()].sort(); // deterministic settlement order
  const entries: HistoryEntry[] = [];

  // The market snapshot that drove smart-mode sizing this run, and the base
  // (sensitivity 1) multiplier it produced — recorded on any group that had a
  // smart participant, as the on-chain audit of the agent's dynamic sizing.
  const smartFg = marketBrief?.fearGreedIndex ?? null;
  const smartBaseMult = smartSizeMultiplier({ drawdownPct, fearGreedIndex: smartFg });

  for (const token of tokens) {
    const info = dcaTokenInfo(token);
    const groupSpends = groups.get(token)!;
    const users = groupSpends.length;
    const groupScheduled = groupSpends.reduce((s, x) => s + x.spend, 0);
    const groupExec = Number.parseFloat((groupScheduled * scale).toFixed(6));
    const boundBy = scale < 1 ? "wallet_available_after_reserve" : "user_schedule";

    if (groupExec < minSwap) {
      entries.push({
        date, timestamp, status: "skipped_guardrail_clamped",
        requestedAmountUsdc: groupScheduled.toFixed(6), clampedAmountUsdc: "0",
        boundBy: "group_below_min_swap", tokenOut: token, reasoning,
        walletUsdcBalance: usdcBalance,
        message: `No buy for ${token}: ${users} user(s), executable ${groupExec.toFixed(6)} USDC < min swap ${minSwap}`,
      });
      continue;
    }

    const groupExecStr = groupExec.toFixed(6);
    const smartSizing = groupSpends.some((s) => s.sizeMultiplier != null)
      ? { fearGreed: smartFg, drawdownPct, multiplier: smartBaseMult }
      : undefined;
    try {
      const swapResult = await executeSwap({
        circleApiKey: config.circleApiKey,
        circleEntitySecret: config.circleEntitySecret,
        walletAddress: wallet.address,
        kitKey: config.kitKey,
        tokenOut: token,
        amountUsdc: groupExecStr,
        dryRun: config.dryRun,
      });
      logger.info(swapResult.dryRun ? `Dry run: ${token} swap skipped` : `Swap executed [${token}]: ${swapResult.txHash}`);
      if (!swapResult.dryRun && swapResult.amountOut) {
        applyScheduledDistribution(ledger, groupSpends, groupExecStr, swapResult.amountOut, timestamp, token, info.decimals);
      }
      entries.push({
        date, timestamp,
        status: swapResult.dryRun ? "dry_run" : "success",
        requestedAmountUsdc: groupScheduled.toFixed(6), clampedAmountUsdc: groupExecStr,
        boundBy, tokenOut: token, reasoning,
        txHash: swapResult.txHash, explorerUrl: swapResult.explorerUrl, amountOut: swapResult.amountOut,
        walletUsdcBalance: usdcBalance,
        message: swapResult.dryRun
          ? `[DRY RUN] Would swap ${groupExecStr} USDC -> ${token} across ${users} user(s)`
          : `Swapped ${groupExecStr} USDC -> ${token} across ${users} user(s)`,
        ...(smartSizing ? { smartSizing } : {}),
      });
    } catch (err) {
      const category = err instanceof SwapExecutionError ? err.category : "unknown";
      logger.error(`Swap execution failed [${token}/${category}]`, err);
      entries.push({
        date, timestamp, status: "error_swap_failed",
        requestedAmountUsdc: groupScheduled.toFixed(6), clampedAmountUsdc: groupExecStr,
        boundBy, tokenOut: token, reasoning,
        walletUsdcBalance: usdcBalance,
        message: `Swap failed [${token}/${category}]: ${(err as Error).message}`,
        ...(smartSizing ? { smartSizing } : {}),
      });
    }
  }

  await saveLedger(ledger);
  return emitRunEntries(entries, config.discordWebhookUrl, refCtx);
}
