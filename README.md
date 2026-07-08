# Arc DCA Agent

[![Daily DCA Bot](https://github.com/thanhphuc85/ArcDCA/actions/workflows/dca.yml/badge.svg)](https://github.com/thanhphuc85/ArcDCA/actions/workflows/dca.yml)
[![Arc Testnet](https://img.shields.io/badge/Arc-Testnet-2ea44f)](https://testnet.arcscan.app)
[![Decisions by Claude](https://img.shields.io/badge/decisions%20by-Claude-8A2BE2)](https://www.anthropic.com)
[![Circle Swap Kit](https://img.shields.io/badge/swaps%20via-Circle%20Swap%20Kit-2775CA)](https://docs.arc.io/app-kit/swap.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

![Daily flow: cron → read balance → Claude decides → guardrails clamp → swap → commit history](docs/flow.svg)

> **An LLM-driven dollar-cost-averaging agent that runs itself.** Every day a GitHub Actions cron wakes up, asks **Claude** how much USDC to allocate, enforces hard spend guardrails in code, executes a real **USDC → cirBTC** swap on **Arc Testnet** via Circle's official Swap Kit, and commits the audit trail back to this repo — no server, no human in the loop.

Built for the **Encode Club × Circle Programmable Money Hackathon** — full write-up: [`SUBMISSION.md`](SUBMISSION.md) · bản tiếng Việt: [`SUBMISSION.vi.md`](SUBMISSION.vi.md).

Every day, a GitHub Actions cron job:

1. Checks the bot's Circle **Developer-Controlled Wallet** USDC balance on Arc Testnet.
2. Calls **Claude** (Anthropic API) to decide how much USDC to allocate to today's buy, given the remaining budget, day count, and recent trade history.
3. Clamps that recommendation against hard-coded guardrails in code (max per day, minimum reserve, minimum swap size, optional total campaign budget) — **Claude only recommends, the code decides**.
4. Executes a USDC → cirBTC swap via Circle's official [Swap Kit](https://docs.arc.io/app-kit/swap.md) SDK (the only officially documented swap path on Arc Testnet today).
5. Appends a record to [`data/history.json`](data/history.json) and commits it back to the repo, so there's a visible audit trail over time.

Arc Testnet only supports Swap Kit swaps between USDC, EURC, and cirBTC — third-party community DEXs on Arc were deliberately avoided since they don't have publicly verified contract addresses.

The wallet is a Circle **Developer-Controlled Wallet**: Circle custodies the signing key server-side (via your API key + entity secret), so there's no raw private key to manage or leak in a GitHub Actions secret.

## Live demo — verified on-chain

This isn't a mockup. The agent has executed a **real swap on Arc Testnet**:

- **Transaction:** [`0x83097f…50933`](https://testnet.arcscan.app/tx/0x83097f432db9c013b3f8d7748b58f18484c2a5fde4ce500c221ee38524250933) — swapped `0.10 USDC → cirBTC`
- **The daily cron runs autonomously in CI:** see the green [Actions runs](https://github.com/thanhphuc85/ArcDCA/actions/workflows/dca.yml) and the bot's own `chore: record DCA run …` commits to [`data/history.json`](data/history.json).

**Autonomous run in CI** — [verify live on the Actions tab →](https://github.com/thanhphuc85/ArcDCA/actions/workflows/dca.yml)

![Daily DCA Bot run #4 succeeded in 24s on GitHub Actions](docs/ci-run.svg)

**The resulting on-chain swap** — [verify on ArcScan →](https://testnet.arcscan.app/tx/0x83097f432db9c013b3f8d7748b58f18484c2a5fde4ce500c221ee38524250933)

![Swap of 0.1 USDC for cirBTC succeeded on Arc Testnet](docs/tx.svg)

<sub>The two cards above summarize the real, independently verifiable events — the links are the source of truth.</sub>

A real audit-trail entry the agent wrote (`data/history.json`), showing Claude's own reasoning:

```jsonc
{
  "date": "2026-07-07",
  "status": "success",
  "requestedAmountUsdc": "0.10",   // what Claude proposed
  "clampedAmountUsdc": "0.100000", // what the code guardrails allowed
  "boundBy": "llm_recommendation", // which constraint bound the amount
  "tokenOut": "cirBTC",
  "reasoning": "Wallet balance (20 USDC) is well above the minimum reserve, no spend has occurred today, and this is day 1 with no campaign budget constraints noted. Proceeding with the max daily allowance of 0.10 USDC keeps a steady, smoothed pace without front-loading beyond guardrails.",
  "txHash": "0x83097f432db9c013b3f8d7748b58f18484c2a5fde4ce500c221ee38524250933",
  "explorerUrl": "https://testnet.arcscan.app/tx/0x83097f...50933",
  "amountOut": "0.00000012"
}
```

The agent also demonstrably **respects its own budget**: on a second same-day run it declined to trade — *"Already spent … today, which exceeds the maxDailyUsdc guardrail … Daily budget is exhausted"* — reading its own history and reasoning about it, not blindly firing.

## Why this is "agentic" (and safe)

The core design tension in an autonomous money bot: you want the flexibility of an LLM, but you cannot let an LLM be the final authority on how much to spend. This project resolves it with a strict split:

| | Claude (the agent) | `clampDecision()` (the code) |
|---|---|---|
| Role | **Recommends** an amount + reasoning | **Decides** the amount actually swapped |
| Input | Balance, day count, budget, recent history | Claude's recommendation + hard guardrails |
| Output | `{ proceed, amountUsdc, reasoning }` (validated via forced tool-use) | Clamped amount, or a skip with a recorded reason |
| Trust | Never trusted with the final number | Sole authority; pure function; unit-tested |

Every run records *which* constraint bound the outcome (`boundBy`), so the audit trail is transparent about whether Claude's own judgment or a hard cap drove the result. See [`src/decision/guardrails.ts`](src/decision/guardrails.ts).

## Architecture

```
src/
  config.ts        env parsing (zod) + guardrail defaults
  wallet.ts         Circle Developer-Controlled Wallets client + USDC balance getter
  decision/
    prompt.ts        context + system prompt sent to Claude
    client.ts         Anthropic tool-use call, zod-validated
    guardrails.ts     clampDecision() -- the real spending authority
  swap/swapKit.ts    Circle Swap Kit execution via the Circle Wallets adapter (+ dry-run stub)
  history/store.ts   data/history.json read/append + budget math
  run.ts             orchestrator for one daily run
  index.ts           entrypoint, exit-code handling
scripts/
  create-arc-wallet.mjs   one-off setup script: creates the wallet the bot signs with
```

## Prerequisites

- Node.js 20+
- A [Circle Developer Console](https://console.circle.com) account:
  - An **API key** (console.circle.com/api-keys).
  - An **entity secret** for Developer-Controlled Wallets, generated and registered from the console's Developer-Controlled Wallets setup screen.
- A Swap Kit `kitKey` from the Circle Developer Console (only required for real swaps, not for dry runs).
- An [Anthropic API key](https://console.anthropic.com).

## Local setup

```bash
npm install
cp .env.example .env
# fill in CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, KIT_KEY, ANTHROPIC_API_KEY

# create the wallet the bot will sign with, on Arc Testnet
npm run create-wallet
# copy the printed WALLET_ID into .env, then fund the printed address at
# https://faucet.circle.com (select Arc Testnet)

npm run typecheck
npm test

DRY_RUN=true npm start
```

A dry run performs the balance check and the real Claude decision call, but skips the actual swap and logs what *would* have happened.

## Guardrail configuration

All guardrails live in environment variables (see `.env.example`) and are enforced in [`src/decision/guardrails.ts`](src/decision/guardrails.ts), not trusted to the LLM:

| Variable | Meaning | Default |
|---|---|---|
| `MAX_DAILY_USDC` | Max USDC spend per day | `1.00` |
| `MIN_USDC_RESERVE` | USDC balance to always keep untouched | `0.50` |
| `MIN_SWAP_USDC` | Dust threshold below which a swap is skipped | `0.10` |
| `CAMPAIGN_TOTAL_BUDGET_USDC` | Optional overall cap across the whole campaign | unset |
| `CAMPAIGN_DURATION_DAYS` | Optional horizon Claude uses to pace spend | unset |
| `TOKEN_OUT` | Swap target token symbol | `cirBTC` |
| `DRY_RUN` | Skip the real swap when `true` | `true` |

## GitHub Actions setup

1. **Settings → Actions → General → Workflow permissions** → select **Read and write permissions** (required for the bot's history commit-back push).
2. **Settings → Secrets and variables → Actions → Secrets**, add:
   - `CIRCLE_API_KEY`
   - `CIRCLE_ENTITY_SECRET`
   - `WALLET_ID` (from `npm run create-wallet`)
   - `KIT_KEY`
   - `ANTHROPIC_API_KEY`
3. **Settings → Secrets and variables → Actions → Variables** (optional, all have code defaults), add any of `MAX_DAILY_USDC`, `MIN_USDC_RESERVE`, `MIN_SWAP_USDC`, `CAMPAIGN_TOTAL_BUDGET_USDC`, `CAMPAIGN_DURATION_DAYS`, `TOKEN_OUT`.
4. Set the `LIVE_TRADING_ENABLED` variable to `true` only when you're ready for the scheduled job to spend real testnet funds. Until then, both the scheduled and manual runs default to dry run — this is a deliberate second safety switch on top of the `dry_run` workflow input.

### Manual dry run

Go to the **Actions** tab → **Daily DCA Bot** → **Run workflow**, leave `dry_run` checked (default), and run it. Check the job logs and the updated `data/history.json` diff.

## Reading `data/history.json`

Each entry has a `status` field: `success` / `dry_run` for completed runs, `skipped_*` for routine no-ops (low balance, LLM declined, guardrail clamped to zero), and `error_*` for failures. `requestedAmountUsdc` is what Claude proposed; `clampedAmountUsdc` is what the guardrails actually allowed, with `boundBy` showing which constraint bound the result.

## Safety notes

- **Testnet only.** This targets Arc Testnet; there is no mainnet USDC or cirBTC at risk.
- The wallet is **Circle-custodied** (Developer-Controlled Wallet) — never commit `.env` or a real `CIRCLE_ENTITY_SECRET` to the repo.
- Guardrails (`clampDecision`) are the sole authority on spend amounts; Claude's output is only ever a recommendation.
