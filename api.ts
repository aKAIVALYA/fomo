import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { verifyMessage } from "viem";
import {
  CHAINS, USDC, cached, capPriorityFee, erc20BalanceOf, erc20Transfer, fundAtaCreates, isEvm, migrate, ownsWallet, rpc,
  signupMessage, sql, toDecimal,
} from "./shared";
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

// ---------- gasless ----------
// Solana: this wallet pays network fees and token-account rent, so users never need SOL. Unset = users pay their own gas.
// It only ever signs transactions built right here, never anything a client sends in. Keep a small SOL float in it.
const SPONSOR = env.SPONSOR_KEY ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.SPONSOR_KEY))) : null;
const SPONSOR_ATA = SPONSOR && getAssociatedTokenAddressSync(new PublicKey(USDC), SPONSOR.publicKey);
let sponsorAtaReady = false; // until we've seen it on-chain, charges also create it
// EVM: Privy sponsors gas (dashboard → Fee sponsorship). The browser passes sponsor:true when this is on.
const EVM_GASLESS = env.EVM_GASLESS === "on";
const WSOL = "So11111111111111111111111111111111111111112";
// Users can close a token account and pocket its rent, so free rent = free money. New accounts are repaid in USDC instead.
const RENT_SOL = 0.0021; // one token account (0.00204 SOL) + a little margin
const MAX_PRIORITY = 300_000n; // micro-lamports per compute unit; ≈0.00018 SOL at our 600k limit
if (SPONSOR) console.log(`gasless on, sponsor wallet ${SPONSOR.publicKey.toBase58()}`);
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

async function getJson(url: string, headers: Record<string, string> = {}, body?: unknown) {
  const host = new URL(url).host;
  const r = await fetch(url, {
    headers: body ? { ...headers, "content-type": "application/json" } : headers, signal: AbortSignal.timeout(10_000),
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  }).catch(() => bad(`${host} is unreachable right now, try again shortly`, 502));
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 429) bad(`${host} is rate-limiting us, try again in a minute`, 503);
  if (!r.ok) bad(j.error ?? j.message ?? `${host} returned ${r.status}`, 502);
  return j;
}

const jup = (path: string) => getJson(env.JUPITER_API_URL + path, { "x-api-key": env.JUPITER_API_KEY });
// Relay does every swap that isn't Solana→Solana: EVM swaps and cross-chain. The key is optional (higher rate limits).
const relay = (path: string, body?: unknown) =>
  getJson("https://api.relay.link" + path, env.RELAY_API_KEY ? { "x-api-key": env.RELAY_API_KEY } : {}, body);

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
const evmAddr = (s: unknown) => /^0x[0-9a-fA-F]{40}$/.test(String(s)) ? String(s).toLowerCase() : bad(`bad address: ${s}`);
const chainOf = (s: unknown) => (typeof s === "string" && Object.hasOwn(CHAINS, s) ? s : bad("unknown chain"));
const tokenAddr = (chain: string, s: unknown) => (isEvm(chain) ? evmAddr(s) : pubkey(s).toBase58());
const rawAmount = (s: unknown) => /^[1-9]\d*$/.test(String(s)) ? String(s) : bad("amount must be a positive integer in base units");

const geckoToken = (t: any) => ({
  symbol: t.symbol, name: t.name, icon: t.image_url?.startsWith("http") ? t.image_url : undefined, decimals: t.decimals,
  verified: !!t.coingecko_coin_id, // no Jupiter-style verification on EVM; a CoinGecko listing is the closest signal
});

