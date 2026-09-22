/**
 * The narrative rules that hold without an API key: what may be read, what a
 * run costs, and the guarantee that nothing is ever rewritten.
 */
import "../lib/env.js";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "@alphades/db";
import { waitForDatabase } from "../lib/db-wake.js";
import Anthropic from "@anthropic-ai/sdk";
import { costOf, generateNarrative, hasCredential, sourcesFor } from "./generate.js";
import { NarrativeQueue } from "./queue.js";

const token = (o: Partial<Parameters<typeof sourcesFor>[0]> = {}) => ({
  id: "t", address: "A", symbol: "X", name: "X",
  websiteUrl: null, twitterUrl: null, telegramUrl: null, ...o,
});

test("only the project's own hostnames are readable", () => {
  const { urls, domains } = sourcesFor(token({
    websiteUrl: "https://www.honse.club/about",
    twitterUrl: "https://x.com/honseonsol",
    telegramUrl: "https://t.me/honseofficialcto",
  }));
  assert.deepEqual(domains, ["honse.club", "x.com", "t.me"]); // www stripped
  assert.equal(urls.length, 3);
});

test("a token with no links has nothing to read, and no call is made", () => {
  assert.deepEqual(sourcesFor(token()).domains, []);
});

test("an allowlist never widens to something web_fetch would reject", () => {
  // Bare IPs and single-label hosts are rejected by allowed_domains; a
  // malformed URL must not quietly become a permitted domain.
  const { domains } = sourcesFor(token({
    websiteUrl: "http://192.168.0.1/x",
    twitterUrl: "not-a-url",
    telegramUrl: "https://localhost/x",
  }));
  assert.deepEqual(domains, []);
});

test("cost is computed at Opus 5 list price", () => {
  // 1M in + 1M out = $5 + $25
  assert.equal(costOf(1_000_000, 1_000_000), 30);
  assert.equal(Number(costOf(5_000, 150).toFixed(5)), 0.02875);
});

/**
 * A NONE row is permanent — tokenId is unique and the code only ever creates —
 * so anything that could write one because OUR side failed is uncorrectable.
 * These are the cases that must write nothing at all.
 */
describe("an infrastructure failure is never recorded as a fact about the token", () => {
  const withLinks = token({ websiteUrl: "https://honse.club", twitterUrl: "https://x.com/honseonsol" });

  /// A client whose every call fails the way a bad key or an outage would.
  const failing = (err: unknown) =>
    ({ messages: { create: async () => { throw err; } } }) as unknown as Anthropic;

  /// A credential MUST be present for these, or generateNarrative short-circuits
  /// on "no credential" and never reaches the API-error branch under test —
  /// which is how the first version of these two tests passed against the very
  /// bug they were written to catch.
  async function withDummyKey<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  }

  test("a rejected API key does not become \"this project published nothing\"", async () => {
    const r = await withDummyKey(() =>
      generateNarrative(
        failing(new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "invalid", new Headers())),
        withLinks,
      ),
    );
    assert.equal(r.kind, "unavailable", "a 401 is a fact about our credential, not about the token");
  });

  test("a rate limit or outage does not become a NONE either", async () => {
    for (const err of [
      new Anthropic.RateLimitError(429, {}, "rate limited", new Headers()),
      new Anthropic.InternalServerError(503, {}, "upstream", new Headers()),
      new Error("fetch failed"),
    ]) {
      const r = await withDummyKey(() => generateNarrative(failing(err), withLinks));
      assert.equal(r.kind, "unavailable", `${String(err)} must not write a verdict`);
    }
  });

  test("with no credential at all, nothing is even attempted", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, tok: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      assert.equal(hasCredential(), false);
      let called = false;
      const spy = { messages: { create: async () => { called = true; return {} as never; } } } as unknown as Anthropic;
      const r = await generateNarrative(spy, withLinks);
      assert.equal(r.kind, "unavailable");
      assert.equal(called, false, "no request should be made without a credential");
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.tok !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.tok;
    }
  });

  test("a token with genuinely no links IS a fact, and is recorded", async () => {
    const r = await withDummyKey(() => generateNarrative(failing(new Error("should not be called")), token()));
    assert.equal(r.kind, "none", "no website, X or Telegram is a fact about the token");
    assert.match(r.kind === "none" ? r.reason : "", /no website/i);
  });
});

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const created: string[] = [];

