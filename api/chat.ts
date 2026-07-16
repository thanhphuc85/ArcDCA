import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";

// Conversational assistant for the Aura DCA dashboard. Claude answers questions
// using read-only tools (treasury, account, trade history) that execute here on
// the server. Sensitive actions (change DCA rate, run a DCA now) are NEVER
// executed here — Claude only *proposes* them, and the frontend renders a
// Confirm button + wallet signature so the user authorizes each one explicitly.

const MODEL = "claude-sonnet-5";
const MAX_TURNS = 6;
const MAX_MESSAGES = 24;
const MAX_MSG_CHARS = 4000;

const LEDGER_SOURCES = [
  "https://cdn.jsdelivr.net/gh/thanhphuc85/ArcDCA@main/data/ledger.json",
  "https://raw.githubusercontent.com/thanhphuc85/ArcDCA/main/data/ledger.json",
];
const HISTORY_SOURCES = [
  "https://cdn.jsdelivr.net/gh/thanhphuc85/ArcDCA@main/data/history.json",
  "https://raw.githubusercontent.com/thanhphuc85/ArcDCA/main/data/history.json",
];

interface LedgerUser {
  address: string;
  usdcBalance?: string;
  cirBtcBalance?: string;
  totalDeposited?: string;
  totalSwapped?: string;
  dcaRatePerDay?: string;
  dcaPaused?: boolean;
  [k: string]: unknown;
}
interface Ledger { users?: Record<string, LedgerUser>; [k: string]: unknown; }
interface HistoryEntry {
  date?: string;
  status?: string;
  requestedAmountUsdc?: string;
  clampedAmountUsdc?: string;
  amountOut?: string;
  boundBy?: string;
  reasoning?: string;
  message?: string;
  txHash?: string;
  [k: string]: unknown;
}

async function fetchJson<T>(sources: string[]): Promise<T | null> {
  for (const url of sources) {
    try {
      const r = await fetch(url, { cache: "no-store" } as RequestInit);
      if (!r.ok) continue;
      return (await r.json()) as T;
    } catch { /* try next */ }
  }
  return null;
}

function num(v: unknown): number { const n = parseFloat(String(v ?? "0")); return Number.isFinite(n) ? n : 0; }

// ---------- read-only tool implementations ----------
async function getTreasuryOverview(): Promise<string> {
  const ledger = await fetchJson<Ledger>(LEDGER_SOURCES);
  const users = ledger?.users ? Object.values(ledger.users) : [];
  let pooledUsdc = 0, pooledCirBtc = 0, activeDca = 0;
  for (const u of users) {
    pooledUsdc += num(u.usdcBalance);
    pooledCirBtc += num(u.cirBtcBalance);
    if (num(u.dcaRatePerDay) > 0 && !u.dcaPaused) activeDca += 1;
  }
  return JSON.stringify({
    totalUsers: users.length,
    activeDcaUsers: activeDca,
    pooledUsdcBalance: pooledUsdc.toFixed(6),
    pooledCirBtcBalance: pooledCirBtc.toFixed(8),
    network: "Arc Testnet",
    note: "Balances are pooled across all users. cirBTC and USDC are testnet assets with no real value.",
  }, null, 2);
}

async function getMyAccount(address?: string): Promise<string> {
  if (!address) return JSON.stringify({ error: "No wallet connected. Ask the user to connect their wallet to see their own account." });
  const ledger = await fetchJson<Ledger>(LEDGER_SOURCES);
  const key = address.toLowerCase();
  const u = ledger?.users?.[key];
  if (!u) {
    return JSON.stringify({ address: key, exists: false, note: "This wallet has no account yet — it appears after the first DCA-rate set or deposit." });
  }
  return JSON.stringify({
    address: key,
    usdcBalance: num(u.usdcBalance).toFixed(6),
    cirBtcBalance: num(u.cirBtcBalance).toFixed(8),
    dcaRatePerDay: num(u.dcaRatePerDay).toFixed(6),
    dcaPaused: !!u.dcaPaused,
    totalSwapped: num(u.totalSwapped).toFixed(6),
    totalDeposited: num(u.totalDeposited).toFixed(6),
  }, null, 2);
}

async function getRecentTrades(limit: number): Promise<string> {
  const history = await fetchJson<HistoryEntry[]>(HISTORY_SOURCES);
  if (!Array.isArray(history) || !history.length) return JSON.stringify({ trades: [], note: "No runs recorded yet." });
  const n = Math.min(Math.max(1, limit || 5), 20);
  const trades = history.slice(-n).reverse().map((e) => ({
    date: e.date,
    status: e.status,
    requestedUsdc: e.requestedAmountUsdc ?? null,
    executedUsdc: e.clampedAmountUsdc ?? null,
    cirBtcOut: e.amountOut ?? null,
    boundBy: e.boundBy ?? null,
    reasoning: e.reasoning || e.message || null,
    txHash: e.txHash ?? null,
  }));
  return JSON.stringify({ trades }, null, 2);
}