// symbol/icon/price for a set of tokens on one chain, keyed by mint
async function tokenInfo(chain: string, mints: string[]): Promise<Record<string, any>> {
  if (!mints.length) return {};
  // ponytail: one call per chain (Jupiter: 100 mints, GeckoTerminal: 30); chunk if a portfolio ever exceeds that
  // degrade to bare mints if the price source is down rather than failing the whole profile
  if (isEvm(chain)) {
    const key = [...mints].sort().slice(0, 30).join(",");
    const list: any[] = await cached(`info:${chain}:${key}`, 30_000, async () => (await gecko(`/networks/${CHAINS[chain].gecko}/tokens/multi/${key}`)).data).catch(() => []);
    return Object.fromEntries(list.map(({ attributes: t }) => [t.address, { ...geckoToken(t), price: Number(t.price_usd) || undefined }]));
  }
  const key = [...mints].sort().slice(0, 100).join(",");
  const list: any[] = await cached(`info:${key}`, 30_000, () => jup(`/tokens/v2/search?query=${key}`)).catch(() => []);
  return Object.fromEntries(list.map((t) => [t.id, { symbol: t.symbol, icon: t.icon, price: t.usdPrice, decimals: t.decimals, verified: !!t.isVerified }]));
}

// same, for rows spanning chains; keyed by tokenKey(row)
const tokenKey = (r: { chain: string; mint: string }) => `${r.chain}:${r.mint}`;
async function infoFor(rows: { chain: string; mint: string }[]): Promise<Record<string, any>> {
  const by: Record<string, Set<string>> = {};
  for (const r of rows) (by[r.chain] ??= new Set()).add(r.mint);
  const out: Record<string, any> = {};
  await Promise.all(Object.entries(by).map(async ([chain, mints]) => {
    for (const [mint, t] of Object.entries(await tokenInfo(chain, [...mints]))) out[`${chain}:${mint}`] = t;
  }));
  return out;
}

// Trending or searched tokens on an EVM chain, in the same shape as the Solana list
async function evmTokens(chain: string, q: string) {
  const net = CHAINS[chain].gecko;
  const r = await cached(`evm:${chain}:${q.toLowerCase()}`, 60_000, () =>
    gecko(q ? `/search/pools?query=${encodeURIComponent(q)}&network=${net}&include=base_token` : `/networks/${net}/trending_pools?include=base_token`));
  const tokens = new Map<string, any>((r.included ?? []).map((t: any) => [t.id, t.attributes]));
  const seen = new Set<string>();
  const list = [];
  for (const { attributes: p, relationships } of r.data ?? []) {
    const t = tokens.get(relationships.base_token.data.id);
    if (!t || t.decimals == null || seen.has(t.address) || t.address === CHAINS[chain].usdc) continue; // first pool per token = its biggest
    seen.add(t.address);
    list.push({
      id: t.address, chain, ...geckoToken(t), usdPrice: Number(p.base_token_price_usd) || undefined,
      stats24h: { priceChange: Number(p.price_change_percentage?.h24) || 0 }, liquidity: Number(p.reserve_in_usd) || 0,
      freezable: false, mintable: false,
    });
  }
  return q ? list : list.filter((t) => t.verified);
}

// ---------- unified balance ----------
async function evmRpc(chain: string, method: string, params: unknown[]): Promise<string> {
  const j = await getJson(CHAINS[chain].rpc!, {}, { jsonrpc: "2.0", id: 1, method, params });
  return j.result ?? bad(`${chain} RPC error: ${j.error?.message ?? "no result"}`, 502);
}

// Raw USDC per chain. The user's cash is the sum: they never pick a chain to pay from.
type User = { id: string; username: string; wallet: string; evm_wallet: string | null };
const cash = (u: User): Promise<Record<string, bigint>> => cached(`cash:${u.id}:${u.evm_wallet}`, 5_000, async () =>
  Object.fromEntries(await Promise.all(Object.entries(CHAINS).map(async ([name, c]) => {
    if (!isEvm(name)) {
      const accs = await rpc.getParsedTokenAccountsByOwner(new PublicKey(u.wallet), { mint: new PublicKey(c.usdc) });
      return [name, accs.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n)] as const;
    }
    return [name, u.evm_wallet ? BigInt(await evmRpc(name, "eth_call", [{ to: c.usdc, data: erc20BalanceOf(u.evm_wallet) }, "latest"])) : 0n] as const;
  }))));
