import test from "node:test";
import assert from "node:assert/strict";

import { base58Decode, isSolanaAddress } from "../lib/solana.js";
import { extractAddresses, normaliseAddress, stripUrls } from "./address.js";

test("base58 is decoded, not pattern-matched", () => {
  // Real calls. 1092 and 1219 are 43 characters; a length check alone would
  // have to accept the whole 32-44 band to keep them.
  assert.ok(isSolanaAddress("H6SmCqCHrXGfYrCT5tcyVJ8eY6AYvcKvFKjRPGe5Rji"));
  assert.ok(isSolanaAddress("jvRVFLX93oxBSvrrrDgfL6rdR5GWcLTFfcVYkNNvTcz"));
  assert.ok(isSolanaAddress("FkZL1HP8EqZStvyx5myGw7SW2SiCyWbWQVhMNrhjAh8E"));

  // In the 32-44 band and pure base58, but decodes to 31 and 33 bytes.
  assert.equal(base58Decode("1111111111111111111111111111111")!.length, 31);
  assert.ok(!isSolanaAddress("1111111111111111111111111111111"));
  assert.equal(base58Decode("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")!.length, 33);
  assert.ok(!isSolanaAddress("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));

  // A transaction signature decodes to 64 bytes and cannot be mistaken for one.
  assert.ok(!isSolanaAddress("5".repeat(88)));
});

test("EVM addresses are found — both channels post them", () => {
  // <private-channel> 1279, posted bare, i.e. as a call.
  const alphas = extractAddresses("0x8fb94c4a78b487c64ec2eb0f2559415f8e203d45");
  assert.deepEqual(alphas, [
    { address: "0x8fb94c4a78b487c64ec2eb0f2559415f8e203d45", chain: "EVM", index: 0 },
  ]);

  // AlphaDesJurix 7550, HyperEVM, checksummed mixed case.
  const jurix = extractAddresses("Good narrative on HyperEVM, $TESTICLES. I aped smol.\n\n0x3155fAAf0e4453229C3dcb3C70fdBF78113219fB");
  assert.equal(jurix.length, 1);
  assert.equal(jurix[0]!.chain, "EVM");
});

test("EVM comparison is case-insensitive, Solana's is not", () => {
  assert.equal(
    normaliseAddress("0x3155fAAf0e4453229C3dcb3C70fdBF78113219fB", "EVM"),
    "0x3155faaf0e4453229c3dcb3c70fdbf78113219fb",
  );
  assert.equal(
    normaliseAddress("FkZL1HP8EqZStvyx5myGw7SW2SiCyWbWQVhMNrhjAh8E", "SOLANA"),
    "FkZL1HP8EqZStvyx5myGw7SW2SiCyWbWQVhMNrhjAh8E",
  );
});

test("an address inside a link is not an address we act on", () => {
  // AlphaDesJurix 7667 — a follow-up linking the token, an hour after the call.
  const text =
    "Saw it was about to get listed on Coin boom.\n\nhttps://coinboom.net/solana/A7762oSxd5gddMdufC91C52C2T8cFwBjQf8fcVDEpump";
  assert.deepEqual(extractAddresses(text), []);
  // Offsets still line up, because URLs are blanked rather than removed.
  assert.equal(stripUrls(text).length, text.length);
});

test("mixed chains in one message come back in order of appearance", () => {
  const found = extractAddresses(
    "0x848ef30db9c6a60f1ea6562e7779c2436e6ec98f then FkZL1HP8EqZStvyx5myGw7SW2SiCyWbWQVhMNrhjAh8E",
  );
  assert.deepEqual(found.map((f) => f.chain), ["EVM", "SOLANA"]);
});
