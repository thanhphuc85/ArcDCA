# Aura DCA — Hackathon Submission

*An autonomous DCA agent, built on Arc.*

*Encode Club × Circle — Programmable Money Hackathon (build on Arc)*

Repo: https://github.com/thanhphuc85/ArcDCA
On-chain proof: https://testnet.arcscan.app/tx/0x83097f432db9c013b3f8d7748b58f18484c2a5fde4ce500c221ee38524250933

---

## Tagline

An LLM-driven dollar-cost-averaging agent that runs itself: every day it asks Claude how much USDC to allocate, enforces hard spend limits in code, and executes a real USDC → cirBTC swap on Arc Testnet — no server, no human in the loop.

## The problem

"Agent-driven finance" is one of the hackathon's headline themes, but it hides a real tension: an LLM is great at contextual judgment, yet you can *never* let a language model be the final authority on how much money to move. Give it the keys and one hallucinated number drains the wallet. Take away all its agency and it's just a cron script with extra steps.

## What we built

A daily DCA (dollar-cost-averaging) bot for **cirBTC** on **Arc Testnet** that resolves that tension with a deliberate two-layer design:

1. **Claude decides the strategy.** On each run the agent feeds Claude the live wallet balance, day count, remaining budget, and recent trade history, then asks — via a forced, schema-validated tool call — how much USDC to buy today and why. This is genuinely agentic: Claude reads its own history, paces spending, and even declines to trade when it recognizes the daily budget is already spent.
2. **Code owns the money.** Claude's answer is only a *recommendation*. A pure, unit-tested function `clampDecision()` is the sole authority on the amount actually swapped — it re-derives the cap from hard guardrails (max/day, minimum reserve, dust threshold, optional campaign budget) and never trusts the LLM's arithmetic. Every run records which constraint bound the result, so the audit trail is transparent.

The swap itself goes through Circle's official **Swap Kit** SDK — the only officially documented, reliably-available swap path on Arc Testnet (USDC / EURC / cirBTC). The wallet is a Circle **Developer-Controlled Wallet**, so there's no raw private key to leak.

It runs entirely on a **GitHub Actions cron** — no server to host. Each run commits its result back to `data/history.json` in the repo, producing a public, tamper-evident audit trail that grows over time.

### The dashboard — from bot to product

