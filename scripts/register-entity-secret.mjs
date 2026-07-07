// One-off setup helper: registers CIRCLE_ENTITY_SECRET (from .env) with
// Circle so it can be used by create-arc-wallet.mjs / the bot. Only needs to
// run once per entity secret. Downloads a recovery file -- store it somewhere
// safe, it's needed if you ever lose the entity secret.
//
// Usage: node scripts/register-entity-secret.mjs

import "dotenv/config";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  console.error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET environment variable.");
  process.exit(1);
}

const response = await registerEntitySecretCiphertext({ apiKey, entitySecret });
console.log("Entity secret registered.");
console.log(`Recovery file saved at: ${response.data?.recoveryFile ?? "(no path returned, check response)"}`);
