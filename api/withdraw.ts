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
const EURC_DECIMALS = 6;
// EURC's ERC-20 address on Arc Testnet isn't hardcoded — set EURC_CONTRACT in the
// environment once it's verified. Withdrawing EURC is rejected until it is, rather
// than risk sending to an unverified address.
const EURC_CONTRACT = process.env.EURC_CONTRACT?.trim();

interface TokenSpec { contract: string | undefined; decimals: number; min: number; max: number }
const TOKENS: Record<string, TokenSpec> = {
  USDC: { contract: USDC_CONTRACT, decimals: USDC_DECIMALS, min: 0.01, max: 10000 },
  cirBTC: { contract: CIRBTC_CONTRACT, decimals: CIRBTC_DECIMALS, min: 0.00000001, max: 100 },
  EURC: { contract: EURC_CONTRACT, decimals: EURC_DECIMALS, min: 0.01, max: 10000 },
};

// A user's balance for a token: USDC/cirBTC keep dedicated fields; anything else
// lives in tokenBalances[symbol]. read/write go through these so every token path
// (reserve, refund, credit) stays consistent.
function getTokenBalance(user: LedgerUser, token: string): number {
  if (token === "USDC") return parseFloat(user.usdcBalance || "0");
  if (token === "cirBTC") return parseFloat(user.cirBtcBalance || "0");
  return parseFloat((user.tokenBalances && user.tokenBalances[token]) || "0");
}
function setTokenBalance(user: LedgerUser, token: string, value: number, decimals: number): void {
  const v = Math.max(0, value).toFixed(decimals);
  if (token === "USDC") user.usdcBalance = v;
  else if (token === "cirBTC") user.cirBtcBalance = v;
  else { user.tokenBalances = user.tokenBalances || {}; user.tokenBalances[token] = v; }
}
const RATE_LIMIT_MS = 5 * 60 * 1000;
const MESSAGE_EXPIRY_MS = 5 * 60 * 1000;

const GITHUB_OWNER = "thanhphuc85";
const GITHUB_REPO = "AuraDCA";
const LEDGER_PATH = "data/ledger.json";

interface LedgerUser {
  address: string;
  usdcBalance: string;
  cirBtcBalance: string;
  tokenBalances?: Record<string, string>; // per-token holdings for non-cirBTC DCA targets
  totalDeposited: string;
  totalSwapped: string;
  totalWithdrawnUsdc: string;
  totalWithdrawnCirBtc: string;
  totalWithdrawn?: Record<string, string>; // cumulative withdrawn per token (generic)
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
  txHash?: string;        // the REAL on-chain hash (0x…), once confirmed
  circleTxId?: string;    // Circle's internal transaction id (a UUID), for support
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

  const spec = TOKENS[token];
  if (!spec) { res.status(400).json({ error: "Invalid token" }); return; }
  if (!spec.contract) { res.status(400).json({ error: `${token} withdrawals are not configured yet (contract address pending).` }); return; }
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
  if (amountNum < spec.min) { res.status(400).json({ error: `Minimum withdrawal: ${spec.min} ${token}` }); return; }
  if (amountNum > spec.max) { res.status(400).json({ error: `Maximum withdrawal: ${spec.max} ${token}` }); return; }

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

  const decimals = spec.decimals;
  const balance = getTokenBalance(user, token);
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

  const wdId = `wd-${Date.now()}-${key.slice(-6)}`;
  const withdrawal: WithdrawalRecord = {
    id: wdId, address: key, token, amount, status: "processing", requestedAt: new Date().toISOString(),
  };

  // Reserve funds BEFORE transferring: debit the balance and record the pending
  // withdrawal, then commit with the sha we read. If another request committed
  // first, GitHub rejects our now-stale sha and we abort here WITHOUT moving any
  // money. This optimistic lock is what stops two concurrent withdrawals from
  // both passing the balance check above and double-spending the pooled wallet.
  setTokenBalance(user, token, balance - amountNum, decimals);
  user.lastActivity = new Date().toISOString();
  ledger.withdrawals.push(withdrawal);

