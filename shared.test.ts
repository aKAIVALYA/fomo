import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
process.env.SOLANA_RPC_URL ??= "http://localhost:8899";
const { ownsWallet, signupMessage } = await import("./shared");

test("signup proof: only the wallet's own signature over this user's message passes", async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const wallet = new PublicKey(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (msg: string) =>
    Buffer.from(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg))).toString("base64");

  const sig = await sign(signupMessage("did:privy:alice"));
  expect(await ownsWallet(wallet, "did:privy:alice", sig)).toBe(true);
  expect(await ownsWallet(wallet, "did:privy:mallory", sig)).toBe(false); // replayed by another user
  expect(await ownsWallet(new PublicKey("So11111111111111111111111111111111111111112"), "did:privy:alice", sig)).toBe(false); // claims a wallet it doesn't own
  expect(await ownsWallet(wallet, "did:privy:alice", "garbage")).toBe(false);
});

test("cached: shares one upstream call, respects TTL, serves stale value when upstream fails", async () => {
  const { cached } = await import("./shared");
  let calls = 0;
  const ok = () => { calls++; return Promise.resolve(calls); };
  const [a, b] = await Promise.all([cached("k", 50, ok), cached("k", 50, ok)]);
  expect([a, b, calls]).toEqual([1, 1, 1]);                 // concurrent callers deduped
  expect(await cached("k", 50, ok)).toBe(1);                // fresh: no new call
  await Bun.sleep(60);
  expect(await cached<number>("k", 50, () => Promise.reject(new Error("429")))).toBe(1); // stale beats an error
  expect(await cached("k", 50, ok)).toBe(2);                // next call retries upstream
  await expect(cached("never", 50, () => Promise.reject(new Error("down")))).rejects.toThrow("down"); // nothing cached: real error
});
