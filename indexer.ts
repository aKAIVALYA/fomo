import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { USDC, migrate, rpc, sql, toDecimal } from "./shared";

export type Row = { mint: string; kind: "buy" | "sell" | "deposit" | "withdraw"; amount: string; usdc: string };

// Turn one tx into trade rows for `owner` from token balance deltas.
// USDC + token moving opposite ways = buy/sell; anything else = deposit/withdraw.
export function parse(tx: ParsedTransactionWithMeta, owner: string): Row[] {
  if (!tx.meta || tx.meta.err) return [];
  const delta = new Map<string, { raw: bigint; dec: number }>();
  const add = (bals: typeof tx.meta.preTokenBalances, sign: bigint) => {
    for (const b of bals ?? []) {
      if (b.owner !== owner) continue;
      const d = delta.get(b.mint) ?? { raw: 0n, dec: b.uiTokenAmount.decimals };
      d.raw += sign * BigInt(b.uiTokenAmount.amount);
      delta.set(b.mint, d);
    }
  };
  add(tx.meta.preTokenBalances, -1n);
  add(tx.meta.postTokenBalances, 1n);
  for (const [m, d] of delta) if (d.raw === 0n) delta.delete(m);

  const u = delta.get(USDC);
  const others = [...delta].filter(([m]) => m !== USDC);
  const transfer = (mint: string, raw: bigint, dec: number): Row =>
    ({ mint, kind: raw > 0n ? "deposit" : "withdraw", amount: toDecimal(raw, dec), usdc: "0" });

  if (!others.length) return u ? [transfer(USDC, u.raw, u.dec)] : [];
  return others.map(([mint, d]) =>
    others.length === 1 && u && (u.raw > 0n) !== (d.raw > 0n)
      ? { mint, kind: d.raw > 0n ? "buy" : "sell", amount: toDecimal(d.raw, d.dec), usdc: toDecimal(u.raw, u.dec) }
      : transfer(mint, d.raw, d.dec));
}

// Incoming SPL transfers only touch the token account, not the wallet, so watch both.
async function addressesOf(wallet: PublicKey): Promise<string[]> {
  const accs = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => rpc.getTokenAccountsByOwner(wallet, { programId })));
  return [wallet.toBase58(), ...accs.flatMap((a) => a.value.map((v) => v.pubkey.toBase58()))];
}

async function indexUser(u: { id: string; wallet: string }) {
  for (const address of await addressesOf(new PublicKey(u.wallet))) {
    const [c] = await sql`select last_sig from cursors where address = ${address}`;
    // page back to the cursor; one page is only 1000 sigs and anything beyond it would be skipped forever
    const sigs = [];
    for (let before: string | undefined; ;) {
      const page = await rpc.getSignaturesForAddress(new PublicKey(address), { until: c?.last_sig, before, limit: 1000 });
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page.at(-1)!.signature;
    }
    let last: string | undefined;
    for (const s of sigs.reverse()) { // oldest first
      if (!s.err) {
        const tx = await rpc.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) break; // RPC hasn't caught up yet: stop here and retry from this tx next pass, don't skip it
        const ts = new Date((tx.blockTime ?? Date.now() / 1000) * 1000);
        for (const r of parse(tx, u.wallet)) {
          await sql`insert into trades (sig, mint, user_id, kind, amount, usdc, ts)
                    values (${s.signature}, ${r.mint}, ${u.id}, ${r.kind}, ${r.amount}, ${r.usdc}, ${ts})
                    on conflict do nothing`;
        }
      }
      last = s.signature;
    }
    if (last) await sql`insert into cursors values (${address}, ${last}) on conflict (address) do update set last_sig = ${last}`;
  }
}

// What to do with a pending Relay order. Only `success` and `refund` are final; `failure` can still be retried or refunded.
// After an hour a non-final order is dropped: almost always a quote the user never signed.
export const settleAction = (status: string, ageMs: number): "trade" | "drop" | "wait" =>
  status === "success" ? "trade" : status === "refund" || ageMs > 3_600_000 ? "drop" : "wait";

// Relay orders (EVM + cross-chain) can't be read off Solana balance deltas, so api.ts records them as `pending`
// and this turns each one into a trade once Relay says it filled.
export async function settle() {
  const headers: Record<string, string> = process.env.RELAY_API_KEY ? { "x-api-key": process.env.RELAY_API_KEY } : {};
  for (const p of await sql`select * from pending`) {
    const s: any = await fetch(`https://api.relay.link/intents/status/v3?requestId=${p.request_id}`, { headers, signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    const action = settleAction(s.status, Date.now() - new Date(p.created_at).getTime());
    if (action === "wait") continue;
    if (action === "trade") {
      // sig = the tx on the token's chain (the fill for buys, the user's own tx for sells); via = the other side
      const [sig, via] = p.kind === "buy" ? [s.txHashes?.[0], s.inTxHashes?.[0]] : [s.inTxHashes?.[0], s.txHashes?.[0]];
      if (!sig) continue; // hashes are appended shortly after success
      // A fill that lands on Solana is also seen by indexUser as a plain deposit; whichever writes first, it ends up a buy.
      await sql`insert into trades (sig, mint, user_id, kind, amount, usdc, ts, chain, via)
                values (${sig}, ${p.mint}, ${p.user_id}, ${p.kind}, ${p.amount}, ${p.usdc}, ${new Date()}, ${p.chain}, ${via && via !== sig ? via : null})
                on conflict (sig, mint, user_id) do update set kind = excluded.kind, usdc = excluded.usdc, via = excluded.via`;
    }
    await sql`delete from pending where request_id = ${p.request_id}`;
  }
}

// ponytail: polls every user's addresses sequentially; switch to Helius webhooks / Geyser when users × RPC calls hurts
export async function runIndexer() {
  console.log("indexer running");
  while (true) {
    try {
      for (const u of await sql`select id, wallet from users`) {
        await indexUser(u as any).catch((e) => console.error(u.wallet, e.message));
      }
    } catch (e: any) { console.error("db:", e.message); }
    await settle().catch((e) => console.error("settle:", e.message));
    await Bun.sleep(5000);
  }
}

if (import.meta.main) {
  await migrate();
  await runIndexer();
}
