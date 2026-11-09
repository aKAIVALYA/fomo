import { SQL } from "bun";
import { ComputeBudgetProgram, Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

// ponytail: prepared statements off so the local PGlite dev DB (one shared session) works; turn back on for prod Postgres if query latency matters
// DB_POOL_MAX=1 for the local PGlite DB: it has one session, so parallel connections cross wires
export const sql = new SQL({ url: process.env.DATABASE_URL, prepare: false, max: Number(process.env.DB_POOL_MAX ?? 10) });

// Idempotent table setup, one statement at a time (older Bun drops the connection on multi-statement queries)
export async function migrate() {
  const text = await Bun.file(import.meta.dir + "/schema.sql").text();
  for (let attempt = 1; ; attempt++) {
    try {
      for (const stmt of text.replace(/--.*$/gm, "").split(";")) if (stmt.trim()) await sql.unsafe(stmt);
      return;
    } catch (e: any) {
      if (attempt >= 10) throw e;
      console.error(`db not ready (${e.message}), retrying…`);
      await Bun.sleep(1000);
    }
  }
}

export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const rpc = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");

// Every chain we trade on. USDC on any of them counts as one cash balance.
// To add an EVM chain: one row here + one in web/main.tsx CHAINS (id = Relay chain id, gecko = GeckoTerminal network).
export const CHAINS: Record<string, { id: number; usdc: string; gecko: string; rpc?: string }> = {
  solana: { id: 792703809, usdc: USDC, gecko: "solana" },
  base: { id: 8453, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", gecko: "base", rpc: process.env.BASE_RPC_URL ?? "https://mainnet.base.org" },
};
export const isEvm = (chain: string) => chain !== "solana";

// ---------- gasless (Solana) ----------
// Jupiter makes the trader pay rent for new token accounts. Point those at our sponsor wallet instead,
// so a wallet with zero SOL can trade. Returns the accounts being created (caller checks which are new).
export function fundAtaCreates(ixs: TransactionInstruction[], sponsor: PublicKey): PublicKey[] {
  const made: PublicKey[] = [];
  for (const ix of ixs) {
    // data: [] or [0] = Create, [1] = CreateIdempotent; [2] = RecoverNested has a different account layout
    if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || (ix.data[0] ?? 0) > 1) continue;
    ix.keys[0] = { pubkey: sponsor, isSigner: true, isWritable: true };
    made.push(ix.keys[1].pubkey);
  }
  return made;
}

// The sponsor pays the priority fee, so a quote can't be allowed to set an unbounded one.
export function capPriorityFee(ixs: TransactionInstruction[], maxMicroLamports: bigint): TransactionInstruction[] {
  return ixs.map((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3 && ix.data.readBigUInt64LE(1) > maxMicroLamports
      ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: maxMicroLamports })
      : ix);
}

// ---------- EVM ----------
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
// calldata for ERC-20 transfer(to, amount) / balanceOf(owner)
export const erc20Transfer = (to: string, raw: bigint) => "0xa9059cbb" + word(to) + word(raw.toString(16));
export const erc20BalanceOf = (owner: string) => "0x70a08231" + word(owner);

// raw base units -> exact decimal string (no float rounding on money)
export function toDecimal(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

// Signup proof: the wallet signs this exact text (web/main.tsx builds the same string)
export const signupMessage = (id: string) => `Sign in to fomo as ${id}`;
export async function ownsWallet(wallet: PublicKey, id: string, signatureB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(wallet.toBytes()), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, Uint8Array.from(Buffer.from(signatureB64, "base64")), new TextEncoder().encode(signupMessage(id)));
  } catch { return false; }
}

// In-memory TTL cache: concurrent callers share one upstream request, and if upstream fails
// we keep serving the last good value instead of an error.
const cache = new Map<string, { at: number; val?: unknown; p?: Promise<unknown> }>();
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c?.val !== undefined && Date.now() - c.at < ttlMs) return Promise.resolve(c.val as T);
  if (c?.p) return c.p as Promise<T>;
  if (cache.size > 5000) cache.clear(); // ponytail: crude bound on memory; use an LRU if this ever matters
  const p = fn().then(
    (val) => { cache.set(key, { at: Date.now(), val }); return val; },
    (e) => { if (c?.val !== undefined) { cache.set(key, { at: c.at, val: c.val }); return c.val as T; } cache.delete(key); throw e; },
  );
  cache.set(key, { at: c?.at ?? 0, val: c?.val, p });
  return p;
}
