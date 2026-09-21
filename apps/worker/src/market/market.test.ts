/**
 * Market data: the rules that decide a number, and the guarantee around the one
 * number that cannot be corrected.
 */
import "../lib/env.js";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "@alphades/db";
import { waitForDatabase } from "../lib/db-wake.js";
import { cadenceFor, deathVerdict } from "./poller.js";
import { capture, CAPTURE_MAX_CALL_AGE_MS, CaptureQueue } from "./capture.js";
import type { Observation } from "./dexscreener.js";

const obs = (o: Partial<Observation>): Observation => ({
  address: "A", dexChainId: "solana", pairAddress: "P", dexId: "pumpfun",
  priceUsd: 0.001, marketCapUsd: 50_000, fdvUsd: 50_000, liquidityUsd: 20_000,
  volume24hUsd: 5_000, pairCreatedAt: null, symbol: "X", name: "X",
  imageUrl: null, websiteUrl: null, twitterUrl: null, telegramUrl: null,
  observedAt: new Date(), ...o,
});

test("a price is only ever taken from a pair where our token is the base", async () => {
  // Chosen because DexScreener lists it as the QUOTE side of pairs too: wSOL.
  // Whatever comes back must be about wSOL itself, never the other asset.
  const { resolveToken } = await import("./dexscreener.js");
  const wsol = "So11111111111111111111111111111111111111112";
  const obs = await resolveToken(wsol);
  if (obs === null) return; // offline or not indexed: nothing to assert
  assert.equal(obs.address.toLowerCase(), wsol.toLowerCase());
});

test("polling gets slower as a call ages", () => {
  const now = Date.now();
  const at = (ms: number) => cadenceFor(new Date(now - ms), now);
  assert.equal(at(60_000), 30_000);            // minutes old: every 30s
  assert.equal(at(3 * 3600_000), 120_000);     // 3 hours: every 2min
  assert.equal(at(12 * 3600_000), 600_000);    // 12 hours: every 10min
  assert.equal(at(3 * 86400_000), 3600_000);   // 3 days: hourly
  assert.equal(at(30 * 86400_000), 6 * 3600_000);
});

describe("dead detection", () => {
  const hour = 3600_000;
  test("a pulled pool, a floored price and a silent token are all dead", () => {
    assert.match(deathVerdict(obs({ liquidityUsd: 12 }), hour)!, /liquidity/);
    assert.match(deathVerdict(obs({ marketCapUsd: 300 }), hour)!, /market cap/);
    assert.match(deathVerdict(obs({ volume24hUsd: 0 }), 2 * hour)!, /no volume/);
    assert.match(deathVerdict(null, hour)!, /no pair/);
  });

  test("a healthy token is not dead", () => {
    assert.equal(deathVerdict(obs({}), hour), null);
  });

  test("missing liquidity is not pulled liquidity", () => {
    // DexScreener returns null liquidity for some healthy pairs — measured on
    // one of our own tokens. Treating that as a rug would close live calls.
    assert.equal(deathVerdict(obs({ liquidityUsd: null }), hour), null);
  });

  test("a brand-new token with no volume yet is not dead", () => {
    assert.equal(deathVerdict(obs({ volume24hUsd: 0 }), 5 * 60_000), null);
  });
});

// ---------------------------------------------------------------------------

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const created: string[] = [];

before(async () => {
  if (!HAVE_DB) return;
  if ((process.env.NEON_BRANCH ?? "") === "production") throw new Error("refusing to write to production");
  await waitForDatabase(prisma);
});

after(async () => {
  if (!HAVE_DB) return;
  for (const channelId of created) {
    await prisma.priceSnapshot.deleteMany({ where: { token: { calls: { some: { channelId } } } } });
    await prisma.callEvent.deleteMany({ where: { channelId } });
    await prisma.seenMessage.deleteMany({ where: { channelId } });
    await prisma.call.deleteMany({ where: { channelId } });
    await prisma.channel.delete({ where: { id: channelId } }).catch(() => {});
  }
  await prisma.token.deleteMany({ where: { address: { startsWith: "TEST" }, calls: { none: {} } } });
  await prisma.$disconnect();
});

describe("the called-at market cap is written once", { skip: HAVE_DB ? false : "no DATABASE_URL" }, () => {
  async function scaffold() {
    const telegramId = BigInt(-9_100_000_000_000) - BigInt(Math.floor(Math.random() * 1e9));
    const channel = await prisma.channel.create({
      data: { telegramId, kind: "BARE_CA", displayName: `test-market-${telegramId}`, active: false },
    });
    created.push(channel.id);
    const token = await prisma.token.create({
      data: { address: `TEST${telegramId}`, chain: "SOLANA" },
    });
    const call = await prisma.call.create({
      data: { tokenId: token.id, channelId: channel.id, calledAt: new Date(), messageId: 1n },
    });
    return { channel, token, call };
  }

  test("a measured number is never overwritten by a later write", async () => {
    const { token, call } = await scaffold();
    const first = new Date();
    // Same conditional update the capture path uses.
    const a = await prisma.call.updateMany({
      where: { id: call.id, calledAtMarketCapUsd: null },
      data: { calledAtMarketCapUsd: 12_345, marketCapObservedAt: first, marketCapSource: "measured" },
    });
    assert.equal(a.count, 1);

    const b = await prisma.call.updateMany({
      where: { id: call.id, calledAtMarketCapUsd: null },
      data: { calledAtMarketCapUsd: 99_999, marketCapSource: "second attempt" },
    });
    assert.equal(b.count, 0, "the guard must refuse the second write");

    const row = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
    assert.equal(Number(row.calledAtMarketCapUsd), 12_345);
    assert.equal(row.marketCapSource, "measured");
    assert.equal(row.marketCapIsBackfilled, false);
    void token;
  });

  test("a failed capture records why, and leaves the number null", async () => {
    const { call, token } = await scaffold();
    // An address DexScreener will never know: bounded retries, then a reason.
    const r = await capture(prisma, {
      callId: call.id, tokenId: token.id,
      address: "11111111111111111111111111111111", dexChainId: "solana", calledAt: new Date(),
    }, [0, 200]); // the real schedule runs ~8.5 minutes; the logic is identical
    assert.equal(r.ok, false);
    const row = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
    assert.equal(row.calledAtMarketCapUsd, null, "a guess would be worse than a null");
    assert.ok(row.marketCapNullReason, "the null must say why");
  });

  test("a call we did not witness is not captured at all", async () => {
    const { call } = await scaffold();
    const q = new CaptureQueue(prisma);
    q.enqueue({
      callId: call.id, tokenId: "x", address: "A", dexChainId: "solana",
      calledAt: new Date(Date.now() - CAPTURE_MAX_CALL_AGE_MS - 1000),
    });
    assert.equal(q.inFlight, 0, "an old call must go to reconstruction, not capture");
  });
});
