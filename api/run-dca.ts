import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ethers } from "ethers";
import { createRequire } from "node:module";

// On-demand DCA: a user signs "Run DCA" for a USDC amount, and the agent wallet
// swaps that much of the user's pooled USDC balance into cirBTC via Circle's
// Swap Kit right now (instead of waiting for the scheduled cron run). Mirrors
// api/withdraw.ts: same ledger read/write, EIP-191 signature check, and the
// createRequire trick that keeps the ESM-only Circle SDKs out of esbuild's bundle.
const nodeRequire = createRequire(import.meta.url);

const USDC_DECIMALS = 6;
const CIRBTC_DECIMALS = 8;
const MIN_USDC = 0.01;
const MAX_USDC = 10000;
const RATE_LIMIT_MS = 60 * 1000;
const MESSAGE_EXPIRY_MS = 5 * 60 * 1000;

const GITHUB_OWNER = "thanhphuc85";
const GITHUB_REPO = "ArcDCA";
const LEDGER_PATH = "data/ledger.json";

interface LedgerUser {
  address: string;
  usdcBalance: string;
  cirBtcBalance: string;
  totalSwapped?: string;
  lastActivity?: string;
  lastRunNowAt?: string;
  [k: string]: unknown;
}
interface Ledger { version: number; users: Record<string, LedgerUser>; [k: string]: unknown; }
interface GitHubFileResponse { content: string; sha: string; }

async function readLedgerFromGitHub(token: string): Promise<{ ledger: Ledger; sha: string }> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${LEDGER_PATH}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as GitHubFileResponse;
  return { ledger: JSON.parse(Buffer.from(data.content, "base64").toString("utf-8")) as Ledger, sha: data.sha };
}