  let sha2: string;
  try {
    sha2 = await writeLedgerToGitHub(githubToken, ledger, sha, `chore: withdrawal ${wdId} reserved`);
  } catch (err) {
    console.error("Reservation write failed (concurrent request?):", err);
    res.status(409).json({ error: "The ledger was just updated by another request. Please retry in a moment." }); return;
  }

  let txId: string | undefined;
  let pending = false;
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

    const tokenAddress = spec.contract; // guaranteed defined by the contract gate above
    const txRes = await client.createTransaction({
      walletAddress,
      blockchain: "ARC-TESTNET",
      tokenAddress,
      destinationAddress: address,
      amount: [amount],
      fee: { type: "level", config: { feeLevel: "HIGH" } },
    });
    txId = txRes.data?.id;
    if (!txId) throw new Error("Circle did not return a transaction id");

    // createTransaction is async: it returns a Circle id in state INITIATED with
    // no on-chain hash yet. Wait for the REAL txHash so we store a working
    // explorer link (not the internal UUID) and so an on-chain failure surfaces
    // instead of a false "completed". waitForTxHash rejects on a terminal failure
    // state; the AbortSignal caps the wait inside the 30s function budget. A
    // timeout is NOT a failure — the transfer is already submitted, so we leave
    // it pending rather than refund (refunding a slow-but-valid transfer would
    // double-credit the user).
    try {
      const confirmed = await client.getTransaction({ id: txId, waitForTxHash: true, signal: AbortSignal.timeout(22000) });
      withdrawal.txHash = confirmed.data?.transaction?.txHash;
    } catch (waitErr) {
      const nm = (waitErr as { name?: string } | undefined)?.name;
      if (nm === "TimeoutError" || nm === "AbortError") pending = true;
      else throw waitErr; // terminal on-chain failure → outer catch refunds
    }

    withdrawal.status = pending ? "processing" : "completed";
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.circleTxId = txId;
    if (!pending) {
      if (token === "USDC") {
        user.totalWithdrawnUsdc = (parseFloat(user.totalWithdrawnUsdc || "0") + amountNum).toFixed(USDC_DECIMALS);
      } else if (token === "cirBTC") {
        user.totalWithdrawnCirBtc = (parseFloat(user.totalWithdrawnCirBtc || "0") + amountNum).toFixed(CIRBTC_DECIMALS);
      } else {
        user.totalWithdrawn = user.totalWithdrawn || {};
        user.totalWithdrawn[token] = (parseFloat(user.totalWithdrawn[token] || "0") + amountNum).toFixed(decimals);
      }
    }
  } catch (err) {
    // Reached only when funds did NOT settle: createTransaction failed, or Circle
    // reported a terminal on-chain failure (reverted/denied/cancelled). Refund is
    // safe here — a mere timeout is handled as pending above, never as failure.
    withdrawal.status = "failed";
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.error = err instanceof Error ? err.message : String(err);
    if (txId) withdrawal.circleTxId = txId;
    setTokenBalance(user, token, getTokenBalance(user, token) + amountNum, decimals);

    try { await writeLedgerToGitHub(githubToken, ledger, sha2, `chore: withdrawal ${wdId} failed`); } catch {}

    res.status(500).json({ error: "Transfer failed: " + (err instanceof Error ? err.message : String(err)), withdrawalId: wdId }); return;
  }

  try {
    await writeLedgerToGitHub(githubToken, ledger, sha2, `chore: withdrawal ${wdId} ${pending ? "submitted" : "completed"}`);
  } catch (err) {
    console.error("Ledger commit failed after successful transfer:", err);
  }

  if (telegramToken && telegramChatId) {
    const txLink = withdrawal.txHash ? `\nTx: ${withdrawal.txHash}` : "";
    const head = pending ? "⏳ <b>Withdrawal submitted</b> (confirming on-chain)" : "💰 <b>Withdrawal completed!</b>";
    sendTelegram(telegramToken, telegramChatId,
      `${head}\n${amount} ${token} → <code>${address.slice(0, 8)}…${address.slice(-4)}</code>${txLink}`,
    ).catch(() => {});
  }

  res.status(200).json({
    success: true, withdrawalId: wdId, txHash: withdrawal.txHash, circleTxId: txId, token, amount, status: withdrawal.status, pending,
  });
}
