import { SwapKit } from "@circle-fin/swap-kit";
import { ARC_CIRBTC_CONTRACT } from "../ledger/constants.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";

const CHAIN = "Arc_Testnet";

/**
 * Fetch the real cirBTC price in USD from Circle's Swap Kit token-rates service.
 * This is a genuine market price (not implied from our own swap history).
 * Non-fatal: returns null on any failure so the run continues on implied price.
 */
export async function fetchCirBtcPriceUsd(
  kitKey: string,
): Promise<{ priceUsd: number; fetchedAt: number } | null> {
  if (!kitKey) return null;
  try {
    const kit = new SwapKit();
    const { rates } = await withRetry(
      () => kit.getTokenRates({ chain: CHAIN, tokens: ["cirBTC"], kitKey }),
      { maxRetries: 2, label: "SwapKit getTokenRates" },
    );

    const chainRates = rates[CHAIN] ?? {};
    // Prefer the known cirBTC address; fall back to the only returned entry.
    let entry = chainRates[ARC_CIRBTC_CONTRACT.toLowerCase()];
    if (!entry) {
      const values = Object.values(chainRates);
      entry = values[0];
    }
    if (!entry) {
      logger.warn("getTokenRates returned no cirBTC rate");
      return null;
    }

    const priceUsd = parseFloat(entry.priceUSD);
    if (!(priceUsd > 0)) {
      logger.warn(`getTokenRates returned non-positive cirBTC price: ${entry.priceUSD}`);
      return null;
    }
    return { priceUsd, fetchedAt: entry.fetchedAt };
  } catch (err) {
    logger.warn(`Failed to fetch real cirBTC price: ${(err as Error).message}`);
    return null;
  }
}
