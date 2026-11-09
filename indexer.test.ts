import { expect, test } from "bun:test";
process.env.SOLANA_RPC_URL ??= "http://localhost:8899";
const { parse } = await import("./indexer");
const { toDecimal, USDC } = await import("./shared");

const W = "Wa11et";
const BONK = "Bonk";
const bal = (mint: string, amount: string, decimals: number, owner = W) => ({ mint, owner, uiTokenAmount: { amount, decimals } });
const tx = (pre: any[], post: any[], err: any = null) => ({ meta: { err, preTokenBalances: pre, postTokenBalances: post } }) as any;

test("toDecimal", () => {
  expect(toDecimal(1_500_000n, 6)).toBe("1.5");
  expect(toDecimal(-5n, 6)).toBe("-0.000005");
  expect(toDecimal(42n, 0)).toBe("42");
});

test("buy: USDC down, token up (new ATA has no pre balance)", () => {
  expect(parse(tx([bal(USDC, "10000000", 6)], [bal(USDC, "0", 6), bal(BONK, "123450", 5)]), W))
    .toEqual([{ mint: BONK, kind: "buy", amount: "1.2345", usdc: "-10" }]);
});

test("sell: token down, USDC up", () => {
  expect(parse(tx([bal(USDC, "0", 6), bal(BONK, "100000", 5)], [bal(USDC, "2500000", 6), bal(BONK, "0", 5)]), W))
    .toEqual([{ mint: BONK, kind: "sell", amount: "-1", usdc: "2.5" }]);
});

test("USDC deposit, token withdraw, other owners ignored, failed tx ignored", () => {
  expect(parse(tx([bal(USDC, "1", 6, "someone")], [bal(USDC, "5000000", 6)]), W)).toEqual([{ mint: USDC, kind: "deposit", amount: "5", usdc: "0" }]);
  expect(parse(tx([bal(BONK, "100000", 5)], [bal(BONK, "40000", 5)]), W)).toEqual([{ mint: BONK, kind: "withdraw", amount: "-0.6", usdc: "0" }]);
  expect(parse(tx([bal(USDC, "0", 6)], [bal(USDC, "9", 6)], { err: 1 }), W)).toEqual([]);
});
