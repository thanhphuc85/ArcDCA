import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ethers } from "ethers";
import { createRequire } from "node:module";

// The Circle SDK (and its ESM-only Solana deps) breaks when Vercel's esbuild
// bundles it into the function ("Cannot use import statement outside a module").
// Loading it through createRequire keeps it external: @vercel/nft still traces
// and ships it in node_modules, but esbuild does not bundle it, so it loads with
// native Node resolution — the same path that works locally.
const nodeRequire = createRequire(import.meta.url);

const USDC_CONTRACT = "0x3600000000000000000000000000000000000000";
const CIRBTC_CONTRACT = "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf";
const USDC_DECIMALS = 6;
const CIRBTC_DECIMALS = 8;

const LIMITS: Record<string, { min: number; max: number }> = {
  USDC: { min: 0.01, max: 10000 },
  cirBTC: { min: 0.00000001, max: 100 },
};
const RATE_LIMIT_MS = 5 * 60 * 1000;
const MESSAGE_EXPIRY_MS = 5 * 60 * 1000;

const GITHUB_OWNER = "thanhphuc85";
const GITHUB_REPO = "AuraDCA";
const LEDGER_PATH = "data/ledger.json";

interface LedgerUser {
  address: string;
  usdcBalance: string;
  cirBtcBalance: string;
  totalDeposited: string;
  totalSwapped: string;
  totalWithdrawnUsdc: string;
  totalWithdrawnCirBtc: string;
  lastActivity: string;
}

interface WithdrawalRecord {
  id: string;
  address: string;
  token: string;
  amount: string;
  status: string;
  requestedAt: string;
  processedAt?: string;
  txHash?: string;
  error?: string;
}

interface Ledger {
  version: number;
  lastScannedBlock: number;
  users: Record<string, LedgerUser>;
  deposits: unknown[];
  distributions: unknown[];
  withdrawals: WithdrawalRecord[];
}

interface GitHubFileResponse {
  content: string;
  sha: string;
}

async function readLedgerFromGitHub(token: string): Promise<{ ledger: Ledger; sha: string }> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${LEDGER_PATH}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as GitHubFileResponse;
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { ledger: JSON.parse(content) as Ledger, sha: data.sha };
}

// Returns the new file sha so a follow-up write can chain off it without a re-read.
async function writeLedgerToGitHub(token: string, ledger: Ledger, sha: string, message: string): Promise<string> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${LEDGER_PATH}`;
  const content = Buffer.from(JSON.stringify(ledger, null, 2) + "\n").toString("base64");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message, content, sha }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub commit failed: ${res.status} ${errBody}`);
  }
  const data = (await res.json()) as { content?: { sha?: string } };
  return data.content?.sha ?? sha;
}

