import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ethers } from "ethers";

const MESSAGE_EXPIRY_MS = 5 * 60 * 1000;

const GITHUB_OWNER = "thanhphuc85";
const GITHUB_REPO = "ArcDCA";
const LEDGER_PATH = "data/ledger.json";

interface LedgerUser {
  address: string;
  usdcBalance: string;
  dcaRatePerDay?: string;
  dcaRateIsCustom?: boolean;
  dcaPaused?: boolean;
  lastActivity: string;
  [k: string]: unknown;
}

interface Ledger {
  version: number;
  users: Record<string, LedgerUser>;
  [k: string]: unknown;
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

async function writeLedgerToGitHub(token: string, ledger: Ledger, sha: string, message: string): Promise<void> {
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
}

function parseRateMessage(msg: string): { rate: string; address: string; timestamp: number } | null {
  const lines = msg.split("\n");
  if (!lines[0]?.startsWith("Aura DCA Agent")) return null;
  const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const rate = get("Rate: ");
  const address = get("Address: ");
  const ts = get("Timestamp: ");
  if (rate === undefined || !address || !ts) return null;
  return { rate, address, timestamp: parseInt(ts, 10) };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const { message, signature } = (req.body ?? {}) as { message?: string; signature?: string };
  if (!message || !signature) { res.status(400).json({ error: "Missing message or signature" }); return; }

  const parsed = parseRateMessage(message);
  if (!parsed) { res.status(400).json({ error: "Invalid message format" }); return; }
  const { rate, address, timestamp } = parsed;

  if (Math.abs(Date.now() - timestamp) > MESSAGE_EXPIRY_MS) {
    res.status(400).json({ error: "Message expired. Please try again." }); return;
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    res.status(401).json({ error: "Invalid signature" }); return;
  }
  if (recovered !== address.toLowerCase()) {
    res.status(401).json({ error: "Signature does not match address" }); return;
  }

  const rateNum = parseFloat(rate);
  // No upper cap — users can set any rate (0 = pause). Only guard against
  // non-finite/negative values to keep the ledger arithmetic safe.
  if (!Number.isFinite(rateNum) || rateNum < 0) { res.status(400).json({ error: "Rate must be a finite number ≥ 0" }); return; }

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

  user.dcaRatePerDay = rateNum.toFixed(6);
  user.dcaRateIsCustom = true;
  user.dcaPaused = rateNum === 0; // rate 0 = paused
  user.lastActivity = new Date().toISOString();

  try {
    await writeLedgerToGitHub(githubToken, ledger, sha, `chore: set DCA rate ${rateNum}/day for ${key.slice(-6)}`);
  } catch (err) {
    console.error("Ledger commit failed:", err);
    res.status(500).json({ error: "Failed to save rate: " + (err instanceof Error ? err.message : String(err)) }); return;
  }

  res.status(200).json({ success: true, address: key, dcaRatePerDay: user.dcaRatePerDay, paused: user.dcaPaused });
}