const total = (bal: Record<string, bigint>) => Object.values(bal).reduce((a, b) => a + b, 0n);
const cashJson = (bal: Record<string, bigint>) => ({
  cash: Number(toDecimal(total(bal), 6)), // USDC has 6 decimals on every chain here
  cashBy: Object.fromEntries(Object.entries(bal).map(([c, raw]) => [c, toDecimal(raw, 6)])),
});
const usdStr = (raw: bigint) => "$" + Number(toDecimal(raw, 6)).toFixed(2);

// A wallet with no SOL can't pay network fees; say so up front instead of failing inside the wallet.
async function needSol(wallet: PublicKey) {
  const lamports = await rpc.getBalance(wallet).catch(() => Infinity); // RPC hiccup: let the wallet's own simulation decide
  if (lamports < MIN_SOL * 1e9) bad(`Your wallet needs about ${MIN_SOL} SOL for network fees. Send a little SOL to ${wallet.toBase58()} and try again.`, 402);
}

function toTx(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[] = []) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  return { tx: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64") };
}

// Jupiter sends `accounts` + base64 data, Relay sends `keys` + hex data
const toIx = (i: any) => new TransactionInstruction({
  programId: new PublicKey(i.programId),
  keys: (i.accounts ?? i.keys).map((a: any) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(i.data, i.accounts ? "base64" : "hex"),
});

// ponytail: in-memory, so it resets on restart and isn't shared across instances; move to Postgres if we run more than one api
const sponsoredAt = new Map<string, number[]>();
function rateLimit(id: string) {
  const recent = (sponsoredAt.get(id) ?? []).filter((t) => t > Date.now() - 3_600_000);
  if (recent.length >= 60) bad("That's a lot of transactions in one hour. Try again a little later.", 429);
  sponsoredAt.set(id, [...recent, Date.now()]);
}

// USDC the user repays for token accounts this tx opens on the sponsor's SOL (0 if none are new, or we aren't sponsoring)
async function sponsorFee(ixs: TransactionInstruction[]): Promise<bigint> {
  if (!SPONSOR) return 0n;
  const made = [...new Set(fundAtaCreates(ixs, SPONSOR.publicKey).map((a) => a.toBase58()))];
  if (!made.length) return 0n;
  const fresh = (await rpc.getMultipleAccountsInfo(made.map((a) => new PublicKey(a)))).filter((a) => !a).length;
  if (!fresh) return 0n;
  const sol = (await tokenInfo("solana", [WSOL]))[WSOL]?.price ?? bad("Can't price network costs right now, try again shortly", 503);
  return BigInt(Math.ceil(fresh * RENT_SOL * sol * 1e6));
}

// Final Solana tx for the user to sign. Gasless when a sponsor is set: the sponsor is fee payer and signs first
// (a user handed an unsigned tx could rewrite it to drain the sponsor), and `fee` USDC goes back to it.
async function solTx(u: User, blockhash: string, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[] = [], fee = 0n) {
  const owner = pubkey(u.wallet);
  if (!SPONSOR) { await needSol(owner); return toTx(owner, blockhash, ixs, alts); }
  rateLimit(u.id);
  fundAtaCreates(ixs, SPONSOR.publicKey);
  ixs = capPriorityFee(ixs, MAX_PRIORITY);
  if (fee) {
    sponsorAtaReady ||= !!(await rpc.getAccountInfo(SPONSOR_ATA!).catch(() => null));
    if (!sponsorAtaReady) ixs.push(createAssociatedTokenAccountIdempotentInstruction(SPONSOR.publicKey, SPONSOR_ATA!, SPONSOR.publicKey, new PublicKey(USDC)));
    ixs.push(createTransferCheckedInstruction(getAssociatedTokenAddressSync(new PublicKey(USDC), owner), new PublicKey(USDC), SPONSOR_ATA!, owner, fee, 6));
  }
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: SPONSOR.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts));
  tx.sign([SPONSOR]);
  try { return { tx: Buffer.from(tx.serialize()).toString("base64") }; }
  catch { return bad("This trade doesn't fit in one transaction. Try a different amount."); } // sponsor signature + repay push big routes over the size limit
}

