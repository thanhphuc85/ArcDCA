import type { VercelRequest, VercelResponse } from "@vercel/node";

// Sends a real welcome email to the user's inbox via Resend when they sign up
// with email on the dashboard. Requires RESEND_API_KEY (from resend.com).
// RESEND_FROM is optional — defaults to Resend's shared onboarding sender, which
// only delivers to your own account email until you verify a domain in Resend.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort in-memory rate limit (per warm serverless instance; not shared
// across instances, so it only blunts naive floods — not a security boundary).
// This endpoint sends mail to any address with no auth, so cap it tightly to
// limit its usefulness as a spam relay.
const _rlHits = new Map<string, number[]>();
function rateLimited(req: VercelRequest, limit: number, windowMs: number): boolean {
  const xff = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const recent = (_rlHits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) { _rlHits.set(ip, recent); return true; }
  recent.push(now); _rlHits.set(ip, recent);
  if (_rlHits.size > 5000) { for (const [k, v] of _rlHits) { if (v.every((t) => now - t >= windowMs)) _rlHits.delete(k); } }
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (rateLimited(req, 3, 60_000)) { res.status(429).json({ error: "Too many requests. Please try again later." }); return; }

  const { email, name, address } = (req.body ?? {}) as { email?: string; name?: string; address?: string };
  if (!email || !EMAIL_RE.test(email)) { res.status(400).json({ error: "Valid email required" }); return; }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) { res.status(500).json({ error: "Server misconfigured: missing RESEND_API_KEY" }); return; }
  const from = process.env.RESEND_FROM?.trim() || "Aura DCA Agent <onboarding@resend.dev>";

  const safeName = (name || "there").replace(/[<>]/g, "").slice(0, 60);
  const addr = (address || "").replace(/[^0-9a-fA-Fx…]/g, "").slice(0, 66);

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1f36;">
      <h2 style="margin:0 0 8px;">Welcome to Aura DCA Agent 👋</h2>
      <p>Hi ${safeName}, your account is ready. The agent will dollar-cost-average USDC → cirBTC on Arc Testnet for you.</p>
      ${addr ? `<p style="margin:16px 0;padding:12px 14px;background:#f0f3f9;border-radius:10px;font-family:ui-monospace,Menlo,monospace;font-size:13px;">Your DCA wallet:<br/><b>${addr}</b></p>` : ""}
      <p>Set your daily DCA rate in the dashboard, then the agent handles the rest on the schedule you set — no action needed.</p>
      <p style="font-size:12px;color:#5e6880;margin-top:20px;">This is a testnet demo with no real value. If you didn't sign up, you can ignore this email.</p>
    </div>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Welcome to Aura DCA Agent",
        html,
      }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error("Resend error:", r.status, errBody);
      res.status(502).json({ error: `Email provider error: ${r.status}` });
      return;
    }
    const data = (await r.json()) as { id?: string };
    res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error("send-welcome failed:", err);
    res.status(500).json({ error: "Failed to send email: " + (err instanceof Error ? err.message : String(err)) });
  }
}
