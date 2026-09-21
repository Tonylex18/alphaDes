/**
 * npm run market:report
 *
 * The state of the one number everything depends on: how many calls have a
 * called-at market cap, how it was obtained, how long after the call it was
 * observed, and — where the caller happened to state a figure themselves — how
 * closely our reconstruction agrees with them.
 *
 * That last one is the only independent check available. The caller's number is
 * a claim, never merged into ours (DECISIONS.md), but it was written by someone
 * who was there, so a reconstruction that disagrees with it wildly is suspect.
 */
import "../lib/env.js";
import { prisma } from "@alphades/db";
import { waitForDatabase } from "../lib/db-wake.js";

await waitForDatabase(prisma);

const calls = await prisma.call.findMany({
  select: {
    id: true, calledAt: true, source: true, status: true, closeReason: true,
    calledAtMarketCapUsd: true, marketCapObservedAt: true, marketCapSource: true,
    marketCapIsBackfilled: true, marketCapNullReason: true, statedMarketCapUsd: true,
    latestMarketCapUsd: true, peakMarketCapUsd: true,
    token: { select: { symbol: true, dexChainId: true, chain: true } },
  },
});

const n = calls.length;
const withCap = calls.filter((c) => c.calledAtMarketCapUsd !== null);
const measured = withCap.filter((c) => !c.marketCapIsBackfilled);
const reconstructed = withCap.filter((c) => c.marketCapIsBackfilled);
const nulls = calls.filter((c) => c.calledAtMarketCapUsd === null);

const pct = (a: number) => `${((100 * a) / Math.max(n, 1)).toFixed(0)}%`;
console.log(`\ncalls: ${n}`);
console.log(`  with a called-at market cap : ${withCap.length} (${pct(withCap.length)})`);
console.log(`    measured at ingestion     : ${measured.length}`);
console.log(`    reconstructed (flagged)   : ${reconstructed.length}`);
console.log(`  still null                  : ${nulls.length}`);

if (measured.length) {
  const lags = measured
    .filter((c) => c.marketCapObservedAt)
    .map((c) => (c.marketCapObservedAt!.getTime() - c.calledAt.getTime()) / 1000)
    .sort((a, b) => a - b);
  const med = lags[Math.floor(lags.length / 2)];
  console.log(`\nmeasured capture lag (call -> observation): median ${med?.toFixed(1)}s, worst ${lags.at(-1)?.toFixed(1)}s`);
}

const tf: Record<string, number> = {};
for (const c of reconstructed) {
  const m = /ohlcv (minute|hour|day)/.exec(c.marketCapSource ?? "");
  tf[m?.[1] ?? "?"] = (tf[m?.[1] ?? "?"] ?? 0) + 1;
}
if (reconstructed.length) console.log("reconstruction candle resolution:", tf);

// Independent check against the caller's own stated figure.
const both = withCap.filter((c) => c.statedMarketCapUsd !== null);
if (both.length) {
  const errs = both
    .map((c) => {
      const ours = Number(c.calledAtMarketCapUsd);
      const theirs = Number(c.statedMarketCapUsd);
      return { symbol: c.token.symbol ?? "?", ours, theirs, err: Math.abs(ours - theirs) / theirs };
    })
    .sort((a, b) => a.err - b.err);
  const med = errs[Math.floor(errs.length / 2)]!;
  console.log(`\nagainst the caller's own stated market cap (${both.length} calls where they gave one):`);
  console.log(`  median disagreement ${(100 * med.err).toFixed(0)}%`);
  for (const e of errs) {
    console.log(`    ${e.symbol.padEnd(12)} ours $${Math.round(e.ours).toLocaleString().padStart(11)}   ` +
      `caller said $${Math.round(e.theirs).toLocaleString().padStart(11)}   ${(100 * e.err).toFixed(0)}% apart`);
  }
}

if (nulls.length) {
  const reasons: Record<string, number> = {};
  for (const c of nulls) {
    const key = (c.marketCapNullReason ?? "not attempted").split(":").slice(0, 2).join(":").slice(0, 70);
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  console.log("\nwhy the rest are null:");
  for (const [r, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${count}x ${r}`);
}

const dead = calls.filter((c) => c.status === "CLOSED_DEAD");
console.log(`\nclosed dead: ${dead.length}`);
for (const d of dead.slice(0, 10)) console.log(`  ${(d.token.symbol ?? "?").padEnd(12)} ${d.closeReason}`);

const snaps = await prisma.priceSnapshot.count();
const chains = await prisma.token.groupBy({ by: ["dexChainId"], _count: true });
console.log(`\nprice snapshots: ${snaps}`);
console.log("resolved chains:", chains.map((c) => `${c.dexChainId ?? "unresolved"}=${c._count}`).join(" "));
await prisma.$disconnect();
