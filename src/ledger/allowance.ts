import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { Ledger } from "../types.js";
import { withRetry } from "../retry.js";
import { USDC_DECIMALS } from "./constants.js";

const MAX_CATCHUP_DAYS = 2;

/**
 * Non-custodial (allowance) model helpers — Cách B / Grok style.
 *
 * Instead of depositing USDC into a pooled treasury, a user keeps their USDC in
 * their own wallet and grants the agent an ERC-20 allowance (approve). Each run
 * the agent pulls only the scheduled amount via transferFrom. The user can
 * revoke anytime (approve 0). This module holds the READ-ONLY on-chain lookups;
 * the pull (transferFrom) uses Circle's contract execution and lives in the
 * execution layer.
 */

const ALLOWANCE_SELECTOR = "0xdd62ed3e"; // allowance(address owner, address spender)
const BALANCE_SELECTOR = "0x70a08231"; // balanceOf(address)

function pad(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<bigint> {
  const result = await withRetry(
    async () => {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
      const json = (await r.json()) as { error?: { message: string }; result: string };
      if (json.error) throw new Error(`RPC error: ${json.error.message}`);
      return json.result;
    },
    { maxRetries: 2, label: "eth_call" },
  );
  return BigInt(result || "0x0");
}

export interface OnChainUserState {
  allowanceUsdc: number; // how much the agent may pull
  balanceUsdc: number; // the user's own wallet USDC balance
  spendableUsdc: number; // min(allowance, balance) — the real ceiling per run
}

/**
 * Read a user's USDC allowance to the agent + their wallet balance. The agent can
 * only ever pull min(allowance, balance).
 */
export async function readUserOnChainState(
  rpcUrl: string,
  usdcContract: string,
  user: string,
  agentSpender: string,
): Promise<OnChainUserState> {
  const allowanceData = ALLOWANCE_SELECTOR + pad(user) + pad(agentSpender);
  const balanceData = BALANCE_SELECTOR + pad(user);

  const [allowanceRaw, balanceRaw] = await Promise.all([
    ethCall(rpcUrl, usdcContract, allowanceData),
    ethCall(rpcUrl, usdcContract, balanceData),
  ]);

  const allowanceUsdc = Number(allowanceRaw) / 10 ** USDC_DECIMALS;
  const balanceUsdc = Number(balanceRaw) / 10 ** USDC_DECIMALS;
  return {
    allowanceUsdc,
    balanceUsdc,
    spendableUsdc: Math.min(allowanceUsdc, balanceUsdc),
  };
}

export interface AllowanceSpend {
  user: string;
  amount: number;
  allowanceUsdc: number;
  balanceUsdc: number;
}

/**
 * Allowance-mode schedule: for each active user, the amount to pull this run =
 * rate × elapsed, capped by their on-chain spendable (min of allowance and wallet
 * balance). Nothing is pooled — this reads live on-chain state per user.
 */
export async function computeAllowanceSpends(
  ledger: Ledger,
  rpcUrl: string,
  usdcContract: string,
  agentAddress: string,
  nowIso: string,
): Promise<{ spends: AllowanceSpend[]; totalUsdc: number }> {
  const now = new Date(nowIso).getTime();
  const spends: AllowanceSpend[] = [];
  let total = 0;

  for (const user of Object.values(ledger.users)) {
    if (user.dcaPaused) continue;
    const rate = Number.parseFloat(user.dcaRatePerDay ?? "0");
    if (!(rate > 0)) continue;

    const lastMs = new Date(user.lastChargedAt ?? user.firstSeen).getTime();
    let elapsedDays = (now - lastMs) / (24 * 3600 * 1000);
    if (!(elapsedDays > 0)) continue;
    elapsedDays = Math.min(elapsedDays, MAX_CATCHUP_DAYS);

    const onchain = await readUserOnChainState(rpcUrl, usdcContract, user.address, agentAddress);
    const intended = rate * elapsedDays;
    const amount = Number.parseFloat(Math.min(intended, onchain.spendableUsdc).toFixed(USDC_DECIMALS));
    if (amount > 0) {
      spends.push({ user: user.address, amount, allowanceUsdc: onchain.allowanceUsdc, balanceUsdc: onchain.balanceUsdc });
      total += amount;
    }
  }

  return { spends, totalUsdc: Number.parseFloat(total.toFixed(USDC_DECIMALS)) };
}

function toBaseUnits(amountUsdc: string, decimals: number): string {
  const [whole, frac = ""] = amountUsdc.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")).toString();
}

// Circle's create*Transaction calls are async — they return an id in state
// INITIATED with no on-chain hash. Wait for the real hash so a fund movement is
// only treated as done once it has actually settled; waitForTxHash rejects if
// the transaction hits a terminal failure state (reverted/denied/cancelled),
// which propagates to the caller so it never books an unconfirmed transfer.
type WalletsClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>;
async function waitForOnchainHash(client: WalletsClient, txId: string, timeoutMs = 60000): Promise<string | undefined> {
  const res = await client.getTransaction({ id: txId, waitForTxHash: true, signal: AbortSignal.timeout(timeoutMs) });
  return res.data?.transaction?.txHash;
}

/**
 * Pull USDC from a user's wallet into the agent wallet via ERC-20 transferFrom,
 * using the allowance the user granted. Executed by the agent's Circle wallet
 * (the approved spender) through contract execution.
 */
export async function pullUsdcFromUser(params: {
  apiKey: string;
  entitySecret: string;
  walletId: string;
  usdcContract: string;
  agentAddress: string;
  user: string;
  amountUsdc: string;
}): Promise<{ txId?: string; txHash?: string }> {
  const client = initiateDeveloperControlledWalletsClient({ apiKey: params.apiKey, entitySecret: params.entitySecret });
  const base = toBaseUnits(params.amountUsdc, USDC_DECIMALS);
  const res = await client.createContractExecutionTransaction({
    walletId: params.walletId,
    contractAddress: params.usdcContract,
    abiFunctionSignature: "transferFrom(address,address,uint256)",
    abiParameters: [params.user, params.agentAddress, base],
    fee: { type: "level", config: { feeLevel: "HIGH" } },
  });
  const txId = res.data?.id;
  if (!txId) throw new Error("Circle did not return a transaction id for the pull");
  // Confirm on-chain before the caller books this pull; rejects if it reverts.
  const txHash = await waitForOnchainHash(client, txId);
  return { txId, txHash };
}

/**
 * Send a token (e.g. the freshly-swapped cirBTC) from the agent wallet back to a
 * user's own wallet.
 */
export async function sendTokenToUser(params: {
  apiKey: string;
  entitySecret: string;
  walletId: string;
  tokenContract: string;
  user: string;
  amount: string;
}): Promise<{ txId?: string; txHash?: string }> {
  const client = initiateDeveloperControlledWalletsClient({ apiKey: params.apiKey, entitySecret: params.entitySecret });
  const walletRes = await client.getWallet({ id: params.walletId });
  const walletAddress = walletRes.data?.wallet?.address;
  if (!walletAddress) throw new Error("Could not resolve agent wallet address");
  const res = await client.createTransaction({
    walletAddress,
    blockchain: "ARC-TESTNET",
    tokenAddress: params.tokenContract,
    destinationAddress: params.user,
    amount: [params.amount],
    fee: { type: "level", config: { feeLevel: "HIGH" } },
  });
  const txId = res.data?.id;
  if (!txId) throw new Error("Circle did not return a transaction id for the send-back");
  // Confirm on-chain before the caller credits the user; rejects if it reverts.
  const txHash = await waitForOnchainHash(client, txId);
  return { txId, txHash };
}
