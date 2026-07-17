// Probe which USDC → X swap routes actually have liquidity on Arc Testnet.
//
// The cirBTC route has been returning "No route available" for weeks. Swap Kit's
// estimate() quotes a swap WITHOUT executing it, so this asks the router which
// pairs are live — cheaply, with no funds at risk. If another token quotes fine,
// the agent can DCA into that instead by setting TOKEN_OUT (no code change).
//
// Usage:  npm run check-routes            (probes with 0.10 USDC)
//         npm run check-routes -- 1.5     (probe a different size)

import "dotenv/config";
import { SwapKit } from "@circle-fin/swap-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

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

const amountIn = process.argv[2] ?? "0.10";
// Every token symbol Swap Kit's registry knows (see TokenSymbolRegistry in
// @circle-fin/adapter-circle-wallets). Most are other-chain assets — probing all
// of them tells us exactly which ones Arc Testnet actually wires up, rather than
// guessing. "not supported on Arc Testnet by SDK" = not mapped for this chain;
// "No route available" = mapped but no liquidity.
const CANDIDATES = [
  "cirBTC", "EURC", "USDT", "DAI", "USDE", "PYUSD",
  "WBTC", "WETH", "WSOL", "WAVAX", "WPOL",
  "ETH", "POL", "NATIVE",
];

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const walletRes = await client.getWallet({ id: walletId });
const address = walletRes.data?.wallet?.address;
if (!address) {
  console.error("Could not resolve the agent wallet address from CIRCLE_WALLET_ID.");
  process.exit(1);
}

const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });
const kit = new SwapKit();

console.log(`\nProbing USDC → X routes on Arc_Testnet`);
console.log(`wallet: ${address}`);
console.log(`amountIn: ${amountIn} USDC\n`);

const live = [];      // quotes fine → tradeable today
const noRoute = [];   // known on Arc, but no liquidity
const unmapped = [];  // SDK doesn't wire this symbol on Arc at all

for (const tokenOut of CANDIDATES) {
  try {
    const quote = await kit.estimate({
      from: { adapter, chain: "Arc_Testnet", address },
      tokenIn: "USDC",
      tokenOut,
      amountIn,
      config: { kitKey },
    });
    const out = quote?.estimatedOutput;
    console.log(`✅ USDC → ${tokenOut.padEnd(7)} quote OK` + (out ? `  ≈ ${out.amount} ${out.token}` : ""));
    live.push(tokenOut);
  } catch (err) {
    const raw = (err?.message ?? String(err)).replace(/\s+/g, " ");
    if (/not supported on Arc Testnet/i.test(raw)) unmapped.push(tokenOut);
    else if (/no route|route or resource not found/i.test(raw)) noRoute.push(tokenOut);
    console.log(`❌ USDC → ${tokenOut.padEnd(7)} ${raw.slice(0, 100)}`);
  }
}

console.log("\n" + "─".repeat(60));
console.log(`Tradeable now      : ${live.length ? live.join(", ") : "(none)"}`);
console.log(`On Arc, no liquidity: ${noRoute.length ? noRoute.join(", ") : "(none)"}`);
console.log(`Not on Arc at all  : ${unmapped.length ? unmapped.join(", ") : "(none)"}`);
console.log("─".repeat(60));

const volatile = live.filter((t) => !["EURC", "USDT", "DAI", "USDE", "PYUSD"].includes(t));
if (live.includes("cirBTC")) {
  console.log("\ncirBTC is quoting again — the outage is over. No config change needed.");
} else if (volatile.length) {
  console.log(`\nA volatile asset is tradeable: ${volatile.join(", ")} → real DCA target. Set TOKEN_OUT=${volatile[0]}`);
} else if (live.length) {
  console.log(`\nOnly stablecoin routes are live (${live.join(", ")}).`);
  console.log("Those are FX pairs, not a meaningful DCA target — cirBTC is still the only");
  console.log("volatile asset on Arc Testnet, and its liquidity is down.");
} else {
  console.log("\nNothing quotes at all — the outage isn't cirBTC-specific.");
}
console.log("");
