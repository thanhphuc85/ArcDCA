import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ethers } from "ethers";

const MESSAGE_EXPIRY_MS = 5 * 60 * 1000;

const GITHUB_OWNER = "thanhphuc85";
const GITHUB_REPO = "AuraDCA";
const LEDGER_PATH = "data/ledger.json";

// Tokens the agent can DCA into on Arc Testnet (mirrors SUPPORTED_DCA_TOKENS in
// src/ledger/constants.ts — kept inline so this serverless function stays
// self-contained). A signed TokenOut must be one of these or the request is
// rejected, so a client can never persist an unswappable target.
const SUPPORTED_DCA_TOKENS = ["cirBTC", "EURC"] as const;

interface LedgerUser {
  address: string;
  usdcBalance: string;
  dcaRatePerDay?: string;
  dcaRateIsCustom?: boolean;
  dcaPaused?: boolean;
  dcaMode?: "auto" | "manual" | "smart";
  dcaRunsPerDay?: 1 | 2 | 3;
  dcaFrequency?: "daily" | "hours" | "days" | "weekly";
  dcaEveryHours?: number;
  dcaEveryDays?: number;
  dcaWeekdays?: number[];
  dcaAmountPerRun?: string;
  dcaDailyCapUsdc?: string;
  dcaWeeklyCapUsdc?: string;
  dcaSmartMinDipPct?: number;
  dcaSmartFearBelow?: number;
  dcaTokenOut?: string;
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

interface SchedulePayload {
  freq?: "daily" | "hours" | "days" | "weekly";
  everyHours?: number;
  everyDays?: number;
  weekdays?: number[];
  amountPerRun?: string;
  dailyCap?: string;
  weeklyCap?: string;
  smartDip?: number;
  smartFear?: number;
}

function parseRateMessage(msg: string): { rate: string; mode?: string; runs?: string; token?: string; schedule?: SchedulePayload; address: string; timestamp: number } | null {
  const lines = msg.split("\n");
  if (!lines[0]?.startsWith("Aura DCA Agent")) return null;
  const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const rate = get("Rate: ");
  const address = get("Address: ");
  const ts = get("Timestamp: ");
  // Optional fields (backward-compatible with signatures from earlier versions).
  const mode = get("Mode: ");
  const runs = get("Runs: ");
  const token = get("TokenOut: "); // which token to DCA into; absent = keep current
  // Rich schedule carried as one compact JSON line, e.g.
  //   Schedule: {"freq":"hours","everyHours":6,"amountPerRun":"1.000000",...}
  let schedule: SchedulePayload | undefined;
  const scheduleRaw = get("Schedule: ");
  if (scheduleRaw) { try { schedule = JSON.parse(scheduleRaw) as SchedulePayload; } catch { schedule = undefined; } }
  if (rate === undefined || !address || !ts) return null;
  return { rate, mode, runs, token, schedule, address, timestamp: parseInt(ts, 10) };
}

function num(v: unknown): number | undefined { const n = Number.parseFloat(String(v)); return Number.isFinite(n) ? n : undefined; }
function usdc(v: unknown): string | undefined { const n = num(v); return n != null && n >= 0 ? n.toFixed(6) : undefined; }

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
  const { rate, mode, runs, token, schedule, address, timestamp } = parsed;
  const dcaMode: "auto" | "manual" | "smart" = mode === "manual" ? "manual" : mode === "smart" ? "smart" : "auto";
  // Token is optional (absent = keep the user's current choice). When present it
  // must be one the network can actually swap into, or we reject rather than
  // persist an unswappable target that would fail every run.
  if (token !== undefined && !SUPPORTED_DCA_TOKENS.includes(token as (typeof SUPPORTED_DCA_TOKENS)[number])) {
    res.status(400).json({ error: `Unsupported token "${token}". Choose one of: ${SUPPORTED_DCA_TOKENS.join(", ")}.` }); return;
  }
  // runs is optional; clamp to 1/2/3 if provided, else undefined (keep prior).
  const parsedRuns = runs ? Number.parseInt(runs, 10) : NaN;
  const dcaRunsPerDay: 1 | 2 | 3 | undefined =
    parsedRuns === 1 || parsedRuns === 2 || parsedRuns === 3 ? (parsedRuns as 1 | 2 | 3) : undefined;

  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MESSAGE_EXPIRY_MS) {
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
  const now = new Date().toISOString();
  // Non-custodial: users don't deposit, so create the account on first rate-set.
  let user = ledger.users[key];
  if (!user) {
    user = {
      address: key,
      usdcBalance: "0",
      cirBtcBalance: "0",
      totalDeposited: "0",
      totalSwapped: "0",
      totalWithdrawnCirBtc: "0",
      totalWithdrawnUsdc: "0",
      firstSeen: now,
      lastActivity: now,
    } as LedgerUser;
    ledger.users[key] = user;
  }

  user.dcaRatePerDay = rateNum.toFixed(6);
  user.dcaRateIsCustom = true;
  user.dcaPaused = rateNum === 0; // rate 0 = paused
  user.dcaMode = dcaMode;
  if (dcaRunsPerDay) user.dcaRunsPerDay = dcaRunsPerDay;
  if (token !== undefined) user.dcaTokenOut = token; // validated against SUPPORTED_DCA_TOKENS above
  user.lastActivity = now;

  // Rich schedule: when provided, persist the full cadence + caps + smart
  // conditions. Setting dcaFrequency switches the scheduler onto the new model.
  if (schedule && typeof schedule === "object") {
    const freq = schedule.freq;
    if (freq === "daily" || freq === "hours" || freq === "days" || freq === "weekly") {
      user.dcaFrequency = freq;
      user.dcaEveryHours = freq === "hours" ? Math.max(1, Math.min(24, Math.floor(num(schedule.everyHours) ?? 24))) : undefined;
      user.dcaEveryDays = freq === "days" ? Math.max(1, Math.floor(num(schedule.everyDays) ?? 1)) : undefined;
      user.dcaWeekdays = freq === "weekly" && Array.isArray(schedule.weekdays)
        ? schedule.weekdays.map((d) => Math.floor(Number(d))).filter((d) => d >= 0 && d <= 6)
        : undefined;
      user.dcaAmountPerRun = usdc(schedule.amountPerRun) ?? user.dcaRatePerDay;
      user.dcaDailyCapUsdc = usdc(schedule.dailyCap);
      user.dcaWeeklyCapUsdc = usdc(schedule.weeklyCap);
      user.dcaSmartMinDipPct = dcaMode === "smart" ? num(schedule.smartDip) : undefined;
      user.dcaSmartFearBelow = dcaMode === "smart" ? num(schedule.smartFear) : undefined;
      // A configured schedule sizes buys by amountPerRun; keep rate for display.
      user.dcaPaused = false;
    }
  }

  try {
    await writeLedgerToGitHub(githubToken, ledger, sha, `chore: set DCA ${dcaMode}${user.dcaFrequency ? " " + user.dcaFrequency : ""} for ${key.slice(-6)}`);
  } catch (err) {
    console.error("Ledger commit failed:", err);
    res.status(500).json({ error: "Failed to save rate: " + (err instanceof Error ? err.message : String(err)) }); return;
  }

  res.status(200).json({ success: true, address: key, dcaRatePerDay: user.dcaRatePerDay, paused: user.dcaPaused, mode: dcaMode, frequency: user.dcaFrequency, tokenOut: user.dcaTokenOut ?? "cirBTC" });
}