On top of the autonomous cron, we shipped a full **dashboard** (live at **[arc-dca.vercel.app](https://arc-dca.vercel.app)**) that turns the agent into something people can actually use:

![The Aura DCA dashboard](docs/dashboard.png)

- **Per-user, non-custodial DCA.** Anyone connects a wallet (EIP-6963 multi-wallet) or signs in with email, sets their **own** daily DCA rate, and the agent pools everyone's schedule into each run. Every state change (`set rate`, `run DCA now`, `withdraw`) is authorized by an **EIP-191 wallet signature** and verified in a Vercel serverless function — the user stays in control of their keys.
- **A conversational agent.** A Claude assistant (tool calling) answers "how much is in the treasury?", "explain the last trade", etc. from live on-chain data, and for sensitive actions it only **proposes** — the user confirms and signs in the UI before anything executes.
- **Vector memory + reflection.** After each run Claude writes a reflection to `data/reflections.json`; the dashboard surfaces this "agent memory" plus an **Agent intelligence** panel (risk / market regime / confidence / pattern alerts) derived from the run history.
- **Multi-agent decisions.** A Claude Haiku market-analyst produces a brief that the main decision agent factors into its allocation.

## How it works (flow)

```
GitHub Actions cron (daily)
  → read Circle wallet USDC balance on Arc Testnet
  → Claude decides: { proceed, amountUsdc, reasoning }   (forced tool-use, zod-validated)
  → clampDecision(): hard guardrails enforce the real amount
  → Circle Swap Kit: USDC → cirBTC swap (or dry-run stub)
  → append to data/history.json  →  commit back to repo
```

## Tech stack

- **TypeScript / Node.js**, run directly with `tsx` (no build step)
- **Anthropic Claude** (`@anthropic-ai/sdk`) — the decision engine, via forced tool-use + zod validation
- **Circle Swap Kit** (`@circle-fin/swap-kit`) + **Developer-Controlled Wallets** (`@circle-fin/developer-controlled-wallets`) + Circle Wallets adapter
- **Arc Testnet** (Circle's stablecoin-native EVM L1; gas paid in USDC)
- **GitHub Actions** for scheduling, secrets, and the commit-back audit trail
- **Vitest** unit tests on the safety-critical guardrail logic
- **Vercel** serverless functions (`api/`) for the dashboard's signed actions — set-rate, run-DCA, withdraw, chat, welcome-email
- **Single-file dashboard** (`docs/index.html`) — EIP-6963 wallet discovery, EIP-191 signing, EN/VI, light/dark

## What makes it stand out

- **Real, verifiable execution** — not a demo video. There's an actual on-chain swap and green CI runs anyone can inspect.
- **Safety architecture** — the LLM-recommends / code-decides split is the whole point, and it's enforced by a tested pure function plus a two-switch live-trading gate (`DRY_RUN` + `LIVE_TRADING_ENABLED`).
- **Genuinely autonomous** — self-hosted on free CI, self-documenting via committed history, and it reasons over its own past runs.

## Challenges we ran into

- **The cirBTC pair went into a liquidity outage** — the headline one. `USDC → cirBTC` has returned *"No route available"* on every attempt for 9+ consecutive days, so `data/history.json` is a wall of `error_swap_failed`. We treated this as a measurement problem rather than an excuse and shipped two probes that make the claim falsifiable:
  - `npm run prove-swap` executed a **real swap today** on a working pair — [`0xe54ee0…e3a3`](https://testnet.arcscan.app/tx/0xe54ee0951bed8c7263075b393af40e78606b88e763ce9dd8b7498d6c6a89e3a3) (`0.50 USDC → 0.402303 EURC`). Circle wallet → Swap Kit → Arc Testnet is **provably live**; the pipeline is not the problem.
  - `npm run check-routes` probes every token symbol the SDK knows and shows the outage is isolated to cirBTC: EURC quotes fine, everything else (WBTC/WETH/USDT/DAI/…) isn't wired to Arc Testnet at all. Arc is stablecoin-native — even its native gas token is USDC — so **cirBTC is the only volatile asset there is to DCA into**.

  The agent's response is the part we're proud of: it recognized the failures were *structural rather than transient*, said so in its own [reflections](data/reflections.json), **cut probe frequency to stop burning fees**, and **withheld spend to preserve capital** — for 20+ days, unsupervised. An agent that knows when *not* to act is the harder half of the problem. We kept `TOKEN_OUT=cirBTC`: switching the thesis to EURC would make the demo "work" while quietly turning a BTC-accumulation agent into an FX trade, which is not a trade any user asked for.
- **Arc Testnet has no "real altcoin"** — community DEXs (ArcSwap/Presto/…) lacked publicly verified contract addresses, so we deliberately standardized on Circle's official Swap Kit (USDC↔EURC↔cirBTC) for a submission that actually runs.
- **Circle SDK packaging** — required Node ≥ 22 and had ESM named-export quirks that only surface on specific Node versions; pinned CI to Node 24 to match the verified runtime.
- **Empty-string config in CI** — unset GitHub Actions variables arrive as `""`, which zod's `.default()` doesn't fill; fixed with an explicit empty-to-undefined preprocess.

## What's next

- Multi-asset DCA (split across cirBTC / EURC by a Claude-decided allocation)
- A live P&L / cost-basis panel — the dashboard markup is ready and turns on automatically once cirBTC swaps clear (Arc Testnet's USDC→cirBTC route has been in an outage the agent has been reasoning around)
- Verified sender domain for the welcome email so it reaches any user, not just the operator's inbox
- Mainnet-readiness review when Arc mainnet ships

> Since the first submission we grew this from a headless cron bot into a usable product: a per-user, non-custodial dashboard, a conversational Claude assistant with confirm-to-sign actions, real-time withdrawals and on-demand DCA, and the agent's own vector memory — all still governed by the same code-owns-the-money guardrail.

## Safety note

Testnet only. Funds are valueless faucet tokens. Guardrails are enforced in code, not by the model; live trading requires two explicit switches to be enabled.
