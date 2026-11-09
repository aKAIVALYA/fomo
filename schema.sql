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
