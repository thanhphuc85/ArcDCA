# Aura DCA — Hackathon Submission

*An autonomous DCA agent, built on Arc Network.*

*Encode Club × Circle — Programmable Money Hackathon (build on Arc)*

Repo: https://github.com/thanhphuc85/ArcDCA
On-chain proof: https://testnet.arcscan.app/tx/0x83097f432db9c013b3f8d7748b58f18484c2a5fde4ce500c221ee38524250933

---

## Tagline

An autonomous agent that lets Claude drive strategy while **code owns every number that touches money** — and pools many users' schedules into a **single on-chain swap, settled pro-rata**. Dollar-cost averaging into cirBTC on Arc Testnet is the reference implementation; the architecture underneath it is the contribution.

## The problem

"Agent-driven finance" is one of the hackathon's headline themes, but it hides a real tension: an LLM is great at contextual judgment, yet you can *never* let a language model be the final authority on how much money to move. Give it the keys and one hallucinated number drains the wallet. Take away all its agency and it's just a cron script with extra steps.

That tension gets sharper the moment the money isn't yours. An agent serving **many** users has to be fair as well as safe: each person's schedule honoured exactly, each person's funds ring-fenced from everyone else's, and every allocation reconstructable after the fact — while still executing efficiently on-chain rather than one transaction per user.

## What we built

An agent that resolves both halves of that, with **dollar-cost averaging as the concrete instance**:

**1. Claude decides the strategy — code owns the money.** Each run feeds Claude live balances, pacing, budget, and its own trade history, and asks — via a forced, schema-validated tool call — what to do and why. Claude reads its own history, paces spending, and declines to trade when it recognises the budget is spent. But its answer is only a *recommendation*: a pure, unit-tested `clampDecision()` re-derives the real cap from hard guardrails (max/day, minimum reserve, dust threshold, campaign budget) and is the sole authority on the number actually swapped. Every run records *which* constraint bound the result.

> Our logo is that split, drawn: two orbits that never contain each other, meeting only where a decision is made.

**2. Many users, one swap, fair settlement.** Each wallet sets its own cadence, amount and caps. Every run the agent computes each user's due spend, executes the **sum as a single swap**, then distributes the received cirBTC **pro-rata by contribution** — scaling every share down together if a guardrail capped the total, and assigning the rounding remainder deterministically so the books always close. One transaction serves everyone; nobody subsidises anyone. ([`schedule.ts`](src/ledger/schedule.ts), unit-tested.)

**3. Non-custodial by construction.** Users never hand over keys. Every state change — set schedule, run now, withdraw — is authorised by an **EIP-191 signature** the user makes in their own wallet and the server verifies before touching the ledger. The agent can execute the strategy; it can never invent a user's consent.

**4. It remembers.** After each run Claude writes a reflection to `data/reflections.json` and can recall past ones when deciding — which is how it recognised the cirBTC outage as *structural* and stopped burning fees on it.

The swap itself goes through Circle's official **Swap Kit** SDK — the only officially documented, reliably-available swap path on Arc Testnet (USDC / EURC / cirBTC). The wallet is a Circle **Developer-Controlled Wallet**, so there's no raw private key to leak.

It runs entirely on a **GitHub Actions cron** — no server to host. Each run commits its result back to `data/history.json` in the repo, producing a public, tamper-evident audit trail that grows over time.

### The dashboard — from bot to product

