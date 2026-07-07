// One-off setup helper: requests testnet USDC from Circle's faucet for the
// WALLET_ID / wallet address configured in .env, on Arc Testnet.
//
// Usage: node scripts/fund-wallet.mjs

import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const walletId = process.env.WALLET_ID;

if (!apiKey || !entitySecret || !walletId) {
  console.error("Missing CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, or WALLET_ID environment variable.");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const walletResponse = await client.getWallet({ id: walletId });
const address = walletResponse.data?.wallet?.address;
if (!address) {
  throw new Error(`Could not resolve address for wallet id ${walletId}`);
}

console.log(`Requesting testnet USDC for ${address} on Arc Testnet...`);

const response = await client.requestTestnetTokens({
  address,
  blockchain: "ARC-TESTNET",
  usdc: true,
});

console.log(`Faucet request status: ${response.status}`);
console.log("It may take a minute for the balance to show up. Check https://testnet.arcscan.app for the address.");
