import { SwapKit } from "@circle-fin/swap-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { ARC_TESTNET_EXPLORER } from "../config.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";

export type SwapErrorCategory =
  | "no_route"
  | "insufficient_balance"
  | "rate_limited"
  | "auth_error"
  | "network_error"
  | "timeout"
  | "unknown";

export class SwapExecutionError extends Error {
  readonly category: SwapErrorCategory;

  constructor(message: string, category: SwapErrorCategory = "unknown", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SwapExecutionError";
    this.category = category;
  }
}

export interface SwapExecutionResult {
  dryRun: boolean;
  txHash?: string;
  explorerUrl?: string;
  amountOut?: string;
}

export interface SwapParamsInput {
  circleApiKey: string;
  circleEntitySecret: string;
  walletAddress: `0x${string}`;
  kitKey?: string;
  tokenOut: string;
  amountUsdc: string;
  dryRun: boolean;
}

function classifyError(err: unknown): SwapErrorCategory {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("no route") || msg.includes("route not found") || msg.includes("not found")) return "no_route";
  if (msg.includes("insufficient") || msg.includes("not enough") || msg.includes("balance")) return "insufficient_balance";
  if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many")) return "rate_limited";
  if (msg.includes("unauthorized") || msg.includes("403") || msg.includes("401") || msg.includes("invalid api") || msg.includes("invalid key")) return "auth_error";
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("econnaborted")) return "timeout";
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network") || msg.includes("fetch failed") || msg.includes("socket")) return "network_error";
  return "unknown";
}

const RETRYABLE_CATEGORIES = new Set<SwapErrorCategory>(["rate_limited", "network_error", "timeout", "unknown"]);

export async function executeSwap(params: SwapParamsInput): Promise<SwapExecutionResult> {
  if (params.dryRun) {
    return { dryRun: true };
  }

  if (!params.kitKey) {
    throw new SwapExecutionError("KIT_KEY is required to execute a real swap", "auth_error");
  }

  try {
    const adapter = createCircleWalletsAdapter({
      apiKey: params.circleApiKey,
      entitySecret: params.circleEntitySecret,
    });

    const kit = new SwapKit();
    const result = await withRetry(
      () => kit.swap({
        from: { adapter, chain: "Arc_Testnet", address: params.walletAddress },
        tokenIn: "USDC",
        tokenOut: params.tokenOut,
        amountIn: params.amountUsdc,
        config: { kitKey: params.kitKey },
      }),
      {
        maxRetries: 2,
        initialBackoffMs: 2000,
        label: "SwapKit swap",
        shouldRetry: (err) => {
          const cat = classifyError(err);
          const retryable = RETRYABLE_CATEGORIES.has(cat);
          if (!retryable) logger.warn(`Swap error is non-retryable (${cat}), skipping retry`);
          return retryable;
        },
      },
    );

    return {
      dryRun: false,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl ?? (result.txHash ? `${ARC_TESTNET_EXPLORER}/tx/${result.txHash}` : undefined),
      amountOut: result.amountOut,
    };
  } catch (err) {
    const category = classifyError(err);
    const causeMsg = err instanceof Error ? err.message : String(err);
    throw new SwapExecutionError(`Swap failed [${category}]: ${causeMsg}`, category, { cause: err });
  }
}
