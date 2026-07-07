// One-off setup helper: creates the Circle Developer-Controlled Wallet on Arc
// Testnet that the daily bot (src/) signs with, and prints its id + address.
// Put the printed WALLET_ID in your .env / GitHub secrets, and fund the
// printed address from faucet.circle.com before running the bot.
//
// Usage (reads from .env, or pass inline):
//   npm run create-wallet
//   CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... node scripts/create-arc-wallet.mjs
//
// CIRCLE_API_KEY: from https://console.circle.com/api-keys
// CIRCLE_ENTITY_SECRET: the hex secret you generated + registered in the
//   Circle Console when you set up Developer-Controlled Wallets. If you
//   haven't generated one yet, run:
//     node -e "console.log(require('@circle-fin/developer-controlled-wallets').generateEntitySecret())"
//   then register it via the Circle Console UI (or registerEntitySecretCiphertext)
//   before running this script.

import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  console.error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET environment variable.");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const walletSetResponse = await client.createWalletSet({
  name: `arcdca-${new Date().toISOString().slice(0, 10)}`,
});
const walletSetId = walletSetResponse.data?.walletSet?.id;
if (!walletSetId) {
  throw new Error("Failed to create wallet set: no id returned");
}

const walletsResponse = await client.createWallets({
  blockchains: ["ARC-TESTNET"],
  count: 1,
  walletSetId,
});

const wallet = walletsResponse.data?.wallets?.[0];
if (!wallet) {
  throw new Error("Failed to create wallet: no wallet returned");
}

console.log(`Wallet Set ID: ${walletSetId}`);
console.log(`Wallet ID:     ${wallet.id}`);
console.log(`Wallet Address: ${wallet.address}`);
console.log(`\nGo to https://faucet.circle.com, select Arc Testnet, and fund ${wallet.address}`);
