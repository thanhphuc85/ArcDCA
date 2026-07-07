import "dotenv/config";
import { z } from "zod";
import type { GuardrailConfig } from "./types.js";

export const ARC_TESTNET_NAME = "Arc_Testnet";
export const ARC_TESTNET_EXPLORER = "https://testnet.arcscan.app";

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal string");
// Empty-string env vars (e.g. "FOO=" in .env or an unset GitHub Actions
// variable) must be treated as unset, not coerced/validated as a real value.
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  CIRCLE_API_KEY: z.string().min(1, "CIRCLE_API_KEY is required"),
  CIRCLE_ENTITY_SECRET: z.string().min(1, "CIRCLE_ENTITY_SECRET is required"),
  WALLET_ID: z.string().min(1, "WALLET_ID is required"),
  KIT_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  // zod's .default() only fills in for `undefined`, NOT for "" — an unset
  // GitHub Actions variable arrives as an empty string, so preprocess "" to
  // undefined first or the default never applies and validation fails.
  MAX_DAILY_USDC: z.preprocess(emptyToUndefined, decimalString.default("1.00")),
  MIN_USDC_RESERVE: z.preprocess(emptyToUndefined, decimalString.default("0.50")),
  MIN_SWAP_USDC: z.preprocess(emptyToUndefined, decimalString.default("0.10")),
  CAMPAIGN_TOTAL_BUDGET_USDC: z.preprocess(emptyToUndefined, decimalString.optional()),
  CAMPAIGN_DURATION_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  TOKEN_OUT: z.preprocess(emptyToUndefined, z.string().default("cirBTC")),
  DRY_RUN: z
    .preprocess(emptyToUndefined, z.string().default("true"))
    .transform((v) => v.toLowerCase() === "true"),
});

export interface AppConfig {
  circleApiKey: string;
  circleEntitySecret: string;
  walletId: string;
  kitKey?: string;
  anthropicApiKey: string;
  tokenOut: string;
  dryRun: boolean;
  guardrails: GuardrailConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;

  if (!env.DRY_RUN && !env.KIT_KEY) {
    throw new ConfigError("KIT_KEY is required when DRY_RUN is not true (real swaps need a Circle Swap Kit key)");
  }

  return {
    circleApiKey: env.CIRCLE_API_KEY,
    circleEntitySecret: env.CIRCLE_ENTITY_SECRET,
    walletId: env.WALLET_ID,
    kitKey: env.KIT_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    tokenOut: env.TOKEN_OUT,
    dryRun: env.DRY_RUN,
    guardrails: {
      maxDailyUsdc: env.MAX_DAILY_USDC,
      minUsdcReserve: env.MIN_USDC_RESERVE,
      minSwapUsdc: env.MIN_SWAP_USDC,
      campaignTotalBudgetUsdc: env.CAMPAIGN_TOTAL_BUDGET_USDC,
      campaignDurationDays: env.CAMPAIGN_DURATION_DAYS,
    },
  };
}
