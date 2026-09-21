/**
 * The narrative rules that hold without an API key: what may be read, what a
 * run costs, and the guarantee that nothing is ever rewritten.
 */
import "../lib/env.js";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "@alphades/db";
import { waitForDatabase } from "../lib/db-wake.js";
import { costOf, sourcesFor } from "./generate.js";

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
