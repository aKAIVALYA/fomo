# fomo terminal (v1)

Trade Solana and Base tokens from one USDC balance, gasless. Follow people and see what they buy.

Windows, local: fill in `.env`, then right-click `start.ps1` → Run with PowerShell (restarts DB + app, opens http://localhost:3000).

```
cp .env.example .env   # fill it in
bun install
bun run db:local       # optional: local Postgres (PGlite) on :5434, no install needed
bun run api            # :3000
                       # api also runs the indexer; `INDEXER=off` + `bun run indexer` to split it out
bun run web            # vite on :5173, proxies /api → api
bun test               # parser, gasless and settle tests

# production: build the frontend and serve it from the api on one port
bun run start          # → http://localhost:3000
```

| File | What |
|---|---|
| `api.ts` | Privy JWT auth, signup, tokens, candles, unified balance, swap/withdraw tx builder (Jupiter + Relay, gas sponsor), profiles, follows, alerts |
| `indexer.ts` | Watches each user's wallet + token accounts, turns balance deltas into buy/sell/deposit/withdraw rows. Settles Relay orders into trades |
| `shared.ts` | DB, chain list, gasless + EVM helpers |
| `schema.sql` | users, follows, trades, cursors, pending |
| `web/main.tsx` | Whole frontend: markets, chart, ticket, portfolio/profile, withdraw, alerts |

Flow: API builds an unsigned tx → browser signs + sends with the Privy embedded wallet → indexer picks it up → portfolio/alerts read from Postgres.

## Multichain, one balance

Every user has a Solana wallet and an EVM wallet (both Privy embedded). USDC on Solana + USDC on Base = one cash number.

| Trade | Route |
|---|---|
| Solana token, paid from Solana USDC | Jupiter |
| Base token, paid from Base USDC (and every Base sell) | Relay, same chain |
| Token on one chain, USDC on the other | Relay, cross-chain |

A buy pays from the token's own chain when it has enough USDC, else from the other chain. Sells settle to USDC on the token's chain.
Relay orders sit in `pending` until Relay reports the fill, then become a `trades` row.
Add an EVM chain: one row in `CHAINS` in `shared.ts` and one in `web/main.tsx`.

## Gasless

- **Solana** (`SPONSOR_KEY`): the api's sponsor wallet is fee payer and pays token-account rent. It signs first, the user signs second.
  A new token account is repaid in USDC (about $0.30, taken from the trade amount). Without that, users could close accounts and pocket the rent.
- **Base** (`EVM_GASLESS=on`): Privy fee sponsorship pays. Set it up in the Privy dashboard first.

Both are off by default; then users pay their own gas as before.

Known limits (marked `ponytail:` in code): one source chain per buy, Base holdings come only from trades made here, Relay trades record quoted amounts.

One-time setup: create the USDC associated token account for `FEE_WALLET`, or swaps fail.