function parseWithdrawalMessage(msg: string): { token: string; amount: string; address: string; timestamp: number } | null {
  const lines = msg.split("\n");
  if (!lines[0]?.startsWith("Aura DCA Agent")) return null;
  const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const token = get("Token: ");
  const amount = get("Amount: ");
  const address = get("Address: ");
  const ts = get("Timestamp: ");
  if (!token || !amount || !address || !ts) return null;
  return { token, amount, address, timestamp: parseInt(ts, 10) };
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const { message, signature, telegramToken, telegramChatId } = (req.body ?? {}) as {
    message?: string; signature?: string; telegramToken?: string; telegramChatId?: string;
  };
  if (!message || !signature) { res.status(400).json({ error: "Missing message or signature" }); return; }

  const parsed = parseWithdrawalMessage(message);
  if (!parsed) { res.status(400).json({ error: "Invalid message format" }); return; }
  const { token, amount, address, timestamp } = parsed;

  const now = Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MESSAGE_EXPIRY_MS) {
    res.status(400).json({ error: "Message expired. Please try again." }); return;
  }

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    res.status(401).json({ error: "Invalid signature" }); return;
  }
  if (recoveredAddress !== address.toLowerCase()) {
    res.status(401).json({ error: "Signature does not match address" }); return;
  }

  if (token !== "USDC" && token !== "cirBTC") { res.status(400).json({ error: "Invalid token" }); return; }
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
  const limits = LIMITS[token]!;
  if (amountNum < limits.min) { res.status(400).json({ error: `Minimum withdrawal: ${limits.min} ${token}` }); return; }
  if (amountNum > limits.max) { res.status(400).json({ error: `Maximum withdrawal: ${limits.max} ${token}` }); return; }

  const githubToken = process.env.GH_PAT?.trim();
  if (!githubToken) { res.status(500).json({ error: "Server misconfigured: missing GH_PAT" }); return; }

  let ledger: Ledger, sha: string;
  try {
    ({ ledger, sha } = await readLedgerFromGitHub(githubToken));
  } catch (err) {
    console.error("Failed to read ledger:", err);
    res.status(500).json({ error: "Failed to read ledger from GitHub" }); return;
  }

  const key = address.toLowerCase();
  const user = ledger.users[key];
  if (!user) { res.status(404).json({ error: "No account found. Deposit USDC to the agent first." }); return; }

  const balanceField = token === "USDC" ? "usdcBalance" : "cirBtcBalance" as const;
  const balance = parseFloat(user[balanceField]);
  if (amountNum > balance) {
    res.status(400).json({ error: `Insufficient balance: ${balance} ${token} available` }); return;
  }

  const recentWd = ledger.withdrawals
    .filter((w) => w.address === key && w.status !== "failed")
    .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())[0];
  if (recentWd && now - new Date(recentWd.requestedAt).getTime() < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - (now - new Date(recentWd.requestedAt).getTime())) / 1000);
    res.status(429).json({ error: `Rate limited. Try again in ${waitSec}s.` }); return;
  }

  // Trim env values: pasting a full line from a .env file into the Vercel UI can
  // leave a trailing newline/space, which makes Circle reject the API key as
  // "malformed" (it must be the exact TEST_API_KEY:id:secret triplet). Checked
  // BEFORE reserving funds so a misconfig can't debit a balance with no transfer.
  const circleApiKey = process.env.CIRCLE_API_KEY?.trim();
  const circleEntitySecret = process.env.CIRCLE_ENTITY_SECRET?.trim();
  // Accept either name: the GitHub Actions workflow uses WALLET_ID, so allow it
  // as a fallback to avoid an env-var naming mismatch on Vercel.
  const circleWalletId = (process.env.CIRCLE_WALLET_ID || process.env.WALLET_ID)?.trim();
  if (!circleApiKey || !circleEntitySecret || !circleWalletId) {
    res.status(500).json({ error: "Server misconfigured: missing Circle credentials" }); return;
  }

  const decimals = token === "USDC" ? USDC_DECIMALS : CIRBTC_DECIMALS;
  const wdId = `wd-${Date.now()}-${key.slice(-6)}`;
  const withdrawal: WithdrawalRecord = {
    id: wdId, address: key, token, amount, status: "processing", requestedAt: new Date().toISOString(),
  };

  // Reserve funds BEFORE transferring: debit the balance and record the pending
  // withdrawal, then commit with the sha we read. If another request committed
  // first, GitHub rejects our now-stale sha and we abort here WITHOUT moving any
  // money. This optimistic lock is what stops two concurrent withdrawals from
  // both passing the balance check above and double-spending the pooled wallet.
  user[balanceField] = (balance - amountNum).toFixed(decimals);
  user.lastActivity = new Date().toISOString();
  ledger.withdrawals.push(withdrawal);

  let sha2: string;
  try {
    sha2 = await writeLedgerToGitHub(githubToken, ledger, sha, `chore: withdrawal ${wdId} reserved`);
  } catch (err) {
    console.error("Reservation write failed (concurrent request?):", err);
    res.status(409).json({ error: "The ledger was just updated by another request. Please retry in a moment." }); return;
  }

  try {
    const circleSdk = nodeRequire("@circle-fin/developer-controlled-wallets") as typeof import("@circle-fin/developer-controlled-wallets");
    const initiateClient = circleSdk.initiateDeveloperControlledWalletsClient;
    if (typeof initiateClient !== "function") {
      throw new Error("Circle SDK failed to load initiateDeveloperControlledWalletsClient");
    }
    const client = initiateClient({ apiKey: circleApiKey, entitySecret: circleEntitySecret });
    const walletRes = await client.getWallet({ id: circleWalletId });
    const walletAddress = walletRes.data?.wallet?.address;
    if (!walletAddress) throw new Error("Could not get agent wallet address");

    const tokenAddress = token === "USDC" ? USDC_CONTRACT : CIRBTC_CONTRACT;
    const txRes = await client.createTransaction({
      walletAddress,
      blockchain: "ARC-TESTNET",
      tokenAddress,
      destinationAddress: address,
      amount: [amount],
      fee: { type: "level", config: { feeLevel: "HIGH" } },
    });

    withdrawal.status = "completed";
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.txHash = txRes.data?.id;

    if (token === "USDC") {
      user.totalWithdrawnUsdc = (parseFloat(user.totalWithdrawnUsdc || "0") + amountNum).toFixed(USDC_DECIMALS);
    } else {
      user.totalWithdrawnCirBtc = (parseFloat(user.totalWithdrawnCirBtc || "0") + amountNum).toFixed(CIRBTC_DECIMALS);
    }
  } catch (err) {
    // Transfer failed after the reservation committed — refund the balance and
    // record the failure, chaining off the reservation's sha.
    withdrawal.status = "failed";
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.error = err instanceof Error ? err.message : String(err);
    user[balanceField] = (parseFloat(user[balanceField]) + amountNum).toFixed(decimals);

    try { await writeLedgerToGitHub(githubToken, ledger, sha2, `chore: withdrawal ${wdId} failed`); } catch {}

    res.status(500).json({ error: "Transfer failed: " + (err instanceof Error ? err.message : String(err)), withdrawalId: wdId }); return;
  }

  try {
    await writeLedgerToGitHub(githubToken, ledger, sha2, `chore: withdrawal ${wdId} completed`);
  } catch (err) {
    console.error("Ledger commit failed after successful transfer:", err);
  }

  if (telegramToken && telegramChatId) {
    const txLink = withdrawal.txHash ? `\nTx: ${withdrawal.txHash}` : "";
    sendTelegram(telegramToken, telegramChatId,
      `💰 <b>Withdrawal completed!</b>\n${amount} ${token} → <code>${address.slice(0, 8)}…${address.slice(-4)}</code>${txLink}`,
    ).catch(() => {});
  }

  res.status(200).json({
    success: true, withdrawalId: wdId, txHash: withdrawal.txHash, token, amount, status: "completed",
  });
}
