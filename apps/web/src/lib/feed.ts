/**
 * The feed query, and the one decision that keeps Neon asleep.
 *
 * THE TRAP. The worker was carefully batched so the database can suspend — a
 * flush every 15 minutes, nothing in between. A feed that polls the database
 * every few seconds undoes all of it, and unlike the worker it scales with
 * VISITORS: ten people watching is ten times the load, and the database never
 * sleeps again.
 *
 * WHAT WE DO INSTEAD. The worker already knows the instant something changes —
 * it is the only writer. So:
 *
 *   - this query is cached by tag, with a long TTL (10 minutes);
 *   - the worker POSTs to /api/revalidate the moment it creates a call or
 *     flushes prices, which drops the tag;
 *   - browsers poll /api/feed every few seconds, and that route serves the
 *     cached payload without touching the database at all.
 *
 * So database reads scale with WRITES, not with viewers or with time. A hundred
 * people watching an idle feed cost exactly nothing, and a new call still shows
 * up within seconds because the writer pushed rather than the readers pulled.
 */
import { prisma } from "@alphades/db";
import { unstable_cache } from "next/cache";

export const FEED_TAG = "feed";
/// Only a backstop. Normal freshness comes from the worker's push, not from
/// this expiring.
const FEED_TTL_SECONDS = 600;

export type FeedCall = {
  id: string;
  calledAt: string;
  status: "ACTIVE" | "CLOSED_DEAD" | "CLOSED_MANUAL";
  closeReason: string | null;
  channel: string;
  token: {
    address: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    chain: string;
    dexChainId: string | null;
  };
  /// The one number everything derives from — and where it came from.
  entry: {
    marketCapUsd: number | null;
    /// MEASURED at ingestion, RECONSTRUCTED from history, or MISSING.
    provenance: "MEASURED" | "RECONSTRUCTED" | "MISSING";
    observedAt: string | null;
    /// Seconds between the call landing and the observation behind the number.
    observedLagSeconds: number | null;
    source: string | null;
    nullReason: string | null;
  };
  /// What the caller claimed, kept apart from what we measured.
  statedMarketCapUsd: number | null;
  latestMarketCapUsd: number | null;
  peakMarketCapUsd: number | null;
  /// Null whenever the entry price is null. A multiple computed from nothing is
  /// not a small inaccuracy, it is a fabrication.
  latestMultiple: number | null;
  peakMultiple: number | null;
  narrative: {
    source: "CALLER" | "GENERATED" | "NONE" | "PENDING";
    summary: string | null;
    nullReason: string | null;
    sourceUrls: string[];
  };
  eventCount: number;
};

function multiple(now: number | null, entry: number | null): number | null {
  // No entry price means no multiple. Not zero, not one, not a dash that could
  // be read as either.
  if (entry === null || now === null || entry <= 0) return null;
  return now / entry;
}

async function readFeed(limit: number): Promise<FeedCall[]> {
  const calls = await prisma.call.findMany({
    orderBy: { calledAt: "desc" },
    take: limit,
    include: {
      channel: { select: { displayName: true, role: true } },
      token: { include: { narrative: true } },
      _count: { select: { events: true } },
    },
  });

  return calls
    // OBSERVE channels are measured, never shown. They write nothing anyway;
    // this is belt and braces so an observation channel can never reach a card.
    .filter((c) => c.channel.role === "TRACK")
    .map((c): FeedCall => {
      const entry = c.calledAtMarketCapUsd === null ? null : Number(c.calledAtMarketCapUsd);
      const latest = c.latestMarketCapUsd === null ? null : Number(c.latestMarketCapUsd);
      const peak = c.peakMarketCapUsd === null ? null : Number(c.peakMarketCapUsd);
      const n = c.token.narrative;
      return {
        id: c.id,
        calledAt: c.calledAt.toISOString(),
        status: c.status as FeedCall["status"],
        closeReason: c.closeReason,
        channel: c.channel.displayName,
        token: {
          address: c.token.address,
          symbol: c.token.symbol,
          name: c.token.name,
          imageUrl: c.token.imageUrl,
          chain: c.token.chain,
          dexChainId: c.token.dexChainId,
        },
        entry: {
          marketCapUsd: entry,
          provenance: entry === null ? "MISSING" : c.marketCapIsBackfilled ? "RECONSTRUCTED" : "MEASURED",
          observedAt: c.marketCapObservedAt?.toISOString() ?? null,
          observedLagSeconds:
            c.marketCapObservedAt === null
              ? null
              : Math.round((c.marketCapObservedAt.getTime() - c.calledAt.getTime()) / 1000),
          source: c.marketCapSource,
          nullReason: c.marketCapNullReason,
        },
        statedMarketCapUsd: c.statedMarketCapUsd === null ? null : Number(c.statedMarketCapUsd),
        latestMarketCapUsd: latest,
        peakMarketCapUsd: peak,
        latestMultiple: multiple(latest, entry),
        peakMultiple: multiple(peak, entry),
        narrative: {
          // No row yet is not the same as "we looked and found nothing".
          source: n === null ? "PENDING" : (n.source as "CALLER" | "GENERATED" | "NONE"),
          summary: n?.summary ?? null,
          nullReason: n?.nullReason ?? null,
          sourceUrls: n?.sourceUrls ?? [],
        },
        eventCount: c._count.events,
      };
    });
}

/// Cached by tag. The worker drops the tag when it writes; nothing else reads
/// the database on the request path.
export const getFeed = unstable_cache(readFeed, ["feed-v1"], {
  tags: [FEED_TAG],
  revalidate: FEED_TTL_SECONDS,
});
