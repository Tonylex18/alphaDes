/**
 * The figures on the public landing page.
 *
 * Read at BUILD time (the page is statically generated and revalidated once a
 * day), so a visitor never causes a database query. The landing page is the one
 * page anyone can hit, and a per-visitor read would wake Neon on every stranger
 * who clicks the link — the same trap as the feed, but worse, because it scales
 * with traffic we do not control.
 *
 * Every number here is a count of rows, or a median over rows. Nothing is
 * modelled, projected or rounded into something friendlier. If a figure cannot
 * be read off the database it does not appear on the page.
 *
 * Peak and time-to-peak were held back for exactly that reason until Phase 2b:
 * price polling began on 21 September and most calls were made in August, so
 * the only peak we held was the highest price since we started watching. They
 * are published now because `market:peaks` reconstructs the real window from
 * OHLCV, and only for the calls where it succeeded — the page quotes that
 * count beside the figures. There is still no win rate, and there will not be
 * one: a win rate needs an exit rule, and a peak is what the token did rather
 * than what anybody got for it.
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

/**
 * Real cards for the hero visual.
 *
 * Peak and time-to-peak are here now that `market:peaks` reconstructs them from
 * OHLCV over the whole window. They were left off while the only peak we held
 * was "the highest price since polling began on 21 September", which for an
 * August call is a number about us. A card still shows no peak at all where
 * `peakSource` is null — the same three states as the entry price.
 *
 * No channel attribution: one of the two channels is private and is not named
 * on a public page.
 */
export type HeroCard = {
  symbol: string;
  imageUrl: string | null;
  entryUsd: number;
  nowUsd: number | null;
  nowMultiple: number | null;
  provenance: "MEASURED" | "RECONSTRUCTED";
  peakUsd: number | null;
  peakMultiple: number | null;
  /// Already rendered: "3h 20m", "6d 4h". Null when there is no peak.
  timeToPeak: string | null;
  peakIsReconstructed: boolean;
  dead: boolean;
  closeReason: string | null;
  story: string | null;
  storyIsCaller: boolean;
};

