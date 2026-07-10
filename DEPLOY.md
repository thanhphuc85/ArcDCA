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

| Vercel env var | Value |
| --- | --- |
| `GH_PAT` | the token from step 1 |
| `CIRCLE_API_KEY` | same value as your GitHub Actions secret `CIRCLE_API_KEY` |
| `CIRCLE_ENTITY_SECRET` | same as GitHub secret `CIRCLE_ENTITY_SECRET` |
| `CIRCLE_WALLET_ID` | same value as GitHub secret **`WALLET_ID`** |

> The Circle wallet id is named `WALLET_ID` in the GitHub Actions workflow but
> `CIRCLE_WALLET_ID` here. The API accepts **either** name, so setting `WALLET_ID`
> on Vercel also works — but `CIRCLE_WALLET_ID` is preferred for clarity.

## 4. Deploy & test

1. Click **Deploy** (~1 min). You get a URL like `https://arcdca.vercel.app`.
   - Dashboard: `/`
   - Withdrawal API: `/api/withdraw`
2. Open the dashboard, connect a wallet, go to **My Position → Withdraw**, enter an
   amount, sign the message, and the tokens arrive in ~10–30s.
3. Leave the **Settings → Withdrawal API URL** field **empty** — it defaults to this
   site's own `/api/withdraw`.

Use the Vercel URL in place of the old GitHub Pages link once it works.