// ---------- tool schemas ----------
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_treasury_overview",
    description: "Get the pooled treasury state: total users, active DCA users, pooled USDC and cirBTC balances on Arc Testnet. Use for questions about how much is in the treasury overall.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_account",
    description: "Get the connected user's own account: their USDC/cirBTC balance, current DCA rate per day, whether DCA is paused, and totals. Use for questions like 'what is my balance' or 'what is my current rate'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_recent_trades",
    description: "Get the most recent DCA runs with date, status, requested vs executed USDC, cirBTC received, what bound the amount, the agent's reasoning, and tx hash. Use to explain past trades (e.g. 'explain yesterday's trade').",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "How many recent runs to return (1-20, default 5)." } } },
  },
  {
    name: "propose_set_dca_rate",
    description: "PROPOSE changing the user's daily DCA rate and/or execution mode. This does NOT apply the change — it asks the frontend to show a Confirm button the user must click and sign with their wallet. Use when the user asks to change/increase/decrease/pause their DCA rate, or switch between Auto and Manual modes. Rate is in USDC per day; 0 means pause. Mode: 'auto' = agent runs on schedule (3× / day); 'manual' = agent skips the user in scheduled runs, they trigger buys themselves.",
    input_schema: {
      type: "object",
      properties: {
        rate: { type: "number", description: "Proposed DCA rate in USDC per day (>= 0; 0 = pause)." },
        mode: { type: "string", enum: ["auto", "manual"], description: "Execution mode. Optional — omit to keep the user's current mode." },
      },
      required: ["rate"],
    },
  },
  {
    name: "propose_run_dca",
    description: "PROPOSE running a DCA buy now for a given USDC amount. This does NOT execute — it asks the frontend to show a Confirm step. Use when the user asks to buy/run DCA immediately with a specific amount.",
    input_schema: { type: "object", properties: { amountUsdc: { type: "number", description: "USDC amount to spend in this immediate DCA buy (> 0)." } }, required: ["amountUsdc"] },
  },
];

const SYSTEM_PROMPT = `You are the assistant for "Aura DCA Agent", a dashboard for an autonomous agent that dollar-cost-averages USDC into cirBTC on Arc Testnet (a testnet — assets have no real value).

Guidelines:
- Reply in the SAME language the user writes in (Vietnamese or English).
- Be concise and concrete. Use the read-only tools to ground answers in real data instead of guessing.
- For questions about the treasury, a user's balance/rate, or past trades, call the matching tool first.
- NEVER claim a sensitive action (changing the DCA rate, running a DCA now) has been done. You cannot execute those. Instead call the matching propose_* tool; the user then confirms and signs in the UI. After proposing, tell the user to click Confirm below to sign and apply it.
- Only call a propose_* tool when the user has given a concrete number. If they ask to adjust/change their DCA rate WITHOUT specifying an amount, do NOT guess a rate — ask them what daily rate they want (in USDC/day; 0 pauses). It helps to first check their current rate and balance with get_my_account so you can mention their current rate and suggest a sensible range they can choose from.
- If the user is not connected (get_my_account returns no wallet), ask them to connect their wallet for account-specific answers.
- You are not a licensed financial advisor; do not give personalized investment advice. You may explain how the agent works and what the data shows.`;

type Proposal =
  | { action: "set_dca_rate"; rate: number; mode?: "auto" | "manual" }
  | { action: "run_dca"; amountUsdc: number };

function sanitizeMessages(raw: unknown): Anthropic.MessageParam[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Anthropic.MessageParam[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: string }).role;
    const content = (m as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const text = content.slice(0, MAX_MSG_CHARS);
    if (!text.trim()) continue;
    out.push({ role, content: text });
  }
  // Conversation must start with a user turn and end with the latest user turn.
  while (out.length && out[0]?.role !== "user") out.shift();
  const last = out[out.length - 1];
  if (!out.length || !last || last.role !== "user") return null;
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) { res.status(500).json({ error: "Server misconfigured: missing ANTHROPIC_API_KEY" }); return; }

  const body = (req.body ?? {}) as { messages?: unknown; address?: string };
  const messages = sanitizeMessages(body.messages);
  if (!messages) { res.status(400).json({ error: "Invalid messages: need a non-empty list ending in a user turn" }); return; }
  const address = typeof body.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.address) ? body.address : undefined;

  const client = new Anthropic({ apiKey });
  let proposal: Proposal | null = null;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
      });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        const text = response.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("\n").trim();
        res.status(200).json({ reply: text || "…", proposal });
        return;
      }

      messages.push({ role: "assistant", content: response.content as Anthropic.MessageParam["content"] });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let content: string;
        const input = (tu.input ?? {}) as Record<string, unknown>;
        switch (tu.name) {
          case "get_treasury_overview": content = await getTreasuryOverview(); break;
          case "get_my_account": content = await getMyAccount(address); break;
          case "get_recent_trades": content = await getRecentTrades(num(input.limit) || 5); break;
          case "propose_set_dca_rate": {
            const rate = num(input.rate);
            if (rate < 0) { content = JSON.stringify({ error: "Rate must be >= 0." }); break; }
            const mode = input.mode === "manual" ? "manual" : (input.mode === "auto" ? "auto" : undefined);
            proposal = mode ? { action: "set_dca_rate", rate, mode } : { action: "set_dca_rate", rate };
            content = JSON.stringify({ status: "PROPOSAL_PRESENTED", note: "A Confirm button was shown to the user. The rate/mode is NOT changed until they click Confirm and sign. Tell them to confirm below." });
            break;
          }
          case "propose_run_dca": {
            const amountUsdc = num(input.amountUsdc);
            if (!(amountUsdc > 0)) { content = JSON.stringify({ error: "Amount must be > 0." }); break; }
            proposal = { action: "run_dca", amountUsdc };
            content = JSON.stringify({ status: "PROPOSAL_PRESENTED", note: "A Confirm button was shown to the user. Nothing runs until they confirm. Tell them to confirm below." });
            break;
          }
          default: content = JSON.stringify({ error: `Unknown tool: ${tu.name}` });
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content });
      }
      messages.push({ role: "user", content: results });
    }
    res.status(200).json({ reply: "I couldn't finish that request — please try rephrasing.", proposal });
  } catch (err) {
    console.error("chat handler failed:", err);
    res.status(500).json({ error: "Assistant error: " + (err instanceof Error ? err.message : String(err)) });
  }
}
