import { SQL } from "bun";
import { Connection, PublicKey } from "@solana/web3.js";

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
