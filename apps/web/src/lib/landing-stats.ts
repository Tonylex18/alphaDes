/**
 * The figures on the public landing page.
 *
 * Read at BUILD time (the page is statically generated and revalidated once a
 * day), so a visitor never causes a database query. The landing page is the one
 * page anyone can hit, and a per-visitor read would wake Neon on every stranger
 * who clicks the link — the same trap as the feed, but worse, because it scales
 * with traffic we do not control.
 *
 * Every number here is a count of rows. Nothing is modelled, projected or
 * rounded into something friendlier. If a figure cannot be read off the
 * database it does not appear on the page — which is why there is no win rate,
 * no median peak and no time-to-peak headline yet: price polling began on
 * 21 September and most of these calls were made in August, so any peak we
 * printed would be the highest price since we started watching rather than the
 * highest price after the call.
 */
import { prisma } from "@alphades/db";

/**
 * Neon suspends when idle, and the first connection after that takes 5-15
 * seconds — longer than Prisma's connect timeout. A build that happens to run
 * while the database is asleep therefore fails, which on Vercel is an
 * intermittent broken deploy for no real reason. Measured here: the first build
 * of this page failed exactly that way.
 *
 * Retried rather than caught, and if it genuinely cannot be reached the build
 * FAILS. Falling back to placeholder figures would put invented numbers on the
 * one page whose whole argument is that its numbers are real.
 */
async function wake(timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await Promise.all([1, 2, 3, 4].map(() => prisma.$queryRawUnsafe("select 1")));
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  throw new Error(`landing stats: database unreachable after ${timeoutMs / 1000}s — ${String(last).slice(0, 160)}`);
}

export type DeadExample = { symbol: string; reason: string; calledAt: string };

export type LandingStats = {
  calls: number;
  deadCalls: number;
  deadPercent: number;
  entryMeasured: number;
  entryReconstructed: number;
  entryMissing: number;
  callerNarratives: number;
  firstCallDate: string;
  asOf: string;
  deadExamples: DeadExample[];
  /// A real call, used for the card anatomy. Never invented numbers.
  anatomy: {
    symbol: string;
    calledAtUsd: number | null;
    latestUsd: number | null;
    peakUsd: number | null;
    peakMultiple: number | null;
    provenance: "MEASURED" | "RECONSTRUCTED" | "MISSING";
    narrative: string | null;
    narrativeIsCaller: boolean;
  } | null;
};

export async function getLandingStats(): Promise<LandingStats> {
  // Waking is not enough on its own: Neon can drop the connection again
  // between the wake and the read, which failed a build here. Retry the whole
  // read, and still fail loudly rather than publish placeholder figures.
  let last: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await wake();
      return await readStats();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw new Error(`landing stats: could not read the database — ${String(last).slice(0, 200)}`);
}

async function readStats(): Promise<LandingStats> {
  const where = { channel: { role: "TRACK" as const } };
  const [calls, deadCalls, entryMeasured, entryReconstructed, entryMissing, callerNarratives, oldest, dead, anatomyRow] =
    await Promise.all([
      prisma.call.count({ where }),
      prisma.call.count({ where: { ...where, status: "CLOSED_DEAD" } }),
      prisma.call.count({ where: { ...where, calledAtMarketCapUsd: { not: null }, marketCapIsBackfilled: false } }),
      prisma.call.count({ where: { ...where, calledAtMarketCapUsd: { not: null }, marketCapIsBackfilled: true } }),
      prisma.call.count({ where: { ...where, calledAtMarketCapUsd: null } }),
      prisma.narrative.count({ where: { source: "CALLER" } }),
      prisma.call.findFirst({ where, orderBy: { calledAt: "asc" }, select: { calledAt: true } }),
      prisma.call.findMany({
        where: { ...where, status: "CLOSED_DEAD", closeReason: { not: null } },
        orderBy: { closedAt: "desc" },
        take: 3,
        select: { closeReason: true, calledAt: true, token: { select: { symbol: true, address: true } } },
      }),
      // Prefer a call whose entry we measured ourselves — for those we watched
      // from the first minute, so the peak is genuinely ours.
      prisma.call.findFirst({
        where: { ...where, marketCapIsBackfilled: false, calledAtMarketCapUsd: { not: null } },
        orderBy: { calledAt: "desc" },
        select: {
          calledAtMarketCapUsd: true, latestMarketCapUsd: true, peakMarketCapUsd: true, marketCapIsBackfilled: true,
          token: { select: { symbol: true, address: true, narrative: { select: { summary: true, source: true } } } },
        },
      }),
    ]);

  const entry = anatomyRow?.calledAtMarketCapUsd ? Number(anatomyRow.calledAtMarketCapUsd) : null;
  const peak = anatomyRow?.peakMarketCapUsd ? Number(anatomyRow.peakMarketCapUsd) : null;

  return {
    calls,
    deadCalls,
    deadPercent: calls ? Math.round((100 * deadCalls) / calls) : 0,
    entryMeasured,
    entryReconstructed,
    entryMissing,
    callerNarratives,
    firstCallDate: oldest
      ? oldest.calledAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : "—",
    asOf: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    deadExamples: dead.map((d) => ({
      symbol: d.token.symbol ?? d.token.address.slice(0, 6),
      reason: d.closeReason!,
      calledAt: d.calledAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
    })),
    anatomy: anatomyRow
      ? {
          symbol: anatomyRow.token.symbol ?? anatomyRow.token.address.slice(0, 6),
          calledAtUsd: entry,
          latestUsd: anatomyRow.latestMarketCapUsd ? Number(anatomyRow.latestMarketCapUsd) : null,
          peakUsd: peak,
          peakMultiple: entry && peak ? peak / entry : null,
          provenance: entry === null ? "MISSING" : anatomyRow.marketCapIsBackfilled ? "RECONSTRUCTED" : "MEASURED",
          narrative: anatomyRow.token.narrative?.summary ?? null,
          narrativeIsCaller: anatomyRow.token.narrative?.source === "CALLER",
        }
      : null,
  };
}
