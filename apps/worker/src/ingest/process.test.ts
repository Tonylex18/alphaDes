/**
 * Ingestion against a real database.
 *
 * The property under test is the one that matters after a crash: processing the
 * same messages twice must produce exactly the same rows, not two of each. So
 * every assertion is made after pass one, then the identical batch is fed again
 * and every assertion is re-made.
 *
 * Runs against whatever DATABASE_URL points at — the dev branch, never
 * production — and creates its own throwaway Channel rows with random ids, so
 * it cannot collide with real data or with a concurrent run. Everything it
 * creates is deleted in `after`, including on failure.
 */
import "../lib/env.js"; // must precede the prisma import — see lib/env.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

import { prisma, type Channel } from "@alphades/db";
import { dumpsDir } from "../lib/paths.js";
import { waitForDatabase } from "../lib/db-wake.js";
import { processBatch, type IncomingMessage } from "./process.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const created: string[] = [];

/// A throwaway channel. Telegram ids are int64; these are far outside the real
/// range so they can never shadow a genuine channel.
async function ephemeralChannel(kind: "BARE_CA" | "NARRATIVE"): Promise<Channel> {
  const telegramId = BigInt(-9_000_000_000_000) - BigInt(Math.floor(Math.random() * 1_000_000_000));
  const c = await prisma.channel.create({
    data: { telegramId, kind, displayName: `test-${kind}-${telegramId}`, active: false },
  });
  created.push(c.id);
  return c;
}

function loadDump(file: string): Map<number, IncomingMessage> | null {
  const path = join(dumpsDir(), file);
  if (!existsSync(path)) return null;
  const msgs = JSON.parse(readFileSync(path, "utf8")).messages as {
    id: number; date: string; text: string | null; hasMedia: boolean; replyTo: number | null;
  }[];
  return new Map(
    msgs.map((m) => [
      m.id,
      { messageId: m.id, postedAt: new Date(m.date), text: m.text ?? "", hasMedia: m.hasMedia, replyTo: m.replyTo },
    ]),
  );
}

function pick(dump: Map<number, IncomingMessage>, ids: number[]): IncomingMessage[] {
  return ids.map((id) => {
    const m = dump.get(id);
    assert.ok(m, `message ${id} missing from dump`);
    return m;
  });
}

/// Delete every throwaway channel this suite ever made, including ones left by
/// a run that was killed before `after` could fire. Test channels are
/// identifiable by name and by an id far outside Telegram's real range.
async function sweepTestChannels(): Promise<number> {
  const stale = await prisma.channel.findMany({
    where: { displayName: { startsWith: "test-" }, telegramId: { lt: BigInt(-9_000_000_000_000) } },
    select: { id: true },
  });
  for (const { id } of stale) {
    await prisma.callEvent.deleteMany({ where: { channelId: id } });
    await prisma.seenMessage.deleteMany({ where: { channelId: id } });
    await prisma.call.deleteMany({ where: { channelId: id } });
    await prisma.channel.delete({ where: { id } }).catch(() => {});
  }
  return stale.length;
}

async function countsFor(channel: Channel) {
  const [calls, events, rows] = await Promise.all([
    prisma.call.count({ where: { channelId: channel.id } }),
    prisma.callEvent.count({ where: { channelId: channel.id } }),
    prisma.callEvent.findMany({ where: { channelId: channel.id }, select: { kind: true } }),
  ]);
  const kinds: Record<string, number> = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  return { calls, events, kinds };
}

before(async () => {
  if (!HAVE_DB) return;
  // Refuse to touch production even if .env is pointed at it by accident.
  if ((process.env.NEON_BRANCH ?? "") === "production") {
    throw new Error("these tests write rows; refusing to run against the production branch");
  }
  // Neon scales the dev branch to zero. Wake it before the first test, or the
  // first test fails on a cold start instead of on anything it is testing.
  await waitForDatabase(prisma);
  await sweepTestChannels();
});

after(async () => {
  if (!HAVE_DB) return;
  for (const channelId of created) {
    await prisma.callEvent.deleteMany({ where: { channelId } });
    await prisma.seenMessage.deleteMany({ where: { channelId } });
    await prisma.call.deleteMany({ where: { channelId } });
    await prisma.channel.delete({ where: { id: channelId } }).catch(() => {});
  }
  // Tokens are shared across channels, so only remove ones left orphaned by
  // THIS suite. A global "every token with no calls" delete would eventually
  // reach real data — it has been harmless only because every real token
  // currently has a call.
  await prisma.token.deleteMany({
    where: { address: { startsWith: "TEST" }, calls: { none: {} }, narrative: null, snapshots: { none: {} } },
  });
  await prisma.$disconnect();
});

