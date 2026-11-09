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

// ---------- gasless + EVM helpers ----------
import { ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
const { capPriorityFee, erc20BalanceOf, erc20Transfer, fundAtaCreates } = await import("./shared");

test("fundAtaCreates makes the sponsor pay rent, and touches nothing else", () => {
  const [user, sponsor, ata, mint] = [1, 2, 3, 4].map(() => Keypair.generate().publicKey);
  const create = createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint);
  const transfer = createTransferCheckedInstruction(ata, mint, ata, user, 5n, 6);
  const before = JSON.stringify(transfer.keys);
  expect(fundAtaCreates([create, transfer], sponsor).map(String)).toEqual([ata.toBase58()]);
  expect(create.keys[0]).toEqual({ pubkey: sponsor, isSigner: true, isWritable: true });
  expect(create.keys[2].pubkey.equals(user)).toBe(true); // still the user's account
  expect(JSON.stringify(transfer.keys)).toBe(before);
  // the user is no longer a signer of the create, so they can't be made to pay
  expect(create.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([sponsor.toBase58()]);
});

test("capPriorityFee clamps only prices above the cap", () => {
  const price = (n: bigint) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: n });
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const out = capPriorityFee([limit, price(5_000_000n), price(10n)], 300_000n);
  expect(out[0]).toBe(limit);
  expect(out[1].data.readBigUInt64LE(1)).toBe(300_000n);
  expect(out[2].data.readBigUInt64LE(1)).toBe(10n);
});

test("erc20 calldata", () => {
  const to = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  expect(erc20Transfer(to, 5_000_000n)).toBe("0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045" + "4c4b40".padStart(64, "0"));
  expect(erc20BalanceOf(to)).toBe("0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045");
});