before(async () => {
  if (!HAVE_DB) return;
  if ((process.env.NEON_BRANCH ?? "") === "production") throw new Error("refusing to write to production");
  await waitForDatabase(prisma);
});
after(async () => {
  if (!HAVE_DB) return;
  await prisma.narrative.deleteMany({ where: { tokenId: { in: created } } });
  await prisma.token.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe("a narrative is written once and never rewritten", { skip: HAVE_DB ? false : "no DATABASE_URL" }, () => {
  async function scaffold(source: "CALLER" | "GENERATED" | "NONE", summary: string | null) {
    const t = await prisma.token.create({
      data: { address: `TESTNARR${Math.random().toString(36).slice(2, 10)}`, chain: "SOLANA" },
    });
    created.push(t.id);
    await prisma.narrative.create({
      data: { tokenId: t.id, source, summary, sourceNote: "test", sourceUrls: [] },
    });
    return t;
  }

  test("a token that already has a narrative is not a candidate", async () => {
    const withCaller = await scaffold("CALLER", "the caller's own words");
    const candidates = await prisma.token.findMany({ where: { narrative: null, id: { in: created } }, select: { id: true } });
    assert.ok(!candidates.some((c) => c.id === withCaller.id), "a caller narrative must never be replaced");
  });

  test("a recorded NONE is also not a candidate — we do not retry forever", async () => {
    const none = await scaffold("NONE", null);
    const candidates = await prisma.token.findMany({ where: { narrative: null, id: { in: created } }, select: { id: true } });
    assert.ok(!candidates.some((c) => c.id === none.id));
  });

  test("a second narrative for the same token is refused by the database", async () => {
    const t = await scaffold("GENERATED", "first");
    await assert.rejects(
      () => prisma.narrative.create({ data: { tokenId: t.id, source: "GENERATED", summary: "second", sourceUrls: [] } }),
      /Unique constraint|already exists/i,
      "regenerating would quietly rewrite history",
    );
    const row = await prisma.narrative.findUniqueOrThrow({ where: { tokenId: t.id } });
    assert.equal(row.summary, "first");
  });

  test("the live queue writes NO row when the API is unavailable", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    try {
      const t = await prisma.token.create({
        data: {
          address: `TESTNARR${Math.random().toString(36).slice(2, 10)}`, chain: "SOLANA",
          websiteUrl: "https://honse.club", twitterUrl: "https://x.com/honseonsol",
        },
      });
      created.push(t.id);
      const failing = {
        messages: { create: async () => { throw new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", new Headers()); } },
      } as unknown as Anthropic;

      const q = new NarrativeQueue(prisma, failing);
      q.enqueue(t.id);
      // enqueue is fire-and-forget and does a database read first, so wait on
      // the condition rather than a fixed delay: under the full suite that read
      // competes with every other test file and a 2s wait was not enough.
      const deadline = Date.now() + 60_000;
      while (q.stats.unavailable === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.equal(q.stats.unavailable, 1);
      assert.equal(q.stats.none, 0, "a 401 must not be recorded as NONE");
      assert.equal(
        await prisma.narrative.findUnique({ where: { tokenId: t.id } }),
        null,
        "no row at all — the token must still be a candidate when the key is fixed",
      );
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("a NONE row carries its reason and no summary", async () => {
    const t = await prisma.token.create({
      data: { address: `TESTNARR${Math.random().toString(36).slice(2, 10)}`, chain: "SOLANA" },
    });
    created.push(t.id);
    await prisma.narrative.create({
      data: { tokenId: t.id, source: "NONE", summary: null, nullReason: "parked domain", sourceUrls: ["https://x.com/a"] },
    });
    const row = await prisma.narrative.findUniqueOrThrow({ where: { tokenId: t.id } });
    assert.equal(row.summary, null);
    assert.equal(row.nullReason, "parked domain");
  });
});
