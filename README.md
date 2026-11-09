# fomo terminal (v1)

Windows, local: fill in `.env`, then right-click `start.ps1` → Run with PowerShell (restarts DB + app, opens http://localhost:3000).

```
cp .env.example .env   # fill it in
bun install
bun run db:local       # optional: local Postgres (PGlite) on :5434, no install needed
bun run api            # :3000
                       # api also runs the indexer; `INDEXER=off` + `bun run indexer` to split it out
bun run web            # vite on :5173, proxies /api → api
bun test               # indexer parser tests

# production: build the frontend and serve it from the api on one port
bun run start          # → http://localhost:3000
```

| File | What |
|---|---|
| `api.ts` | Privy JWT auth, signup, tokens, candles, swap/withdraw tx builder, profiles, follows, alerts |
| `indexer.ts` | Watches each user's wallet + token accounts, turns balance deltas into buy/sell/deposit/withdraw rows |
| `schema.sql` | users, follows, trades, cursors |
| `web/main.tsx` | Whole frontend: markets, chart, ticket, portfolio/profile, withdraw, alerts |

Flow: API builds an unsigned tx → browser signs + sends with the Privy embedded wallet → indexer picks it up → portfolio/alerts read from Postgres.

One-time setup: create the USDC associated token account for `FEE_WALLET`, or swaps fail.