/// A duration a reader can act on, not a timestamp.
function toPeak(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "under a minute";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

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
  heroCards: HeroCard[];
  /// Calls for which we hold a peak whose window starts at the call. The rest
  /// have none, and the page says so rather than showing a partial one.
  withPeak: number;
  peakReconstructed: number;
  peakMeasured: number;
  /// A multiple needs an entry price to divide by, so it is a smaller set than
  /// `withPeak` and the page quotes both counts rather than implying one.
  withPeakAndEntry: number;
  medianPeakMultiple: number | null;
  medianTimeToPeak: string | null;
  /// A real call, used for the card anatomy. Never invented numbers.
  anatomy: {
    symbol: string;
    calledAtUsd: number | null;
    latestUsd: number | null;
    peakUsd: number | null;
    peakMultiple: number | null;
    timeToPeak: string | null;
    peakIsReconstructed: boolean;
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
  const [calls, deadCalls, entryMeasured, entryReconstructed, entryMissing, callerNarratives, oldest, dead, heroRows, anatomyRow, peakRows] =
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
      // Real cards for the hero: an image makes the wall of cards read as a
      // product rather than a table. A mix of living and dead, because the
      // dead ones staying visible is the argument.
      prisma.call.findMany({
        where: {
          channel: { role: "TRACK" },
          calledAtMarketCapUsd: { not: null },
          token: { imageUrl: { not: null } },
        },
        orderBy: { calledAt: "desc" },
        take: 9,
        select: {
          status: true, closeReason: true, calledAt: true,
          calledAtMarketCapUsd: true, latestMarketCapUsd: true, marketCapIsBackfilled: true,
          peakMarketCapUsd: true, peakAt: true, peakSource: true, peakIsBackfilled: true,
          token: { select: { symbol: true, address: true, imageUrl: true, narrative: { select: { summary: true, source: true } } } },
        },
      }),
      // Prefer a call whose entry we measured ourselves — for those we watched
      // from the first minute, so the peak is genuinely ours.
      prisma.call.findFirst({
        where: { ...where, marketCapIsBackfilled: false, calledAtMarketCapUsd: { not: null } },
        orderBy: { calledAt: "desc" },
        select: {
          calledAt: true, calledAtMarketCapUsd: true, latestMarketCapUsd: true, marketCapIsBackfilled: true,
          peakMarketCapUsd: true, peakAt: true, peakSource: true, peakIsBackfilled: true,
          token: { select: { symbol: true, address: true, narrative: { select: { summary: true, source: true } } } },
        },
      }),
      // Every call whose peak has a window that starts at the call. The medians
      // below are over these and nothing else, and the page says how many that
      // is — a median over a self-selected subset, unlabelled, is a lie with a
      // decimal point.
      prisma.call.findMany({
        where: { ...where, peakSource: { not: null }, peakMarketCapUsd: { not: null } },
        select: { calledAt: true, calledAtMarketCapUsd: true, peakMarketCapUsd: true, peakAt: true, peakIsBackfilled: true },
      }),
    ]);

  const entry = anatomyRow?.calledAtMarketCapUsd ? Number(anatomyRow.calledAtMarketCapUsd) : null;
  const peak = anatomyRow?.peakSource && anatomyRow.peakMarketCapUsd ? Number(anatomyRow.peakMarketCapUsd) : null;

  const med = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const a = [...xs].sort((x, y) => x - y);
    const i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i]! : (a[i - 1]! + a[i]!) / 2;
  };
  // Time to peak needs no entry price; a multiple does. Two subsets, counted
  // separately, because quoting one count beside both figures would overstate
  // the smaller of them.
  const withEntry = peakRows.filter((r) => r.calledAtMarketCapUsd !== null && Number(r.calledAtMarketCapUsd) > 0);
  const peakMultiples = withEntry.map((r) => Number(r.peakMarketCapUsd) / Number(r.calledAtMarketCapUsd));
  const peakDelays = peakRows
    .filter((r) => r.peakAt !== null)
    .map((r) => r.peakAt!.getTime() - r.calledAt.getTime());
  const medianDelay = med(peakDelays);

  return {
    calls,
    deadCalls,
    deadPercent: calls ? Math.round((100 * deadCalls) / calls) : 0,
    entryMeasured,
    entryReconstructed,
    entryMissing,
    callerNarratives,
    withPeak: peakRows.length,
    withPeakAndEntry: withEntry.length,
    peakReconstructed: peakRows.filter((r) => r.peakIsBackfilled).length,
    peakMeasured: peakRows.filter((r) => !r.peakIsBackfilled).length,
    medianPeakMultiple: med(peakMultiples),
    medianTimeToPeak: medianDelay === null ? null : toPeak(medianDelay),
    firstCallDate: oldest
      ? oldest.calledAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : "—",
    asOf: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    heroCards: heroRows.map((h): HeroCard => {
      const entry = Number(h.calledAtMarketCapUsd);
      const now = h.latestMarketCapUsd ? Number(h.latestMarketCapUsd) : null;
      // Gated on peakSource, never on the value: an unlabelled peak covers a
      // window we cannot describe.
      const hp = h.peakSource && h.peakMarketCapUsd ? Number(h.peakMarketCapUsd) : null;
      return {
        symbol: h.token.symbol ?? h.token.address.slice(0, 6),
        imageUrl: h.token.imageUrl,
        entryUsd: entry,
        nowUsd: now,
        nowMultiple: now && entry > 0 ? now / entry : null,
        provenance: h.marketCapIsBackfilled ? "RECONSTRUCTED" : "MEASURED",
        peakUsd: hp,
        peakMultiple: hp && entry > 0 ? hp / entry : null,
        timeToPeak: hp && h.peakAt ? toPeak(h.peakAt.getTime() - h.calledAt.getTime()) : null,
        peakIsReconstructed: h.peakIsBackfilled,
        dead: h.status === "CLOSED_DEAD",
        closeReason: h.closeReason,
        story: h.token.narrative?.summary ?? null,
        storyIsCaller: h.token.narrative?.source === "CALLER",
      };
    }),
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
          timeToPeak: peak && anatomyRow.peakAt ? toPeak(anatomyRow.peakAt.getTime() - anatomyRow.calledAt.getTime()) : null,
          peakIsReconstructed: anatomyRow.peakIsBackfilled,
          provenance: entry === null ? "MISSING" : anatomyRow.marketCapIsBackfilled ? "RECONSTRUCTED" : "MEASURED",
          narrative: anatomyRow.token.narrative?.summary ?? null,
          narrativeIsCaller: anatomyRow.token.narrative?.source === "CALLER",
        }
      : null,
  };
}
