import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { USDC, cached, migrate, ownsWallet, rpc, sql } from "./shared";
import { runIndexer } from "./indexer";

await migrate();
// ponytail: indexer runs inside the api (one process, one DB pool). Split out with `bun run indexer` + INDEXER=off when it needs its own box.
if (process.env.INDEXER !== "off") runIndexer();

const env = process.env as Record<string, string>;
// jose caches the keys and refetches on rotation
const privyKey = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${env.PRIVY_APP_ID}/jwks.json`));
// no FEE_WALLET = no platform fee (handy for local dev)
const FEE_ATA = env.FEE_WALLET ? getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(env.FEE_WALLET)).toBase58() : "";
// Jupiter rejects swaps whose fee account doesn't exist, so a missing account would break every trade. Turn the fee off instead.
let feeOn = !!FEE_ATA;
if (FEE_ATA) rpc.getAccountInfo(new PublicKey(FEE_ATA)).then((a) => {
  if (!a) { feeOn = false; console.warn(`FEE_WALLET has no USDC token account (${FEE_ATA}); platform fee disabled until it exists and the api restarts`); }
}).catch(() => {});
const MIN_SOL = 0.003; // network fees + rent for a new token account
const DIST = import.meta.dir + "/web/dist";

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const bad = (msg: string, status = 400) => { throw new HttpError(status, msg); };

// ---------- helpers ----------
async function userId(req: Request): Promise<string> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) bad("no token", 401);
  try {
    const { payload } = await jwtVerify(token!, privyKey, { issuer: "privy.io", audience: env.PRIVY_APP_ID });
    return payload.sub!;
  } catch { return bad("bad token", 401); }
}

async function me(req: Request) {
  const [u] = await sql`select * from users where id = ${await userId(req)}`;
  return u ?? bad("sign up first", 403);
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const host = new URL(url).host;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => bad(`${host} is unreachable right now, try again shortly`, 502));
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 429) bad(`${host} is rate-limiting us, try again in a minute`, 503);
  if (!r.ok) bad(j.error ?? j.message ?? `${host} returned ${r.status}`, 502);
  return j;
}

const jup = (path: string) => getJson(env.JUPITER_API_URL + path, { "x-api-key": env.JUPITER_API_KEY });

// GeckoTerminal's free API allows ~30 calls/min. Space our calls out instead of tripping the limit.
let geckoNextAt = 0;
async function gecko(path: string) {
  const wait = geckoNextAt - Date.now();
  if (wait > 10_000) bad("Charts are busy, try again in a few seconds", 503);
  geckoNextAt = Math.max(Date.now(), geckoNextAt) + 2_200; // ≈27/min
  if (wait > 0) await Bun.sleep(wait);
  return getJson("https://api.geckoterminal.com/api/v2" + path, { accept: "application/json" });
}

const pubkey = (s: unknown) => { try { return new PublicKey(String(s)); } catch { return bad(`bad address: ${s}`); } };
const rawAmount = (s: unknown) => /^[1-9]\d*$/.test(String(s)) ? String(s) : bad("amount must be a positive integer in base units");

// symbol/icon/price for a set of mints, keyed by mint
async function tokenInfo(mints: string[]): Promise<Record<string, any>> {
  if (!mints.length) return {};
  // ponytail: one search call, max 100 mints; chunk if a portfolio ever exceeds that
  // degrade to bare mints if Jupiter is down rather than failing the whole profile
  const key = [...mints].sort().slice(0, 100).join(",");
  const list: any[] = await cached(`info:${key}`, 30_000, () => jup(`/tokens/v2/search?query=${key}`)).catch(() => []);
  return Object.fromEntries(list.map((t) => [t.id, { symbol: t.symbol, icon: t.icon, price: t.usdPrice, decimals: t.decimals, verified: !!t.isVerified }]));
}

// A wallet with no SOL can't pay network fees; say so up front instead of failing inside the wallet.
async function needSol(wallet: PublicKey) {
  const lamports = await rpc.getBalance(wallet).catch(() => Infinity); // RPC hiccup: let the wallet's own simulation decide
  if (lamports < MIN_SOL * 1e9) bad(`Your wallet needs about ${MIN_SOL} SOL for network fees. Send a little SOL to ${wallet.toBase58()} and try again.`, 402);
}

function toTx(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[] = []) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  return { tx: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64") };
}

const jupIx = (i: any) => new TransactionInstruction({
  programId: new PublicKey(i.programId),
  keys: i.accounts.map((a: any) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(i.data, "base64"),
});

// ---------- routes ----------
type H = (req: Request & { params: Record<string, string> }) => Promise<unknown>;
const h = (fn: H) => async (req: any) => {
  try { return Response.json((await fn(req)) ?? null); }
  catch (e: any) {
    if (e instanceof HttpError) {
      console.warn(req.method, new URL(req.url).pathname, e.status, e.message);
      return Response.json({ error: e.message }, { status: e.status });
    }
    if (e instanceof SyntaxError) return Response.json({ error: "invalid JSON body" }, { status: 400 });
    if (e?.errno === "23505") return Response.json({ error: "already taken" }, { status: 409 });
    console.error(req.method, new URL(req.url).pathname, e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
};

const server = Bun.serve({
  port: Number(env.PORT ?? 3000),
  routes: {
    "/api/me": {
      GET: h(async (req) => (await sql`select * from users where id = ${await userId(req)}`)[0] ?? null),
      // signup: pick username. The client proves it owns `wallet` by signing signupMessage(id) with it,
      // so nobody can claim someone else's wallet (and its trades).
      POST: h(async (req) => {
        const id = await userId(req);
        const { username, wallet, signature } = await req.json();
        if (!/^[a-z0-9_]{3,20}$/.test(username)) bad("username: 3-20 chars, a-z 0-9 _");
        if (!(await ownsWallet(pubkey(wallet), id, String(signature)))) bad("wallet signature check failed", 401);
        const [u] = await sql`insert into users (id, username, wallet) values (${id}, ${username}, ${pubkey(wallet).toBase58()}) returning *`;
        return u;
      }),
    },

    // Default list: Jupiter-verified tokens only (the "blue chips"). Search can find anything; the UI warns on risky ones.
    "/api/tokens": h(async (req) => {
      const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 64);
      const list: any[] = q
        ? await cached(`search:${q.toLowerCase()}`, 60_000, () => jup(`/tokens/v2/search?query=${encodeURIComponent(q)}`))
        : (await cached("top", 30_000, () => jup("/tokens/v2/toporganicscore/24h?limit=100"))).filter((t: any) => t.isVerified);
      return list.map((t) => ({
        id: t.id, symbol: t.symbol, name: t.name, icon: t.icon, decimals: t.decimals, usdPrice: t.usdPrice,
        stats24h: { priceChange: t.stats24h?.priceChange }, liquidity: t.liquidity, verified: !!t.isVerified,
        freezable: !t.audit?.freezeAuthorityDisabled, mintable: !t.audit?.mintAuthorityDisabled,
      }));
    }),

    // [[ts, o, h, l, c, v], ...] newest first
    "/api/candles/:mint": h(async (req) => {
      const mint = pubkey(req.params.mint).toBase58();
      const tf = new URL(req.url).searchParams.get("tf") ?? "hour";
      if (!["minute", "hour", "day"].includes(tf)) bad("tf: minute|hour|day");
      const pool: string = await cached(`pool:${mint}`, 86_400_000, async () =>
        (await gecko(`/networks/solana/tokens/${mint}/pools?page=1`)).data?.[0]?.attributes?.address ?? bad("No trading pool found for this token", 404));
      const ttl = { minute: 30_000, hour: 300_000, day: 1_800_000 }[tf as "minute" | "hour" | "day"];
      return cached(`ohlcv:${mint}:${tf}`, ttl, async () =>
        (await gecko(`/networks/solana/pools/${pool}/ohlcv/${tf}?limit=200&currency=usd&token=${mint}`)).data.attributes.ohlcv_list);
    }),

    // returns an unsigned tx; the user signs + sends it with their Privy wallet
    "/api/swap": {
      POST: h(async (req) => {
        const u = await me(req);
        const { side, mint, amount } = await req.json();
        const m = pubkey(mint).toBase58();
        if (m === USDC) bad("pick a token other than USDC");
        if (side !== "buy" && side !== "sell") bad("side: buy|sell");
        await needSol(pubkey(u.wallet));
        const q = new URLSearchParams({
          inputMint: side === "buy" ? USDC : m,
          outputMint: side === "buy" ? m : USDC,
          amount: rawAmount(amount),
          taker: u.wallet,
          slippageBps: "50",
          ...(feeOn && { platformFeeBps: env.FEE_BPS, feeAccount: FEE_ATA }), // fee always in USDC: input on buys, output on sells
          wrapAndUnwrapSol: "false", // ponytail: SOL stays as wSOL so the indexer sees it as a token balance
          transactionVersion: "0",
        });
        const b = await jup(`/swap/v2/build?${q}`);
        const alts = Object.entries(b.addressesByLookupTableAddress ?? {}).map(([key, addrs]) =>
          new AddressLookupTableAccount({
            key: new PublicKey(key),
            state: { addresses: (addrs as string[]).map((a) => new PublicKey(a)), deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 },
          }));
        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), // ponytail: fixed limit; simulate if swaps start failing on CU
          ...(b.computeBudgetInstructions ?? []), ...(b.setupInstructions ?? []),
          b.swapInstruction, b.cleanupInstruction, ...(b.otherInstructions ?? []),
        ].filter(Boolean).map((i) => (i instanceof TransactionInstruction ? i : jupIx(i)));
        // Jupiter returns the blockhash as 32 raw bytes; PublicKey is just a base58 encoder here
        const blockhash = new PublicKey(Uint8Array.from(b.blockhashWithMetadata.blockhash)).toBase58();
        return toTx(pubkey(u.wallet), blockhash, ixs, alts);
      }),
    },

    "/api/withdraw": {
      POST: h(async (req) => {
        const u = await me(req);
        const { mint, amount, to } = await req.json();
        const [m, dest, owner] = [pubkey(mint), pubkey(to), pubkey(u.wallet)];
        // Off-curve addresses are program accounts (token accounts, PDAs), not wallets; funds sent there are usually lost.
        if (!PublicKey.isOnCurve(dest.toBytes())) bad("That looks like a token account or program address, not a wallet. Paste a Solana wallet address.");
        if (dest.equals(owner)) bad("That's your own fomo wallet. Paste the address you want to send to.");
        await needSol(owner);
        const acc = await rpc.getParsedAccountInfo(m);
        const decimals = (acc.value?.data as any)?.parsed?.info?.decimals ?? bad("unknown mint");
        const prog = acc.value!.owner; // Token or Token-2022
        const from = getAssociatedTokenAddressSync(m, owner, false, prog);
        const toAta = getAssociatedTokenAddressSync(m, dest, true, prog);
        const { blockhash } = await rpc.getLatestBlockhash();
        return toTx(owner, blockhash, [
          createAssociatedTokenAccountIdempotentInstruction(owner, toAta, dest, m, prog),
          createTransferCheckedInstruction(from, m, toAta, owner, BigInt(rawAmount(amount)), decimals, [], prog),
        ]);
      }),
    },

    "/api/u/:username": h(async (req) => {
      const [u] = await sql`select id, username, wallet, created_at from users where username = ${req.params.username}`;
      if (!u) bad("no such user", 404);
      const [followers, following, trades, sums] = await Promise.all([
        sql`select u.username from follows f join users u on u.id = f.follower where f.followee = ${u.id}`,
        sql`select u.username from follows f join users u on u.id = f.followee where f.follower = ${u.id}`,
        sql`select sig, mint, kind, amount, usdc, ts from trades where user_id = ${u.id} order by ts desc limit 100`,
        sql`select mint, sum(amount) as amount, sum(usdc) as usdc, bool_or(kind = 'buy') as bought from trades where user_id = ${u.id} group by mint`,
      ]);
      const info = await tokenInfo([...new Set([...trades, ...sums].map((r: any) => r.mint as string))]);
      // Anyone can airdrop junk tokens into a wallet. Hide unverified tokens the user never bought themselves.
      const bought = new Set((sums as any[]).filter((s) => s.bought).map((s) => s.mint));
      const spam = (mint: string) => mint !== USDC && !info[mint]?.verified && !bought.has(mint);
      let cash = 0;
      const holdings = [];
      for (const s of (sums as any[]).filter((s) => !spam(s.mint))) {
        cash += Number(s.usdc) + (s.mint === USDC ? Number(s.amount) : 0);
        if (s.mint === USDC) continue;
        const t = info[s.mint] ?? {};
        const value = Number(s.amount) * (t.price ?? 0);
        // pnl = what it's worth now + net USDC in/out on this token (deposits count as free)
        holdings.push({ mint: s.mint, ...t, amount: s.amount, value, pnl: value + Number(s.usdc) });
      }
      const { id: _privyId, ...publicUser } = u; // the Privy id is an account identifier; keep it private
      return {
        user: publicUser, cash,
        followers: followers.map((r: any) => r.username),
        following: following.map((r: any) => r.username),
        holdings: holdings.sort((a, b) => b.value - a.value),
        trades: trades.filter((t: any) => !spam(t.mint)).map((t: any) => ({ ...t, ...info[t.mint] })),
      };
    }),

    "/api/follow/:username": {
      POST: h(async (req) => {
        const u = await me(req);
        const r = await sql`insert into follows select ${u.id}, id from users where username = ${req.params.username} and id <> ${u.id} on conflict do nothing returning followee`;
        return { ok: true, changed: r.length };
      }),
      DELETE: h(async (req) => {
        const u = await me(req);
        await sql`delete from follows where follower = ${u.id} and followee = (select id from users where username = ${req.params.username})`;
        return { ok: true };
      }),
    },

    // trades by people I follow; frontend polls this
    "/api/alerts": h(async (req) => {
      const u = await me(req);
      const rows = await sql`
        select t.sig, t.mint, t.kind, t.amount, t.usdc, t.ts, u.username
        from trades t join follows f on f.followee = t.user_id join users u on u.id = t.user_id
        where f.follower = ${u.id} and t.kind in ('buy', 'sell')
        order by t.ts desc limit 50`;
      const info = await tokenInfo([...new Set<string>(rows.map((r: any) => r.mint))]);
      return rows.map((r: any) => ({ ...r, ...info[r.mint] }));
    }),
  },
  // serves the built frontend (bun run build) so prod is one process on one port
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/api/")) return Response.json({ error: "not found" }, { status: 404 });
    const file = Bun.file(DIST + (path.includes("..") ? "/index.html" : path));
    return new Response((await file.exists()) && path !== "/" ? file : Bun.file(DIST + "/index.html"));
  },
});

console.log(`api on :${server.port}`);
