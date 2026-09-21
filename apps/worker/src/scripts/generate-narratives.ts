/**
 * npm run narrative:generate [-- --dry-run] [-- --limit N]
 *
 * Fills the gap the channels left. A token gets a generated narrative only if
 * it has none at all — a caller's words are never replaced, and a narrative
 * already generated is never regenerated. The database enforces both: the row
 * is created, never updated.
 *
 * --dry-run shows exactly which tokens would be sent and which of their own
 * pages would be read, and spends nothing.
 *
 * Writes are batched into one round trip at the end, so a run of fifty
 * narratives wakes Neon once.
 */
import "../lib/env.js";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@alphades/db";
import { waitForDatabase, withTransientRetry } from "../lib/db-wake.js";
import { costOf, generateNarrative, MODEL, sourcesFor } from "../narrative/generate.js";

const dryRun = process.argv.includes("--dry-run");
const limitAt = process.argv.indexOf("--limit");
const limit = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : undefined;

if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Use --dry-run to see what would be sent.");
  process.exit(1);
}

await waitForDatabase(prisma);

// Only tokens with NO narrative row at all. A caller's words, a previous
// generation, and a recorded "nothing to say" are all rows — and all mean
// leave it alone.
const tokens = await prisma.token.findMany({
  where: { narrative: null },
  orderBy: { firstSeenAt: "asc" },
  take: limit,
  select: {
    id: true, address: true, symbol: true, name: true,
    websiteUrl: true, twitterUrl: true, telegramUrl: true,
    calls: { select: { channel: { select: { kind: true, displayName: true } } }, take: 1 },
  },
});

console.log(`${tokens.length} token(s) with no narrative${dryRun ? " (dry run — nothing will be sent or written)" : ""}\n`);

const rows: any[] = [];
let generated = 0, none = 0, inTok = 0, outTok = 0, cost = 0;
const client = dryRun ? null : new Anthropic();

for (const [i, t] of tokens.entries()) {
  const { urls, domains } = sourcesFor(t);
  const tag = `${(t.symbol ?? t.address.slice(0, 8)).padEnd(12)}`;
  const from = t.calls[0]?.channel.kind ?? "?";

  if (dryRun) {
    console.log(
      `  [${i + 1}/${tokens.length}] ${tag} ${from.padEnd(9)} ` +
        (domains.length ? `would read ${domains.join(", ")}` : "NO SOURCES — would record NONE"),
    );
    continue;
  }

  const r = await generateNarrative(client!, t);
  inTok += r.inputTokens; outTok += r.outputTokens; cost += r.costUsd;

  if (r.ok) {
    generated++;
    console.log(`  [${i + 1}/${tokens.length}] ${tag} ${r.summary.replace(/\s+/g, " ").slice(0, 96)}…`);
    rows.push(
      prisma.narrative.create({
        data: {
          tokenId: t.id,
          source: "GENERATED",
          summary: r.summary,
          sourceNote: "Summarised from the project's own socials",
          sourceUrls: r.sourceUrls,
          model: MODEL,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
        },
      }),
    );
  } else {
    none++;
    console.log(`  [${i + 1}/${tokens.length}] ${tag} NONE — ${r.reason.slice(0, 90)}`);
    rows.push(
      prisma.narrative.create({
        data: {
          tokenId: t.id,
          source: "NONE",
          summary: null,
          nullReason: r.reason.slice(0, 500),
          sourceNote: "No narrative: the project published nothing we could read",
          sourceUrls: r.sourceUrls,
          model: r.inputTokens > 0 ? MODEL : null,
          inputTokens: r.inputTokens || null,
          outputTokens: r.outputTokens || null,
          costUsd: r.costUsd || null,
        },
      }),
    );
  }
}

if (rows.length) {
  // One round trip for the whole run.
  await withTransientRetry("narrative flush", () => prisma.$transaction(rows));
}

if (!dryRun) {
  console.log(`\ngenerated ${generated}, recorded NONE ${none}`);
  console.log(
    `tokens: ${inTok.toLocaleString()} in, ${outTok.toLocaleString()} out — ` +
      `$${cost.toFixed(4)} at ${MODEL} list price ($5/$25 per Mtok)`,
  );
  if (generated + none > 0) {
    console.log(`average per token: $${(cost / (generated + none)).toFixed(5)}`);
  }
} else {
  const withSources = tokens.filter((t) => sourcesFor(t).domains.length > 0).length;
  console.log(`\n${withSources} of ${tokens.length} have at least one of their own pages to read.`);
  console.log(`The other ${tokens.length - withSources} would be recorded as NONE without an API call.`);
  console.log(`Rough cost if run: web_fetch pulls page text in, so expect ~3-8k input tokens each;`);
  console.log(`at $5/Mtok that is about $${costOf(5000, 150).toFixed(4)} per token, ~$${(withSources * costOf(5000, 150)).toFixed(2)} for the run.`);
}
await prisma.$disconnect();