async function writeLedgerToGitHub(token: string, ledger: Ledger, sha: string, message: string): Promise<void> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${LEDGER_PATH}`;
  const content = Buffer.from(JSON.stringify(ledger, null, 2) + "\n").toString("base64");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message, content, sha }),
  });
  if (!res.ok) throw new Error(`GitHub commit failed: ${res.status} ${await res.text()}`);
}

function parseRunMessage(msg: string): { amount: string; address: string; timestamp: number } | null {
  const lines = msg.split("\n");
  if (!lines[0]?.startsWith("Aura DCA Agent")) return null;
  const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const amount = get("Amount: ");
  const address = get("Address: ");
  const ts = get("Timestamp: ");
  if (!amount || !address || !ts) return null;
  return { amount, address, timestamp: parseInt(ts, 10) };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const { message, signature } = (req.body ?? {}) as { message?: string; signature?: string };
  if (!message || !signature) { res.status(400).json({ error: "Missing message or signature" }); return; }

  const parsed = parseRunMessage(message);
  if (!parsed) { res.status(400).json({ error: "Invalid message format" }); return; }
  const { amount, address, timestamp } = parsed;

  if (Math.abs(Date.now() - timestamp) > MESSAGE_EXPIRY_MS) { res.status(400).json({ error: "Message expired. Please try again." }); return; }

  let recovered: string;
  try { recovered = ethers.verifyMessage(message, signature).toLowerCase(); }
  catch { res.status(401).json({ error: "Invalid signature" }); return; }
  if (recovered !== address.toLowerCase()) { res.status(401).json({ error: "Signature does not match address" }); return; }

  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum < MIN_USDC) { res.status(400).json({ error: `Minimum is ${MIN_USDC} USDC` }); return; }
  if (amountNum > MAX_USDC) { res.status(400).json({ error: `Maximum is ${MAX_USDC} USDC` }); return; }

  const githubToken = process.env.GH_PAT?.trim();
  if (!githubToken) { res.status(500).json({ error: "Server misconfigured: missing GH_PAT" }); return; }

  const circleApiKey = process.env.CIRCLE_API_KEY?.trim();
  const circleEntitySecret = process.env.CIRCLE_ENTITY_SECRET?.trim();
  const circleWalletId = (process.env.CIRCLE_WALLET_ID || process.env.WALLET_ID)?.trim();
  const kitKey = process.env.KIT_KEY?.trim();
  if (!circleApiKey || !circleEntitySecret || !circleWalletId) { res.status(500).json({ error: "Server misconfigured: missing Circle credentials" }); return; }
  if (!kitKey) { res.status(500).json({ error: "Server misconfigured: missing KIT_KEY (needed to swap)" }); return; }

  let ledger: Ledger, sha: string;
  try { ({ ledger, sha } = await readLedgerFromGitHub(githubToken)); }
  catch (err) { console.error("Failed to read ledger:", err); res.status(500).json({ error: "Failed to read ledger from GitHub" }); return; }

  const key = address.toLowerCase();
  const user = ledger.users[key];
  if (!user) { res.status(404).json({ error: "No account found. Deposit USDC to the agent first." }); return; }

  // Simple rate limit to prevent double-submits.
  if (user.lastRunNowAt && Date.now() - new Date(user.lastRunNowAt).getTime() < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - (Date.now() - new Date(user.lastRunNowAt).getTime())) / 1000);
    res.status(429).json({ error: `Rate limited. Try again in ${waitSec}s.` }); return;
  }

  const balance = parseFloat(user.usdcBalance || "0");
  if (amountNum > balance) { res.status(400).json({ error: `Insufficient balance: ${balance.toFixed(USDC_DECIMALS)} USDC available` }); return; }

  // Reserve the funds up-front; refund on failure so a failed swap never loses balance.
  user.usdcBalance = (balance - amountNum).toFixed(USDC_DECIMALS);
  user.lastRunNowAt = new Date().toISOString();

  let txHash: string | undefined, amountOut: string | undefined;
  try {
    const walletsSdk = nodeRequire("@circle-fin/developer-controlled-wallets") as typeof import("@circle-fin/developer-controlled-wallets");
    const client = walletsSdk.initiateDeveloperControlledWalletsClient({ apiKey: circleApiKey, entitySecret: circleEntitySecret });
    const walletRes = await client.getWallet({ id: circleWalletId });
    const walletAddress = walletRes.data?.wallet?.address;
    if (!walletAddress) throw new Error("Could not resolve agent wallet address");

    // Swap Kit and its adapter are ESM-only (they pull in ESM-only deps like
    // rpc-websockets); createRequire() would blow up with "require() of ES
    // Module ... not supported". Dynamic import() works with both CJS and ESM
    // and is Vercel's supported way to load ESM from a Node function.
    const adapterMod = await import("@circle-fin/adapter-circle-wallets");
    const swapMod = await import("@circle-fin/swap-kit");
    const adapter = adapterMod.createCircleWalletsAdapter({ apiKey: circleApiKey, entitySecret: circleEntitySecret });
    const kit = new swapMod.SwapKit();
    const result = await kit.swap({
      from: { adapter, chain: "Arc_Testnet", address: walletAddress as `0x${string}` },
      tokenIn: "USDC",
      tokenOut: "cirBTC",
      amountIn: amount,
      config: { kitKey },
    });
    txHash = result.txHash;
    amountOut = result.amountOut;
  } catch (err) {
    // Refund the reserved USDC.
    user.usdcBalance = (parseFloat(user.usdcBalance) + amountNum).toFixed(USDC_DECIMALS);
    try { await writeLedgerToGitHub(githubToken, ledger, sha, `chore: run-dca refund for ${key.slice(-6)}`); } catch {}
    const raw = err instanceof Error ? err.message : String(err);
    const noRoute = /no route|route not found|not found/i.test(raw);
    console.error("run-dca swap failed:", raw);
    res.status(502).json({ error: noRoute
      ? "Swap route unavailable on Arc Testnet right now (USDC → cirBTC has no liquidity route). Your balance was not touched. Try again later."
      : "Swap failed: " + raw });
    return;
  }

  // Credit the swapped cirBTC to the user.
  const outNum = parseFloat(amountOut || "0");
  if (outNum > 0) user.cirBtcBalance = (parseFloat(user.cirBtcBalance || "0") + outNum).toFixed(CIRBTC_DECIMALS);
  user.totalSwapped = (parseFloat(user.totalSwapped || "0") + amountNum).toFixed(USDC_DECIMALS);
  user.lastActivity = new Date().toISOString();

  try { await writeLedgerToGitHub(githubToken, ledger, sha, `chore: run-dca ${amount} USDC for ${key.slice(-6)}`); }
  catch (err) { console.error("Ledger commit failed after successful swap:", err); }

  res.status(200).json({ success: true, amountUsdc: amount, cirBtcOut: amountOut ?? null, txHash: txHash ?? null });
}
