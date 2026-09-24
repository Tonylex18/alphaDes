/**
 * npm run market:peaks [-- --dry-run] [-- --limit N]
 *
 * Rebuilds `peakMarketCapUsd` / `peakAt` from OHLCV over the WHOLE window
 * between the call and now, and flags every one of them `peakIsBackfilled`.
 *
 * Why this script exists at all: polling started on 21 September and most calls
 * are from 9 August, so the peak the poller had recorded was "the highest price
 * since we started watching". That is a fact about our infrastructure wearing
 * the label of a fact about the token, which is the exact thing this project is
 * supposed not to do. Those values are replaced here, or removed.
 *
 * Method, recorded per call in `peakSource`:
 *
 *   price   the maximum HIGH in the window. Hourly bars across the whole
 *           window, minute bars for the ~16 hours after the call, and one more
 *           minute request to resolve which minute inside the winning hour it
 *           happened at. Day bars are refused — see `peakBetween`.
 *   supply  the SAME implied supply the entry price was converted with, parsed
 *           back out of `marketCapSource`, so that peak/entry is a ratio of two
 *           prices and not of two different supply assumptions. Where the entry
 *           was measured at ingest and carries no supply, one is implied fresh
 *           and the record says so.
 *
 * Anything missing leaves the peak null with a reason, and removes any
 * partial-window value that was there before. A null is honest; a peak that
 * silently means "since 21 September" is not.
 */
import "../lib/env.js";
import { prisma } from "@alphades/db";
import { waitForDatabase, withTransientRetry } from "../lib/db-wake.js";
import { resolveToken } from "../market/dexscreener.js";
import { geckoNetwork, peakBetween, tokenInfo, topPool, WrongSideOfPool } from "../market/geckoterminal.js";

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;

/// The supply the entry reconstruction used, written into its own prose as
/// `x supply 1.0000e+9 implied from dexscreener fdv/price`. Parsing our own
/// format back is not elegant, but the alternative is converting the peak with
/// a supply the entry never saw, which would make every multiple wrong by the
/// ratio between them.
function supplyFromEntryProse(source: string | null): { supply: number; from: string } | null {
  const m = /x supply ([0-9.]+e[+-]?[0-9]+) implied from (.+)$/.exec(source ?? "");
  if (!m) return null;
  const supply = Number(m[1]);
  if (!Number.isFinite(supply) || supply <= 0) return null;
  return { supply, from: m[2]!.trim() };
}

