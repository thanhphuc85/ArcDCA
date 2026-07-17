// One-off proof that the swap execution path is alive TODAY.
//
// Why this exists: history.json shows 0/24 successful runs because Arc Testnet's
// USDC→cirBTC liquidity has been out for 9+ straight days. That makes the agent
// look broken when the pipeline is actually fine — only the cirBTC *pair* is dead
// (check-routes proves USDC→EURC still quotes). This script executes ONE real
// swap on a live pair so there's a current, verifiable tx to point at.
//
// It deliberately does NOT touch data/ledger.json or data/history.json and does
// NOT change TOKEN_OUT — the agent's cirBTC thesis stays exactly as it is. This
// is a proof artifact, not a strategy change.
//
// Usage:
//   npm run prove-swap                 # dry run — quotes only, spends nothing
//   npm run prove-swap -- --execute    # REAL swap of the default 0.50 USDC
//   npm run prove-swap -- --execute 1.5 EURC

import "dotenv/config";
import { SwapKit } from "@circle-fin/swap-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const EXPLORER = "https://testnet.arcscan.app";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const positional = args.filter((a) => !a.startsWith("--"));
const amountIn = positional[0] ?? "0.50";
const tokenOut = positional[1] ?? "EURC";

const apiKey = process.env.CIRCLE_API_KEY?.trim();
const entitySecret = process.env.CIRCLE_ENTITY_SECRET?.trim();
const walletId = (process.env.CIRCLE_WALLET_ID || process.env.WALLET_ID)?.trim();
const kitKey = process.env.KIT_KEY?.trim();

const missing = [
  ["CIRCLE_API_KEY", apiKey],
  ["CIRCLE_ENTITY_SECRET", entitySecret],
  ["WALLET_ID / CIRCLE_WALLET_ID", walletId],
  ["KIT_KEY", kitKey],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}. Fill them in .env first.`);
  process.exit(1);
}

const amountNum = Number.parseFloat(amountIn);
if (!Number.isFinite(amountNum) || amountNum <= 0) {
  console.error(`Invalid amount: ${amountIn}`);
  process.exit(1);
}
// Small swaps get eaten by fees (0.10 USDC quoted ~19% worse than spot), which
// looks awful in a demo. Guard against a proof that proves the wrong thing.
if (amountNum < 0.25) {
  console.error(`Amount ${amountIn} USDC is too small — fees dominate at that size. Use ≥ 0.25.`);
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const walletRes = await client.getWallet({ id: walletId });
const address = walletRes.data?.wallet?.address;
if (!address) {
  console.error("Could not resolve the agent wallet address from CIRCLE_WALLET_ID.");
  process.exit(1);
}

const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });
const kit = new SwapKit();
const swapArgs = {
  from: { adapter, chain: "Arc_Testnet", address },
  tokenIn: "USDC",
  tokenOut,
  amountIn,
  config: { kitKey },
};

console.log(`\n${"─".repeat(58)}`);
console.log(`  Pipeline proof — USDC → ${tokenOut} on Arc Testnet`);
console.log(`${"─".repeat(58)}`);
console.log(`  wallet : ${address}`);
console.log(`  amount : ${amountIn} USDC`);
console.log(`  mode   : ${execute ? "⚠️  REAL SWAP (spends testnet USDC)" : "dry run (quote only, spends nothing)"}`);
console.log(`${"─".repeat(58)}\n`);

// Always quote first, so a dead route fails before we move anything.
let quote;
try {
  quote = await kit.estimate(swapArgs);
  const out = quote?.estimatedOutput;
  console.log(`Quote OK${out ? `: ≈ ${out.amount} ${out.token}` : ""}`);
} catch (err) {
  console.error(`\n❌ Quote failed — route is not available:\n   ${(err?.message ?? String(err)).slice(0, 200)}`);
  console.error(`\nRun \`npm run check-routes\` to see which pairs are live.`);
  process.exit(1);
}

if (!execute) {
  console.log(`\nDry run only — nothing was swapped.`);
  console.log(`To execute the real proof swap:\n\n   npm run prove-swap -- --execute ${amountIn} ${tokenOut}\n`);
  process.exit(0);
}

console.log(`\nExecuting the real swap…`);
try {
  const result = await kit.swap(swapArgs);
  const txHash = result?.txHash;
  const url = result?.explorerUrl ?? (txHash ? `${EXPLORER}/tx/${txHash}` : null);
  console.log(`\n✅ Swap executed.`);
  console.log(`   received : ${result?.amountOut ?? "?"} ${tokenOut}`);
  console.log(`   tx       : ${txHash ?? "(no hash returned)"}`);
  if (url) console.log(`   explorer : ${url}`);
  console.log(`\nThis tx proves the execution path (Circle wallet → Swap Kit → Arc Testnet)`);
  console.log(`is live right now. cirBTC remains unavailable at the liquidity layer.\n`);
} catch (err) {
  console.error(`\n❌ Swap failed: ${(err?.message ?? String(err)).slice(0, 300)}\n`);
  process.exit(1);
}
