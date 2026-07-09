import type { Ledger, DistributionRecord } from "../types.js";
import { USDC_DECIMALS, CIRBTC_DECIMALS } from "./constants.js";
import { logger } from "../logger.js";

export function distributeSwap(
  ledger: Ledger,
  usdcSwapped: string,
  cirBtcReceived: string,
  runTimestamp: string,
): DistributionRecord | null {
  const totalSwapped = parseFloat(usdcSwapped);
  const totalReceived = parseFloat(cirBtcReceived);
  if (totalSwapped <= 0 || totalReceived <= 0) return null;

  const eligible = Object.values(ledger.users).filter((u) => parseFloat(u.usdcBalance) > 0);
  if (eligible.length === 0) {
    logger.warn("No users with USDC balance to distribute to");
    return null;
  }

  const totalPoolUsdc = eligible.reduce((sum, u) => sum + parseFloat(u.usdcBalance), 0);
  if (totalPoolUsdc <= 0) return null;

  const allocations: DistributionRecord["allocations"] = [];
  let sumUsdcAllocated = 0;
  let sumCirBtcAllocated = 0;

  for (const user of eligible) {
    const fraction = parseFloat(user.usdcBalance) / totalPoolUsdc;
    const usdcShare = parseFloat((fraction * totalSwapped).toFixed(USDC_DECIMALS));
    const cirBtcShare = parseFloat((fraction * totalReceived).toFixed(CIRBTC_DECIMALS));

    allocations.push({
      address: user.address,
      usdcShare: usdcShare.toFixed(USDC_DECIMALS),
      cirBtcShare: cirBtcShare.toFixed(CIRBTC_DECIMALS),
      poolFraction: fraction.toFixed(8),
    });

    sumUsdcAllocated += usdcShare;
    sumCirBtcAllocated += cirBtcShare;
  }

  // Assign remainder dust to largest holder
  const usdcRemainder = totalSwapped - sumUsdcAllocated;
  const cirBtcRemainder = totalReceived - sumCirBtcAllocated;
  if ((usdcRemainder > 0 || cirBtcRemainder > 0) && allocations.length > 0) {
    const largest = allocations.reduce((max, a) =>
      parseFloat(a.poolFraction) > parseFloat(max.poolFraction) ? a : max,
    );
    if (usdcRemainder > 0) {
      largest.usdcShare = (parseFloat(largest.usdcShare) + usdcRemainder).toFixed(USDC_DECIMALS);
    }
    if (cirBtcRemainder > 0) {
      largest.cirBtcShare = (parseFloat(largest.cirBtcShare) + cirBtcRemainder).toFixed(CIRBTC_DECIMALS);
    }
  }

  // Apply to user balances
  for (const alloc of allocations) {
    const user = ledger.users[alloc.address];
    if (!user) continue;
    user.usdcBalance = Math.max(0, parseFloat(user.usdcBalance) - parseFloat(alloc.usdcShare)).toFixed(USDC_DECIMALS);
    user.cirBtcBalance = (parseFloat(user.cirBtcBalance) + parseFloat(alloc.cirBtcShare)).toFixed(CIRBTC_DECIMALS);
    user.totalSwapped = (parseFloat(user.totalSwapped) + parseFloat(alloc.usdcShare)).toFixed(USDC_DECIMALS);
    user.lastActivity = runTimestamp;
  }

  const record: DistributionRecord = {
    runTimestamp,
    totalUsdcSwapped: usdcSwapped,
    totalCirBtcReceived: cirBtcReceived,
    allocations,
    timestamp: new Date().toISOString(),
  };
  ledger.distributions.push(record);

  logger.info(`Distributed ${usdcSwapped} USDC / ${cirBtcReceived} cirBTC to ${allocations.length} user(s)`);
  return record;
}