function humanDuration(ms: number): string {
  if (ms < 0) return "0m";
  const mins = Math.round(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

await waitForDatabase(prisma);

const calls = await prisma.call.findMany({
  orderBy: { calledAt: "asc" },
  take: limit,
  select: {
    id: true, calledAt: true, calledAtMarketCapUsd: true, marketCapSource: true,
    peakMarketCapUsd: true, peakAt: true, peakSource: true, peakIsBackfilled: true,
    token: { select: { id: true, address: true, chain: true, dexChainId: true, poolAddress: true, symbol: true } },
    events: { where: { claimedMultiple: { not: null } }, select: { claimedMultiple: true, postedAt: true } },
  },
});

// Did our own polling cover a call from the moment it landed? If it did, a
// polled peak is a real peak-since-call and survives a failed reconstruction.
// If it did not, the stored value covers an arbitrary slice of the call's life
// and has to go.
const firstSnapshot = new Map<string, Date>();
for (const g of await prisma.priceSnapshot.groupBy({ by: ["tokenId"], _min: { at: true } })) {
  if (g._min.at) firstSnapshot.set(g.tokenId, g._min.at);
}

const now = new Date();
console.log(`${calls.length} call(s)${dryRun ? " (dry run)" : ""}\n`);

let done = 0, failed = 0, cleared = 0, requests = 0;
const reasons: Record<string, number> = {};
const byTimeframe: Record<string, number> = {};
const lowerBounds: string[] = [];
const belowEntry: string[] = [];
const supplyBasis: Record<string, number> = {};
const disagreements: { tag: string; claimed: number; ours: number; ratio: number }[] = [];

for (const [i, call] of calls.entries()) {
  const t = call.token;
  const tag = `${t.symbol ? `$${t.symbol}` : (t.address ?? "").slice(0, 10)}`;
  const label = `[${i + 1}/${calls.length}] ${tag.padEnd(14)}`;

  const fail = async (reason: string) => {
    failed++;
    reasons[reason.split(":")[0]!] = (reasons[reason.split(":")[0]!] ?? 0) + 1;
    // A peak we cannot stand behind must not stay on the board. The one
    // exception is a call our own polling watched from its first minute.
    const first = firstSnapshot.get(t.id);
    const polledFromTheStart = first !== undefined && first.getTime() <= call.calledAt.getTime() + 5 * 60_000;
    const drop = call.peakMarketCapUsd !== null && !polledFromTheStart;
    if (drop) cleared++;
    console.log(`  ${label} NO PEAK — ${reason}${drop ? " (removed a partial-window value)" : ""}`);
    if (!dryRun) {
      await withTransientRetry(`peak-null ${call.id}`, () =>
        prisma.call.update({
          where: { id: call.id },
          data: {
            peakNullReason: `peak reconstruction: ${reason}`.slice(0, 500),
            ...(drop ? { peakMarketCapUsd: null, peakAt: null, peakSource: null, peakIsBackfilled: false } : {}),
            ...(polledFromTheStart && call.peakMarketCapUsd !== null
              ? {
                  peakSource: `measured: polled from ${first!.toISOString()}, which is the call itself`,
                  peakIsBackfilled: false,
                }
              : {}),
          },
        }),
      { attempts: 8, baseDelayMs: 5_000 });
    }
  };

  // 1. Chain and pool. DexScreener answers both and does not spend the
  //    GeckoTerminal budget.
  let dexChainId = t.dexChainId;
  let pool = t.poolAddress;
  let freshSupply: number | null = null;
  let freshSupplyFrom = "";
  let lookupFailed: string | null = null;
  const current = await resolveToken(t.address).catch((e) => {
    lookupFailed = String((e as Error)?.message ?? e).slice(0, 120);
    return null;
  });
  if (current) {
    dexChainId ??= current.dexChainId;
    pool ??= current.pairAddress;
    if (current.fdvUsd && current.priceUsd) {
      freshSupply = current.fdvUsd / current.priceUsd;
      freshSupplyFrom = "dexscreener fdv/price";
    }
  }
  if (!dexChainId && t.chain === "SOLANA") dexChainId = "solana";
  if (!dexChainId) {
    await fail(
      lookupFailed
        ? `lookup failed: ${lookupFailed} — retry, do not treat as a verdict`
        : "chain unknown: no DexScreener pair and the address is EVM, which names no chain",
    );
    continue;
  }
  const network = geckoNetwork(dexChainId);
  if (!pool) pool = await topPool(network, t.address).catch(() => null);
  if (!pool) {
    await fail(`no pool on ${network}: token never indexed, or delisted`);
    continue;
  }

  // 2. The supply. The entry's own, wherever the entry recorded one.
  const entrySupply = supplyFromEntryProse(call.marketCapSource);
  let supply = entrySupply?.supply ?? null;
  let supplyNote = entrySupply ? `the entry's supply (${entrySupply.from})` : "";
  if (supply === null) {
    if (freshSupply === null) {
      const info = await tokenInfo(network, t.address).catch(() => null);
      if (info?.fdvUsd && info.priceUsd) {
        freshSupply = info.fdvUsd / info.priceUsd;
        freshSupplyFrom = "geckoterminal fdv/price";
      } else if (info?.totalSupply) {
        freshSupply = info.totalSupply;
        freshSupplyFrom = "geckoterminal total_supply";
      }
    }
    supply = freshSupply;
    supplyNote = `a supply implied now from ${freshSupplyFrom} — the entry recorded none`;
  }
  if (supply === null || !Number.isFinite(supply) || supply <= 0) {
    await fail(`no supply: neither source reports a current price and fdv on ${network}`);
    continue;
  }

  // 3. The window.
  let scanError: string | null = null;
  const peak = await peakBetween(network, pool, call.calledAt, now, t.address).catch((e) => {
    scanError = e instanceof WrongSideOfPool ? `wrong side of pool: ${e.message}` : String((e as Error)?.message ?? e).slice(0, 120);
    return null;
  });
  if (peak) requests += peak.requests;
  if (!peak) {
    await fail(
      scanError
        ? `lookup failed: ${scanError} — retry, do not treat as a verdict`
        : `no hour or minute bars between ${call.calledAt.toISOString()} and now on ${network} — history not retained`,
    );
    continue;
  }

  const peakCap = peak.high * supply;
  if (!Number.isFinite(peakCap) || peakCap <= 0) {
    await fail("window produced no usable market cap");
    continue;
  }
  // The same guard the entry reconstruction uses. A billion-dollar peak on a
  // Telegram memecoin call is a broken method, not a find.
  if (peakCap > 1_000_000_000) {
    await fail(`implausible: $${Math.round(peakCap).toLocaleString()} peak — method unsound for this pool`);
    continue;
  }

  // 4. Our own polling may have caught a higher price than the bars show — a
  //    different source, so it is allowed to win, but then the number is
  //    measured and must not be labelled reconstructed.
  //    A peak already flagged backfilled is a PREVIOUS run of this script, not
  //    an observation, and must not compete — otherwise re-running after a fix
  //    to the scan would keep the old, worse number and relabel it "measured".
  const polled = call.peakMarketCapUsd === null || call.peakIsBackfilled ? null : Number(call.peakMarketCapUsd);
  const reconstructedWins = polled === null || peakCap >= polled;
  const finalCap = reconstructedWins ? peakCap : polled!;
  const finalAt = reconstructedWins ? peak.at : (call.peakAt ?? peak.at);

  const source = reconstructedWins
    ? `geckoterminal:ohlcv ${peak.timeframe} high @${peak.at.toISOString()} over calledAt→now ` +
      `(${peak.coverage}) x ${supplyNote}`
    : `measured: a poll observed $${Math.round(polled!).toLocaleString()}, above the reconstructed window high ` +
      `of $${Math.round(peakCap).toLocaleString()} (${peak.timeframe} bars)`;

  byTimeframe[reconstructedWins ? peak.timeframe : "measured"] =
    (byTimeframe[reconstructedWins ? peak.timeframe : "measured"] ?? 0) + 1;
  supplyBasis[entrySupply ? "entry's own supply" : "supply implied now"] =
    (supplyBasis[entrySupply ? "entry's own supply" : "supply implied now"] ?? 0) + 1;
  if (peak.firstHourSkipped) lowerBounds.push(tag);

  const entry = call.calledAtMarketCapUsd === null ? null : Number(call.calledAtMarketCapUsd);
  const mult = entry && entry > 0 ? finalCap / entry : null;
  const ttp = humanDuration(finalAt.getTime() - call.calledAt.getTime());
  if (entry !== null && finalCap < entry) belowEntry.push(`${tag} peak $${Math.round(finalCap).toLocaleString()} < entry $${Math.round(entry).toLocaleString()}`);

  // 5. The only independent check there is: what the channel itself claimed.
  const claimed = call.events
    .map((e) => Number(e.claimedMultiple))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (claimed.length > 0 && mult !== null) {
    const topClaim = Math.max(...claimed);
    disagreements.push({ tag, claimed: topClaim, ours: mult, ratio: mult / topClaim });
  }

  console.log(
    `  ${label} peak $${Math.round(finalCap).toLocaleString().padStart(12)} ` +
      `${mult === null ? "     " : `${mult.toFixed(2)}x`.padStart(8)}  ${ttp.padStart(8)} to peak  ` +
      `(${reconstructedWins ? peak.timeframe : "measured"}, ${peak.coverage})`,
  );
  done++;

  if (!dryRun) {
    await withTransientRetry(`peak ${call.id}`, () => prisma.call.update({
      where: { id: call.id },
      data: {
        peakMarketCapUsd: finalCap,
        peakAt: finalAt,
        peakSource: source.slice(0, 500),
        peakIsBackfilled: reconstructedWins,
        peakNullReason: null,
      },
    }), { attempts: 8, baseDelayMs: 5_000 });
  }
}

console.log(`\npeaks written ${done}, no peak ${failed}, partial-window values removed ${cleared}`);
console.log(`geckoterminal requests spent: ${requests}`);
if (done) console.log("granularity that produced the peak:", byTimeframe);
if (done) console.log("supply basis:", supplyBasis);
if (failed) console.log("reasons:", reasons);
if (lowerBounds.length) {
  console.log(
    `\nlower bounds — the partial first hour could not be scanned at minute resolution, ` +
      `so a first-hour peak is missed (${lowerBounds.length}): ${lowerBounds.join(", ")}`,
  );
}
if (belowEntry.length) {
  console.log(`\nPEAK BELOW ENTRY (${belowEntry.length}) — inspect, this is usually a bug:`);
  for (const b of belowEntry) console.log(`  ${b}`);
} else {
  console.log("\nno call has a peak below its entry.");
}

if (disagreements.length > 0) {
  const ratios = disagreements.map((d) => d.ratio);
  const med = median(ratios)!;
  const medAbs = median(disagreements.map((d) => Math.abs(Math.log(d.ratio))))!;
  console.log(`\nagainst what the channels claimed (${disagreements.length} call(s) with a stated multiple):`);
  console.log(`  median ours/claimed ratio: ${med.toFixed(2)}x   (1.00 = we agree)`);
  console.log(`  median absolute disagreement: ${((Math.exp(medAbs) - 1) * 100).toFixed(0)}%`);
  console.log(`  ours is at least the claim in ${disagreements.filter((d) => d.ratio >= 0.95).length}/${disagreements.length}`);
  for (const d of [...disagreements].sort((a, b) => a.ratio - b.ratio).slice(0, 8)) {
    console.log(`    ${d.tag.padEnd(14)} claimed ${d.claimed.toFixed(2)}x  ours ${d.ours.toFixed(2)}x  (${d.ratio.toFixed(2)}x)`);
  }
} else {
  console.log("\nno call has both a reconstructed peak and a claimed multiple to check it against.");
}

await prisma.$disconnect();