// Any swap Jupiter can't do: EVM same-chain, or cross-chain in either direction. Returns a Solana tx or a list of EVM txs
// for the browser to sign, and leaves a `pending` row that the indexer settles into a trade.
type Leg = { chain: string; currency: string };
async function relaySwap(u: User, from: Leg, to: Leg, amount: string, kind: "buy" | "sell") {
  const addr = (chain: string) => (isEvm(chain) ? u.evm_wallet ?? bad("Your wallet for this chain is still being set up. Reload the page and try again.", 409) : u.wallet);
  const solOrigin = !isEvm(from.chain);
  if (!solOrigin && !EVM_GASLESS && BigInt(await evmRpc(from.chain, "eth_getBalance", [addr(from.chain), "latest"])) === 0n)
    bad(`Your ${from.chain} wallet needs a little ETH for network fees. Send some to ${addr(from.chain)} and try again.`, 402);
  const q = await relay("/quote/v2", {
    user: addr(from.chain), recipient: addr(to.chain),
    originChainId: CHAINS[from.chain].id, originCurrency: from.currency,
    destinationChainId: CHAINS[to.chain].id, destinationCurrency: to.currency,
    tradeType: "EXACT_INPUT", amount,
    ...(env.RELAY_FEE_WALLET && env.FEE_BPS && { appFees: [{ recipient: env.RELAY_FEE_WALLET, fee: env.FEE_BPS }] }),
    // Relay's own rule: never sponsor a same-chain Solana swap (drainable). We never send one here; Jupiter does those.
    ...(solOrigin && SPONSOR && { depositFeePayer: SPONSOR.publicKey.toBase58() }),
  });
  const items: any[] = q.steps.flatMap((s: any) => (s.kind === "transaction" ? s.items : bad("This route needs a signing step we don't support yet. Try another token or amount.")));
  const requestId: string = q.steps.find((s: any) => s.requestId)?.requestId ?? bad("Relay returned no order id", 502);
  const { currencyIn: i, currencyOut: o } = q.details;
  const token = kind === "buy" ? to : from;
  // ponytail: quoted amounts, not filled ones (they differ by slippage). Relay's /requests/v3 has exact fills but needs an API key.
  const [amt, usdc] = kind === "buy" ? [o.amountFormatted, "-" + i.amountFormatted] : ["-" + i.amountFormatted, o.amountFormatted];
  await sql`insert into pending (request_id, user_id, chain, mint, kind, amount, usdc)
            values (${requestId}, ${u.id}, ${token.chain}, ${token.currency}, ${kind}, ${amt}, ${usdc}) on conflict do nothing`;
  if (!solOrigin) return { evm: items.map(({ data: d }) => ({ to: d.to, data: d.data, value: d.value, chainId: d.chainId })) };
  const [{ blockhash }, alts] = await Promise.all([
    rpc.getLatestBlockhash(),
    Promise.all(items.flatMap((it) => it.data.addressLookupTableAddresses ?? []).map(async (a: string) =>
      (await rpc.getAddressLookupTable(new PublicKey(a))).value ?? bad("Solana RPC is behind, try again shortly", 502))),
  ]);
  return solTx(u, blockhash, items.flatMap((it) => it.data.instructions.map(toIx)), alts);
}

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

    // One EVM address covers every EVM chain. Same proof as signup: the wallet signs signupMessage(id).
    "/api/me/evm": {
      POST: h(async (req) => {
        const u = await me(req);
        const { wallet, signature } = await req.json();
        const address = evmAddr(wallet);
        if (!(await verifyMessage({ address: address as `0x${string}`, message: signupMessage(u.id), signature }).catch(() => false))) bad("wallet signature check failed", 401);
        return (await sql`update users set evm_wallet = ${address} where id = ${u.id} and evm_wallet is null returning *`)[0] ?? u;
      }),
    },

    "/api/config": h(async () => ({ gasless: !!SPONSOR, evmGasless: EVM_GASLESS })),
    "/api/balance": h(async (req) => cashJson(await cash(await me(req)))),

    // Default list: Jupiter-verified tokens only (the "blue chips"). Search can find anything; the UI warns on risky ones.
    "/api/tokens": h(async (req) => {
      const params = new URL(req.url).searchParams;
      const q = (params.get("q") ?? "").trim().slice(0, 64);
      const chain = chainOf(params.get("chain") ?? "solana");
      if (isEvm(chain)) return evmTokens(chain, q);
      const list: any[] = q
        ? await cached(`search:${q.toLowerCase()}`, 60_000, () => jup(`/tokens/v2/search?query=${encodeURIComponent(q)}`))
        : (await cached("top", 30_000, () => jup("/tokens/v2/toporganicscore/24h?limit=100"))).filter((t: any) => t.isVerified);
      return list.map((t) => ({
        id: t.id, chain, symbol: t.symbol, name: t.name, icon: t.icon, decimals: t.decimals, usdPrice: t.usdPrice,
        stats24h: { priceChange: t.stats24h?.priceChange }, liquidity: t.liquidity, verified: !!t.isVerified,
        freezable: !t.audit?.freezeAuthorityDisabled, mintable: !t.audit?.mintAuthorityDisabled,
      }));
    }),

    // [[ts, o, h, l, c, v], ...] newest first
    "/api/candles/:mint": h(async (req) => {
      const params = new URL(req.url).searchParams;
      const chain = chainOf(params.get("chain") ?? "solana");
      const [mint, net] = [tokenAddr(chain, req.params.mint), CHAINS[chain].gecko];
      const tf = params.get("tf") ?? "hour";
      if (!["minute", "hour", "day"].includes(tf)) bad("tf: minute|hour|day");
      const pool: string = await cached(`pool:${chain}:${mint}`, 86_400_000, async () =>
        (await gecko(`/networks/${net}/tokens/${mint}/pools?page=1`)).data?.[0]?.attributes?.address ?? bad("No trading pool found for this token", 404));
      const ttl = { minute: 30_000, hour: 300_000, day: 1_800_000 }[tf as "minute" | "hour" | "day"];
      return cached(`ohlcv:${chain}:${mint}:${tf}`, ttl, async () =>
        (await gecko(`/networks/${net}/pools/${pool}/ohlcv/${tf}?limit=200&currency=usd&token=${mint}`)).data.attributes.ohlcv_list);
    }),

    // returns { tx } (Solana) or { evm: [...] } for the user to sign + send with their Privy wallet
    "/api/swap": {
      POST: h(async (req) => {
        const u = await me(req);
        const body = await req.json();
        const { side } = body;
        const chain = chainOf(body.chain ?? "solana");
        const m = tokenAddr(chain, body.mint);
        let amount = rawAmount(body.amount);
        if (m === CHAINS[chain].usdc) bad("pick a token other than USDC");
        if (side !== "buy" && side !== "sell") bad("side: buy|sell");
        const usdc = (c: string): Leg => ({ chain: c, currency: CHAINS[c].usdc });
        // Sells settle to USDC on the token's own chain: cheapest and fastest, and it's all one balance anyway.
        if (side === "sell" && isEvm(chain)) return relaySwap(u, { chain, currency: m }, usdc(chain), amount, "sell");
        if (side === "buy") {
          // Unified balance: pay from the token's chain if it holds enough USDC, else from whichever chain does.
          // ponytail: one source chain per trade. Split a buy across chains if users keep hitting the "split" error.
          const [bal, need] = [await cash(u), BigInt(amount)];
          const rich = Object.keys(bal).sort((a, b) => (bal[b] > bal[a] ? 1 : -1))[0];
          const from = bal[chain] >= need ? chain : rich;
          if (bal[from] < need) bad(total(bal) >= need
            ? `Your USDC is spread across chains. The most you can spend in one trade is ${usdStr(bal[rich])}.`
            : `Not enough USDC. You have ${usdStr(total(bal))}.`, 402);
          if (isEvm(from) || isEvm(chain)) return relaySwap(u, usdc(from), { chain, currency: m }, amount, "buy");
        }
        const build = async (amt: string) => {
          const q = new URLSearchParams({
            inputMint: side === "buy" ? USDC : m,
            outputMint: side === "buy" ? m : USDC,
            amount: amt,
            taker: u.wallet,
            slippageBps: "50",
            ...(feeOn && { platformFeeBps: env.FEE_BPS, feeAccount: FEE_ATA }), // fee always in USDC: input on buys, output on sells
            wrapAndUnwrapSol: "false", // ponytail: SOL stays as wSOL so the indexer sees it as a token balance
            transactionVersion: "0",
          });
          const b = await jup(`/swap/v2/build?${q}`);
          return {
            alts: Object.entries(b.addressesByLookupTableAddress ?? {}).map(([key, addrs]) =>
              new AddressLookupTableAccount({
                key: new PublicKey(key),
                state: { addresses: (addrs as string[]).map((a) => new PublicKey(a)), deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 },
              })),
            ixs: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), // ponytail: fixed limit; simulate if swaps start failing on CU
              ...(b.computeBudgetInstructions ?? []), ...(b.setupInstructions ?? []),
              b.swapInstruction, b.cleanupInstruction, ...(b.otherInstructions ?? []),
            ].filter(Boolean).map((i) => (i instanceof TransactionInstruction ? i : toIx(i))),
            // Jupiter returns the blockhash as 32 raw bytes; PublicKey is just a base58 encoder here
            blockhash: new PublicKey(Uint8Array.from(b.blockhashWithMetadata.blockhash)).toBase58(),
          };
        };
        let b = await build(amount);
        const fee = await sponsorFee(b.ixs);
        // First buy of a token opens its account. That cost comes out of the amount, so the user still spends exactly what they typed.
        // (On sells it comes out of the USDC proceeds.)
        if (fee && side === "buy") {
          if (BigInt(amount) < fee * 2n) bad(`Your first buy of a token includes about ${usdStr(fee)} to open its account. Buy at least ${usdStr(fee * 2n)}.`);
          b = await build(String(BigInt(amount) - fee));
        }
        return solTx(u, b.blockhash, b.ixs, b.alts, fee);
      }),
    },

    "/api/withdraw": {
      POST: h(async (req) => {
        const u = await me(req);
        const { mint, amount, to, chain: c } = await req.json();
        const chain = chainOf(c ?? "solana");
        if (isEvm(chain)) {
          // ponytail: EVM withdrawals are USDC only (EVM holdings come from our own trades, so an untracked token transfer would skew them). Add an EVM transfer indexer to lift this.
          if (tokenAddr(chain, mint) !== CHAINS[chain].usdc) bad("Sell this token for USDC first, then withdraw the USDC.");
          const dest = evmAddr(to);
          if (dest === u.evm_wallet) bad("That's your own fomo wallet. Paste the address you want to send to.");
          if (/^0x0{40}$/.test(dest)) bad("That's the zero address. Funds sent there are lost.");
          return { evm: [{ to: CHAINS[chain].usdc, data: erc20Transfer(dest, BigInt(rawAmount(amount))), value: "0", chainId: CHAINS[chain].id }] };
        }
        const [m, dest, owner] = [pubkey(mint), pubkey(to), pubkey(u.wallet)];
        // Off-curve addresses are program accounts (token accounts, PDAs), not wallets; funds sent there are usually lost.
        if (!PublicKey.isOnCurve(dest.toBytes())) bad("That looks like a token account or program address, not a wallet. Paste a Solana wallet address.");
        if (dest.equals(owner)) bad("That's your own fomo wallet. Paste the address you want to send to.");
        const acc = await rpc.getParsedAccountInfo(m);
        const decimals = (acc.value?.data as any)?.parsed?.info?.decimals ?? bad("unknown mint");
        const prog = acc.value!.owner; // Token or Token-2022
        const from = getAssociatedTokenAddressSync(m, owner, false, prog);
        const toAta = getAssociatedTokenAddressSync(m, dest, true, prog);
        const create = createAssociatedTokenAccountIdempotentInstruction(owner, toAta, dest, m, prog);
        // Sponsored and the recipient has no account for this token yet: opening it is repaid in USDC.
        // For a USDC withdrawal it comes out of the amount; for other tokens the user needs that much USDC on Solana.
        const fee = await sponsorFee([create]);
        let send = BigInt(rawAmount(amount));
        if (fee && m.toBase58() === USDC) {
          if (send <= fee) bad(`Opening the recipient's USDC account costs about ${usdStr(fee)}. Withdraw more than that.`);
          send -= fee;
        } else if (fee && (await cash(u)).solana < fee) bad(`Opening the recipient's token account costs about ${usdStr(fee)} in USDC, and you don't have that on Solana.`, 402);
        const { blockhash } = await rpc.getLatestBlockhash();
        return solTx(u, blockhash, [create, createTransferCheckedInstruction(from, m, toAta, owner, send, decimals, [], prog)], [], fee);
      }),
    },

    "/api/u/:username": h(async (req) => {
      const [u] = await sql`select id, username, wallet, evm_wallet, created_at from users where username = ${req.params.username}`;
      if (!u) bad("no such user", 404);
      const [followers, following, trades, sums, bal] = await Promise.all([
        sql`select u.username from follows f join users u on u.id = f.follower where f.followee = ${u.id}`,
        sql`select u.username from follows f join users u on u.id = f.followee where f.follower = ${u.id}`,
        // a cross-chain buy also shows up as a plain USDC transfer on the paying chain; `via` hides that half
        sql`select sig, chain, mint, kind, amount, usdc, ts from trades t where user_id = ${u.id}
            and not exists (select 1 from trades x where x.via = t.sig and x.user_id = t.user_id) order by ts desc limit 100`,
        sql`select chain, mint, sum(amount) as amount, sum(usdc) as usdc, bool_or(kind = 'buy') as bought from trades where user_id = ${u.id} group by chain, mint`,
        cash(u as User).catch(() => null), // RPC down: the page still loads, cash shows as unknown
      ]);
      const info = await infoFor([...trades, ...sums] as any[]);
      const isUsdc = (r: any) => r.mint === CHAINS[r.chain]?.usdc;
      // Anyone can airdrop junk tokens into a wallet. Hide unverified tokens the user never bought themselves.
      const bought = new Set((sums as any[]).filter((s) => s.bought).map(tokenKey));
      const spam = (r: any) => !isUsdc(r) && !info[tokenKey(r)]?.verified && !bought.has(tokenKey(r));
      const holdings = [];
      for (const s of (sums as any[]).filter((s) => !spam(s) && !isUsdc(s))) { // USDC isn't a holding: cash is read live from each chain
        const t = info[tokenKey(s)] ?? {};
        const value = Number(s.amount) * (t.price ?? 0);
        // pnl = what it's worth now + net USDC in/out on this token (deposits count as free)
        holdings.push({ chain: s.chain, mint: s.mint, ...t, amount: s.amount, value, pnl: value + Number(s.usdc) });
      }
      const { id: _privyId, ...publicUser } = u; // the Privy id is an account identifier; keep it private
      return {
        user: publicUser, ...(bal ? cashJson(bal) : { cash: null, cashBy: {} }),
        followers: followers.map((r: any) => r.username),
        following: following.map((r: any) => r.username),
        holdings: holdings.sort((a, b) => b.value - a.value),
        trades: trades.filter((t: any) => !spam(t)).map((t: any) => ({ ...t, ...info[tokenKey(t)] })),
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
        select t.sig, t.chain, t.mint, t.kind, t.amount, t.usdc, t.ts, u.username
        from trades t join follows f on f.followee = t.user_id join users u on u.id = t.user_id
        where f.follower = ${u.id} and t.kind in ('buy', 'sell')
        order by t.ts desc limit 50`;
      const info = await infoFor(rows as any[]);
      return rows.map((r: any) => ({ ...r, ...info[tokenKey(r)] }));
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
