# Deploy to Vercel (dashboard + real-time withdrawals)

The dashboard (`docs/`) and the withdrawal API (`api/withdraw.ts`) ship in **one**
Vercel deployment. Because they share an origin, the frontend calls
`/api/withdraw` directly — no URL to paste anywhere.

## 1. Create a GitHub token (GH_PAT)

The withdrawal API commits balance updates to `data/ledger.json`, so it needs a
token with write access to this repo.

1. https://github.com/settings/personal-access-tokens/new (fine-grained)
2. Repository access → **Only select repositories** → `thanhphuc85/ArcDCA`
3. Permissions → Repository permissions → **Contents: Read and write**
4. Generate and copy the `github_pat_...` value.

## 2. Import the repo into Vercel

1. https://vercel.com → sign in with GitHub → **Add New… → Project**
2. Import `thanhphuc85/ArcDCA`
3. **Framework Preset: Other** · Build Command: *(empty)* · Output Directory: *(empty)*
   (`vercel.json` already rewrites `/` to `docs/` and keeps `/api/*` as functions.)

## 3. Environment variables

| Vercel env var | Required for | Value |
| --- | --- | --- |
| `GH_PAT` | ledger writes (all signed actions) | the token from step 1 |
| `CIRCLE_API_KEY` | withdraw, run-dca | same value as GitHub secret `CIRCLE_API_KEY` |
| `CIRCLE_ENTITY_SECRET` | withdraw, run-dca | same as GitHub secret `CIRCLE_ENTITY_SECRET` |
| `CIRCLE_WALLET_ID` | withdraw, run-dca | same value as GitHub secret **`WALLET_ID`** |
| `ANTHROPIC_API_KEY` | chat assistant (`/api/chat`) | same as GitHub secret `ANTHROPIC_API_KEY` |
| `KIT_KEY` | on-demand swap (`/api/run-dca`) | same as GitHub secret `KIT_KEY` |
| `RESEND_API_KEY` | welcome email (`/api/send-welcome`) | key from [resend.com](https://resend.com/api-keys) |

> The Circle wallet id is named `WALLET_ID` in the GitHub Actions workflow but
> `CIRCLE_WALLET_ID` here. The API accepts **either** name, so setting `WALLET_ID`
> on Vercel also works — but `CIRCLE_WALLET_ID` is preferred for clarity.
>
> The first four are enough for withdrawals; add `ANTHROPIC_API_KEY`, `KIT_KEY`,
> and `RESEND_API_KEY` to enable the chat assistant, on-demand DCA, and the
> welcome email respectively. Each feature degrades gracefully if its key is absent.

## 4. Deploy & test

1. Click **Deploy** (~1 min). You get a URL like `https://arcdca.vercel.app`.
   - Dashboard: `/`
   - Withdrawal API: `/api/withdraw`
2. Open the dashboard, connect a wallet, go to **My Position → Withdraw**, enter an
   amount, sign the message, and the tokens arrive in ~10–30s.
3. Leave the **Settings → Withdrawal API URL** field **empty** — it defaults to this
   site's own `/api/withdraw`.

Use the Vercel URL in place of the old GitHub Pages link once it works.