describe("ingest is idempotent", { skip: HAVE_DB ? false : "no DATABASE_URL" }, () => {
  test("BARE_CA: a call, its commentary and a milestone survive being fed twice", async (t) => {
    const dump = loadDump("dump_private-channel.json");
    if (!dump) return t.skip("dump not present");
    const channel = await ephemeralChannel("BARE_CA");

    // 1234 call; 1235/1236 chatter seconds later; 1237 media reply; 1240 "3x"
    // replying to 1237, which replies to 1234 — a two-hop chain.
    const batch = pick(dump, [1234, 1235, 1236, 1237, 1240]);

    const first = await processBatch(prisma, channel, batch, { source: "LIVE" });
    const a = await countsFor(channel);

    assert.equal(a.calls, 1, "one call");
    assert.equal(a.kinds.FIRST_CALL, 1);
    assert.equal(a.kinds.COMMENTARY, 2, '"Was looking for dip" and "But it is ehat it is"');
    assert.equal(a.kinds.CHANNEL_MILESTONE, 1, '"3x" attached through the reply chain');

    const call = await prisma.call.findFirstOrThrow({ where: { channelId: channel.id } });
    const milestone = await prisma.callEvent.findFirstOrThrow({
      where: { channelId: channel.id, kind: "CHANNEL_MILESTONE" },
    });
    assert.equal(milestone.callId, call.id, "milestone attached to the existing call");
    assert.equal(Number(milestone.claimedMultiple), 3);
    // Stitched commentary must never write a number onto the call.
    assert.equal(call.statedMarketCapUsd, null);

    // ---- second pass, identical input ------------------------------------
    const second = await processBatch(prisma, channel, batch, { source: "LIVE" });
    const b = await countsFor(channel);

    assert.deepEqual(b, a, "second pass produced different rows");
    assert.equal(
      (await prisma.call.findFirstOrThrow({ where: { channelId: channel.id } })).id,
      call.id,
      "the call was recreated rather than reused",
    );
    assert.equal(first.length, second.length);
  });

  test("NARRATIVE: a re-post is an event, not a second call", async (t) => {
    const dump = loadDump("dump_AlphaDesJurix.json");
    if (!dump) return t.skip("dump not present");
    const channel = await ephemeralChannel("NARRATIVE");

    // 7577 calls $CAOPAN. 7579 is a scanner card for it. 7594 is "3x smashed".
    // 7598 posts the SAME address again — a re-post, not a new call.
    const batch = pick(dump, [7577, 7579, 7594, 7598]);

    await processBatch(prisma, channel, batch, { source: "LIVE" });
    const a = await countsFor(channel);

    assert.equal(a.calls, 1, "the re-post must not create a second call");
    assert.equal(a.kinds.FIRST_CALL, 1);
    assert.equal(a.kinds.REPOST, 1);
    assert.equal(a.kinds.SCANNER_CARD, 1);
    assert.equal(a.kinds.CHANNEL_MILESTONE, 1);

    // The caller's own prose became the narrative, not an LLM's.
    const call = await prisma.call.findFirstOrThrow({
      where: { channelId: channel.id },
      include: { token: { include: { narrative: true } } },
    });
    assert.ok(call.token.narrative, "the caller wrote prose; it should be the narrative");
    assert.equal(call.token.narrative.sourceNote, "The caller's own words at call time");
    assert.equal(call.source, "LIVE");

    await processBatch(prisma, channel, batch, { source: "LIVE" });
    assert.deepEqual(await countsFor(channel), a, "second pass produced different rows");
  });

  test("a milestone arriving before its call attaches on the replay", async (t) => {
    const dump = loadDump("dump_AlphaDesJurix.json");
    if (!dump) return t.skip("dump not present");
    const channel = await ephemeralChannel("NARRATIVE");

    // Out of order on purpose: the milestone first, with nothing to attach to.
    await processBatch(prisma, channel, pick(dump, [7616]), { source: "LIVE" });
    const orphan = await prisma.callEvent.findFirstOrThrow({ where: { channelId: channel.id } });
    assert.equal(orphan.kind, "UNCLASSIFIED");
    assert.equal(orphan.callId, null, "nothing to attach to, so it attaches to nothing");

    // Now the call exists, and the same message is replayed.
    await processBatch(prisma, channel, pick(dump, [7610]), { source: "LIVE" });
    await processBatch(prisma, channel, pick(dump, [7616]), { source: "LIVE" });

    const c = await countsFor(channel);
    assert.equal(c.calls, 1);
    assert.equal(c.events, 2, "the replayed milestone updated its row rather than adding one");
    const fixed = await prisma.callEvent.findFirstOrThrow({
      where: { channelId: channel.id, messageId: 7616n },
    });
    assert.equal(fixed.kind, "CHANNEL_MILESTONE");
    assert.ok(fixed.callId, "now attributable, so now attached");
  });

  test("BACKFILL marks calls as reconstructed, not measured", async (t) => {
    const dump = loadDump("dump_private-channel.json");
    if (!dump) return t.skip("dump not present");
    const channel = await ephemeralChannel("BARE_CA");

    await processBatch(prisma, channel, pick(dump, [1084]), { source: "BACKFILL" });
    const call = await prisma.call.findFirstOrThrow({ where: { channelId: channel.id } });
    assert.equal(call.source, "BACKFILL");
    assert.equal(call.marketCapIsBackfilled, true);
    assert.equal(call.calledAtMarketCapUsd, null, "Phase 2 reconstructs this; it is not guessed now");
  });
});