On top of the autonomous cron, we shipped a full **dashboard** (live at **[aura-dca.vercel.app](https://aura-dca.vercel.app)**) that turns the agent into something people can actually use:

![The Aura DCA dashboard](docs/dashboard.png)

- **Per-user, non-custodial DCA.** Anyone connects a wallet (EIP-6963 multi-wallet) or signs in with email, sets their **own** daily DCA rate, and the agent pools everyone's schedule into each run. Every state change (`set rate`, `run DCA now`, `withdraw`) is authorized by an **EIP-191 wallet signature** and verified in a Vercel serverless function — the user stays in control of their keys.
- **A conversational agent.** A Claude assistant (tool calling) answers "how much is in the treasury?", "explain the last trade", etc. from live on-chain data, and for sensitive actions it only **proposes** — the user confirms and signs in the UI before anything executes.
- **Vector memory + reflection.** After each run Claude writes a reflection to `data/reflections.json`; the dashboard surfaces this "agent memory" plus an **Agent intelligence** panel (risk / market regime / confidence / pattern alerts) derived from the run history.
- **Multi-agent decisions.** A Claude Haiku market-analyst produces a brief that the main decision agent factors into its allocation.

## Does it run? — the honest state

You will open [`data/history.json`](data/history.json) and see a wall of
`error_swap_failed`. Here is that, straight, before anything else in this document
tries to impress you.

**The pipeline runs.** Circle wallet → Swap Kit → Arc Testnet executed a real swap
today: [`0xe54ee0…e3a3`](https://testnet.arcscan.app/tx/0xe54ee0951bed8c7263075b393af40e78606b88e763ce9dd8b7498d6c6a89e3a3)
(`0.50 USDC → 0.402303 EURC`). Reproduce it yourself with `npm run prove-swap`.

**The cirBTC market does not.** `USDC → cirBTC` has returned *"No route available"*
on all 24 attempts across 9 consecutive days. It's a liquidity outage on Arc
Testnet, not a bug in the agent — and `npm run check-routes` shows it's isolated
to cirBTC, which is the only volatile asset Arc carries (the chain is
stablecoin-native down to its USDC gas token).

**The agent handled it the way we'd want it to.** It recognised the failures as
*structural rather than transient*, recorded that reasoning in its own
[reflections](data/reflections.json), cut its probe frequency to stop burning
fees, and withheld spend to preserve capital across all 9 days of the outage,
unsupervised. Knowing when *not* to act is the harder half of an autonomous money
agent, and this is the run of history where it was tested for real.

We could have made the demo light up by pointing `TOKEN_OUT` at EURC. We didn't:
that turns a BTC-accumulation agent into an FX trade — a working demo of a
different product. [What we measured](#what-we-measured-and-the-pivot-we-killed)
has the full data, including the conclusion of ours that the data overturned.

## How it works (flow)

```
GitHub Actions cron (hourly — each user's own cadence decides if this hour is theirs)
  → read Circle wallet USDC balance on Arc Testnet
  → computeScheduledSpends(): who is due now, how much each, capped by their limits
  → Claude decides / advises: { proceed, amountUsdc, reasoning }  (forced tool-use, zod-validated)
  → clampDecision(): hard guardrails enforce the real amount
  → Circle Swap Kit: ONE USDC → cirBTC swap for the pooled total (or dry-run stub)
  → applyScheduledDistribution(): split pro-rata back to each user
  → append to data/history.json  →  commit back to repo
```

## Tech stack

- **TypeScript / Node.js**, run directly with `tsx` (no build step)
- **Anthropic Claude** (`@anthropic-ai/sdk`) — the decision engine, via forced tool-use + zod validation
- **Circle Swap Kit** (`@circle-fin/swap-kit`) + **Developer-Controlled Wallets** (`@circle-fin/developer-controlled-wallets`) + Circle Wallets adapter
- **Arc Testnet** (Circle's stablecoin-native EVM L1; gas paid in USDC)
- **GitHub Actions** for scheduling, secrets, and the commit-back audit trail
- **Vitest** — 29 unit tests on the safety-critical paths: `clampDecision()` guardrails, the pooled pro-rata settlement, and the campaign-day arithmetic the agent reasons from
- **Vercel** serverless functions (`api/`) for the dashboard's signed actions — set-rate, run-DCA, withdraw, chat, welcome-email
- **Single-file dashboard** (`docs/index.html`) — EIP-6963 wallet discovery, EIP-191 signing, EN/VI, light/dark

## What we measured (and the pivot we killed)

When the cirBTC route died, the tempting move was to pivot the thesis to something
that still worked. We nearly did — a USDC/EURC treasury FX rebalancer: same
scheduling engine, same guardrails, and EURC was the one pair still quoting.

Instead we measured first, because the cirBTC failure had already taught us the
lesson: **we had bet on something we never verified.** So before committing two
weeks, we sampled the EURC rate (`npm run sample-fx`, read-only).

The first half hour looked damning — nine identical readings, `1.1451554658`
every time. We very nearly wrote the pivot off as impossible. Then we kept the
sampler running:

```
03:04 → 03:48   1.1451554658   (held for 48 minutes)
03:53           1.1426120287   ← −0.2226%
03:58           1.1426120287
```

**The rate isn't pegged — the oracle just updates in coarse, roughly hourly
steps, and our first sample window had fallen entirely inside one of them.** A
half-hour of data would have had us confidently reporting a frozen market. The
finding wasn't "EURC is dead"; it was "we hadn't sampled long enough to see it
breathe."

That correction only happened because we kept measuring after we thought we had
the answer — and it's the part of this we'd defend hardest. The three probes
([`check-routes`](scripts/check-routes.mjs), [`prove-swap`](scripts/prove-swap.mjs),
[`sample-fx`](scripts/sample-fx.mjs)) all live in the repo and are reproducible;
`data/fx-samples.json` is the raw series behind the numbers above.

What the probes actually establish:

| Asset | Measured state |
|---|---|
| cirBTC | No liquidity — `No route available`, 24/24 attempts over 9 days |
| EURC | Live, and the rate does move — in ~hourly steps of ~0.22% |
| WBTC / WETH / USDT / DAI / … | Not wired to Arc Testnet at all |

So the pivot was viable after all. We still didn't take it — but for a reason that
survives the correction: **retargeting `TOKEN_OUT` to EURC would turn a
BTC-accumulation agent into an FX trade.** The demo would light up, and it would
be a different product than the one anyone asked for. cirBTC is the only volatile
asset Arc Testnet carries, and DCA into it is the thesis; a stablecoin FX pair is
not a substitute for it, however conveniently it happens to be quoting.

The honest position: the agent is correct, cirBTC's market is empty, and we have
the data to show which — including the data that proved our own first conclusion
wrong.

## What makes it stand out

- **Real, verifiable execution** — not a demo video. There's an actual on-chain swap and green CI runs anyone can inspect.
- **Safety architecture** — the LLM-recommends / code-decides split is the whole point, and it's enforced by a tested pure function plus a two-switch live-trading gate (`DRY_RUN` + `LIVE_TRADING_ENABLED`).
- **Genuinely autonomous** — self-hosted on free CI, self-documenting via committed history, and it reasons over its own past runs.

## Challenges we ran into

- **The cirBTC pair went into a liquidity outage** — the headline one, covered in [Does it run?](#does-it-run--the-honest-state) and [What we measured](#what-we-measured-and-the-pivot-we-killed). Short version: we treated it as a measurement problem rather than an excuse, and shipped probes that make every claim here falsifiable.
- **Arc Testnet has no "real altcoin"** — community DEXs (ArcSwap/Presto/…) lacked publicly verified contract addresses, so we deliberately standardized on Circle's official Swap Kit (USDC↔EURC↔cirBTC) for a submission that actually runs.
- **Our own metric was lying to the agent.** `dayCount()` returned `history.length + 1` — the *run* count — but it reaches Claude in the decision context as `dayCount` and it reasons about pacing with it. At three runs a day the agent believed it was on "day 21" after a week, and its reflections overstated the outage's length by ~3x; once the cron went hourly it would have drifted 24x per real day. Found while fact-checking this document against `history.json` — the "20+ days" we had written came from the agent's own corrupted arithmetic. `dayCount` now counts distinct dates and is regression-tested. **An agent reasoning from a mislabeled number is confidently wrong, and nothing in the output looks broken** — which is the whole argument for keeping the money-authority in tested code rather than in the model.
- **Circle SDK packaging** — required Node ≥ 22 and had ESM named-export quirks that only surface on specific Node versions; pinned CI to Node 24 to match the verified runtime.
- **Empty-string config in CI** — unset GitHub Actions variables arrive as `""`, which zod's `.default()` doesn't fill; fixed with an explicit empty-to-undefined preprocess.

## What's next

- Multi-asset DCA (a Claude-decided split across assets) — needs **more than one asset worth averaging into**. cirBTC is the only volatile asset Arc Testnet carries and its liquidity is out; EURC is live and its rate moves, but a stablecoin FX pair isn't a second DCA target. This unlocks the day cirBTC's market returns.
- A live P&L / cost-basis panel — the dashboard markup is ready and turns on automatically once cirBTC swaps clear (Arc Testnet's USDC→cirBTC route has been in an outage the agent has been reasoning around)
- Verified sender domain for the welcome email so it reaches any user, not just the operator's inbox
- Mainnet-readiness review when Arc mainnet ships

> Since the first submission we grew this from a headless cron bot into a usable product: a per-user, non-custodial dashboard, a conversational Claude assistant with confirm-to-sign actions, real-time withdrawals and on-demand DCA, and the agent's own vector memory — all still governed by the same code-owns-the-money guardrail.

## Brand & trademark

**Aura DCA is an independent project built on Arc Network — not affiliated with, endorsed by, or a product of Circle.**

Checked against the [Arc brand guidelines and partner toolkit](https://www.arc.io/brand-guidelines-and-partner-toolkit):
the product name and logo are **Aura's own** ("Arc" appears in neither); Arc is referenced
only in the approved factual sense (*built on Arc Network*, *on Arc Testnet*), never as
endorsement; "Arc Network" is used on first mention; and we use **no** Arc or Circle brand
assets at all, which is the simplest way to honour the rules on modifying or over-weighting
their mark. The [README](README.md#brand--trademark) has the point-by-point mapping.

## Safety note

Testnet only. Funds are valueless faucet tokens. Guardrails are enforced in code, not by the model; live trading requires two explicit switches to be enabled.
