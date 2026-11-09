-- Plain Postgres. Later: `create extension timescaledb; select create_hypertable('trades','ts');`
create table if not exists users (
  id         text primary key,  -- Privy DID
  username   text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  wallet     text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists follows (
  follower text not null references users(id),
  followee text not null references users(id),
  primary key (follower, followee),
  check (follower <> followee)
);

-- One row per (tx, token, user). Written only by the indexer.
create table if not exists trades (
  sig     text not null,
  mint    text not null,
  user_id text not null references users(id),
  kind    text not null check (kind in ('buy', 'sell', 'deposit', 'withdraw')),
  amount  numeric not null,  -- signed token delta
  usdc    numeric not null,  -- signed USDC delta (0 for plain transfers)
  ts      timestamptz not null,
  primary key (sig, mint, user_id)
);
create index if not exists trades_user_ts on trades (user_id, ts desc);

-- Indexer cursor per watched address (wallet + its token accounts)
create table if not exists cursors (
  address  text primary key,
  last_sig text not null
);

-- Multichain: one EVM address works on every EVM chain. Null until the user's EVM wallet is linked.
alter table users add column if not exists evm_wallet text unique;
-- chain = where the token lives (sig is always a tx on that chain)
alter table trades add column if not exists chain text not null default 'solana';
-- via = the tx on the *other* chain that paid for a cross-chain trade; hides its plain USDC transfer row from feeds
alter table trades add column if not exists via text;

-- Relay orders (cross-chain + EVM) waiting to settle. The indexer turns each into a trades row, or drops it.
create table if not exists pending (
  request_id text primary key,
  user_id    text not null references users(id),
  chain      text not null,
  mint       text not null,
  kind       text not null check (kind in ('buy', 'sell')),
  amount     numeric not null,  -- quoted, signed like trades.amount
  usdc       numeric not null,
  created_at timestamptz not null default now()
);
