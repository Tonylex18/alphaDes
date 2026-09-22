/**
 * The price loop: poll fast while a call is young, back off as it ages — and
 * write to the database as little as possible.
 *
 * THE NEON TRAP. A snapshot per token every 30 seconds would be ten times the
 * write rate the heartbeat had, and the heartbeat was moved out of the database
 * precisely so Neon's compute could sleep. Any write wakes it for at least five
 * minutes. So:
 *
 *   - polling happens in MEMORY, at the cadence the token's age deserves;
 *   - the database is written on a slow cadence (FLUSH_INTERVAL_MS) or when
 *     something happened that a reader would notice: a new peak, or a call
 *     dying;
 *   - a flush writes every pending token in ONE round trip.
 *
 * DexScreener's batch endpoint means a poll of every token we track costs two
 * or three HTTP requests, not one per token.
 */
import type { PrismaClient } from "@alphades/db";
import { fetchTokens, resolveToken, type Observation } from "./dexscreener.js";
import { withTransientRetry } from "../lib/db-wake.js";
import { revalidateFeed } from "../lib/revalidate.js";

/// Age -> how often to look. Young tokens move; week-old ones do not.
const CADENCE: { maxAgeMs: number; everyMs: number }[] = [
  { maxAgeMs: 60 * 60_000, everyMs: 30_000 },        // first hour: 30s
  { maxAgeMs: 6 * 3600_000, everyMs: 2 * 60_000 },   // to 6h: 2min
  { maxAgeMs: 24 * 3600_000, everyMs: 10 * 60_000 }, // to 24h: 10min
  { maxAgeMs: 7 * 86400_000, everyMs: 60 * 60_000 }, // to a week: hourly
  { maxAgeMs: Infinity, everyMs: 6 * 3600_000 },     // after that: 6-hourly
];

export const FLUSH_INTERVAL_MS = Number(process.env.MARKET_FLUSH_INTERVAL_MS ?? 15 * 60_000);
/// Below this, a move is noise and not worth waking the database for.
const MEANINGFUL_CHANGE = 0.01;
/// Dead rules. Liquidity is sometimes absent from a healthy pair, so only a
/// number below the floor counts — never a missing one.
const DEAD_LIQUIDITY_USD = 500;
const DEAD_MARKET_CAP_USD = 1_000;
/// A rug and an API blip look identical once. They stop looking identical when
/// the same verdict repeats.
const DEAD_STRIKES_REQUIRED = 2;
/// How soon to re-check a token that just looked dead.
const DEAD_CONFIRM_MS = 60_000;

export type Tracked = {
  callId: string;
  tokenId: string;
  address: string;
  dexChainId: string | null;
  calledAt: Date;
  calledAtMarketCapUsd: number | null;
  status: "ACTIVE" | "CLOSED_DEAD" | "CLOSED_MANUAL";
  deadStrikes: number;
  /// Live view, in memory.
  latest: Observation | null;
  peakMarketCapUsd: number | null;
  peakAt: Date | null;
  /// What the database currently holds, so we can tell whether a write is
  /// actually needed.
  persistedLatest: number | null;
  persistedPeak: number | null;
  lastFlushAt: number;
  nextPollAt: number;
  /// Consecutive polls where DexScreener knew nothing about the token.
  missingStrikes: number;
};

export function cadenceFor(calledAt: Date, now = Date.now()): number {
  const age = now - calledAt.getTime();
  return (CADENCE.find((c) => age < c.maxAgeMs) ?? CADENCE[CADENCE.length - 1]!).everyMs;
}

/// Why this observation says the token is dead, or null if it does not.
export function deathVerdict(obs: Observation | null, ageMs: number): string | null {
  if (obs === null) return "no pair on DexScreener";
  if (obs.liquidityUsd !== null && obs.liquidityUsd < DEAD_LIQUIDITY_USD) {
    return `liquidity $${Math.round(obs.liquidityUsd)} below $${DEAD_LIQUIDITY_USD}`;
  }
  if (obs.marketCapUsd !== null && obs.marketCapUsd < DEAD_MARKET_CAP_USD) {
    return `market cap $${Math.round(obs.marketCapUsd)} below $${DEAD_MARKET_CAP_USD}`;
  }
  // Zero volume is only meaningful once a token has had time to trade.
  if (ageMs > 3600_000 && obs.volume24hUsd !== null && obs.volume24hUsd === 0) {
    return "no volume in 24h";
  }
  return null;
}

export class MarketPoller {
  private tokens = new Map<string, Tracked>();
  private pendingFlush = new Set<string>();
  stats = { polls: 0, observations: 0, flushes: 0, rowsWritten: 0, closed: 0, httpErrors: 0 };

  constructor(private prisma: PrismaClient) {}

  /// Load every call whose token is still worth watching. One query, at start.
  async load(): Promise<number> {
    const calls = await this.prisma.call.findMany({
      where: { status: { not: "CLOSED_MANUAL" } },
      select: {
        id: true, calledAt: true, status: true, deadStrikes: true,
        calledAtMarketCapUsd: true, latestMarketCapUsd: true, peakMarketCapUsd: true, peakAt: true,
        token: { select: { id: true, address: true, dexChainId: true } },
      },
    });
    const now = Date.now();
    for (const c of calls) {
      if (c.status === "CLOSED_DEAD") continue; // dead stays visible, but needs no polling
      this.tokens.set(c.id, {
        callId: c.id,
        tokenId: c.token.id,
        address: c.token.address,
        dexChainId: c.token.dexChainId,
        calledAt: c.calledAt,
        calledAtMarketCapUsd: c.calledAtMarketCapUsd === null ? null : Number(c.calledAtMarketCapUsd),
        status: c.status as Tracked["status"],
        deadStrikes: c.deadStrikes,
        latest: null,
        peakMarketCapUsd: c.peakMarketCapUsd === null ? null : Number(c.peakMarketCapUsd),
        peakAt: c.peakAt,
        persistedLatest: c.latestMarketCapUsd === null ? null : Number(c.latestMarketCapUsd),
        persistedPeak: c.peakMarketCapUsd === null ? null : Number(c.peakMarketCapUsd),
        lastFlushAt: now,
        nextPollAt: now,
        missingStrikes: 0,
      });
    }
    return this.tokens.size;
  }

  /// Add a call the listener just created, so it is polled without a restart.
  track(t: Omit<Tracked, "latest" | "peakMarketCapUsd" | "peakAt" | "persistedLatest" | "persistedPeak" | "lastFlushAt" | "nextPollAt" | "missingStrikes" | "status" | "deadStrikes">) {
    if (this.tokens.has(t.callId)) return;
    this.tokens.set(t.callId, {
      ...t, status: "ACTIVE", deadStrikes: 0, latest: null,
      peakMarketCapUsd: null, peakAt: null, persistedLatest: null, persistedPeak: null,
      lastFlushAt: Date.now(), nextPollAt: Date.now() + 30_000, missingStrikes: 0,
    });
  }

  get tracked(): number {
    return this.tokens.size;
  }

  private polling = false;

  /// One pass: fetch everything due, update memory, mark what needs writing.
  ///
  /// Never runs concurrently with itself. A poll takes seconds (HTTP), so a
  /// caller on a short timer can start a second one while the first is still
  /// awaiting — and then the same token is observed twice from one fetch,
  /// which quietly defeats the two-strike rule that stops an API blip being
  /// read as a rug. Measured: 12 dead tokens reported as 48 closures.
  async poll(now = Date.now()): Promise<void> {
    if (this.polling) return;
    const due = [...this.tokens.values()].filter((t) => t.status === "ACTIVE" && t.nextPollAt <= now);
    if (due.length === 0) return;
    this.polling = true;
    try {
      await this.pollDue(due, now);
    } finally {
      this.polling = false;
    }
  }

  private async pollDue(due: Tracked[], now: number): Promise<void> {
    this.stats.polls++;

    // Group by chain so each chain costs one batched request (or a handful).
    const byChain = new Map<string, Tracked[]>();
    const unknownChain: Tracked[] = [];
    for (const t of due) (t.dexChainId ? byChain.get(t.dexChainId) ?? byChain.set(t.dexChainId, []).get(t.dexChainId)! : unknownChain).push(t);

    const observations = new Map<string, Observation | null>();
    for (const [chainId, group] of byChain) {
      try {
        const found = await fetchTokens(chainId, group.map((t) => t.address));
        for (const t of group) observations.set(t.callId, found.get(t.address.toLowerCase()) ?? null);
      } catch (e) {
        this.stats.httpErrors++;
        console.warn(`[market] ${chainId} batch failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        for (const t of group) t.nextPollAt = now + cadenceFor(t.calledAt, now); // try again next cycle
      }
    }
    // Tokens whose chain we do not know yet: one request each, which is why
    // the resolved chain is stored the first time we learn it.
    for (const t of unknownChain) {
      try {
        observations.set(t.callId, await resolveToken(t.address));
      } catch (e) {
        this.stats.httpErrors++;
        t.nextPollAt = now + cadenceFor(t.calledAt, now);
      }
    }

    for (const [callId, obs] of observations) {
      const t = this.tokens.get(callId);
      if (!t) continue;
      const before = t.nextPollAt;
      t.nextPollAt = now + cadenceFor(t.calledAt, now);
      this.apply(t, obs, now);
      // apply() may have asked for a sooner confirmation poll; respect it.
      if (t.nextPollAt > before && before > now) t.nextPollAt = Math.min(t.nextPollAt, before);
    }
  }

  private apply(t: Tracked, obs: Observation | null, now: number) {
    this.stats.observations++;
    const ageMs = now - t.calledAt.getTime();

    if (obs) {
      t.missingStrikes = 0;
      t.latest = obs;
      if (obs.dexChainId && obs.dexChainId !== t.dexChainId) t.dexChainId = obs.dexChainId;
      if (obs.marketCapUsd !== null && (t.peakMarketCapUsd === null || obs.marketCapUsd > t.peakMarketCapUsd)) {
        t.peakMarketCapUsd = obs.marketCapUsd;
        t.peakAt = obs.observedAt;
      }
    } else {
      t.missingStrikes++;
    }

    if (t.status !== "ACTIVE") return;

    const verdict = deathVerdict(obs, ageMs);
    if (verdict) {
      t.deadStrikes++;
      if (t.deadStrikes < DEAD_STRIKES_REQUIRED) {
        // Confirm soon rather than at the token's age-based cadence: a week-old
        // call polls every 6 hours, and "rugged" should not take 6 hours to
        // confirm. The second strike still has to be a separate observation.
        t.nextPollAt = now + DEAD_CONFIRM_MS;
      }
      if (t.deadStrikes >= DEAD_STRIKES_REQUIRED) {
        t.status = "CLOSED_DEAD";
        this.stats.closed++;
        console.log(`[market] ${t.address.slice(0, 10)}… closed dead: ${verdict}`);
        this.pendingFlush.add(t.callId);
        (t as Tracked & { closeReason?: string }).closeReason = verdict;
        return;
      }
    } else {
      t.deadStrikes = 0;
    }

    // Worth a write?
    const moved = (a: number | null, b: number | null) =>
      a === null || b === null ? a !== b : Math.abs(a - b) / Math.max(b, 1) >= MEANINGFUL_CHANGE;
    const newPeak = t.peakMarketCapUsd !== null && moved(t.peakMarketCapUsd, t.persistedPeak);
    const stale = now - t.lastFlushAt >= FLUSH_INTERVAL_MS;
    const changed = moved(t.latest?.marketCapUsd ?? null, t.persistedLatest);
    if (newPeak || (stale && changed)) this.pendingFlush.add(t.callId);
  }

  /// Write everything pending in one round trip. Called on a slow timer.
  async flush(now = Date.now()): Promise<number> {
    if (this.pendingFlush.size === 0) return 0;
    const ids = [...this.pendingFlush];
    this.pendingFlush.clear();

    const writes: any[] = [];
    const snapshots: any[] = [];
    for (const id of ids) {
      const t = this.tokens.get(id);
      if (!t) continue;
      const closeReason = (t as Tracked & { closeReason?: string }).closeReason;
      writes.push(
        this.prisma.call.update({
          where: { id: t.callId },
          data: {
            // calledAtMarketCapUsd is NEVER touched here. Rule 3.
            latestMarketCapUsd: t.latest?.marketCapUsd ?? undefined,
            latestAt: t.latest?.observedAt ?? undefined,
            peakMarketCapUsd: t.peakMarketCapUsd ?? undefined,
            peakAt: t.peakAt ?? undefined,
            deadStrikes: t.deadStrikes,
            ...(t.status === "CLOSED_DEAD"
              ? { status: "CLOSED_DEAD" as const, closedAt: new Date(), closeReason: closeReason ?? "dead" }
              : {}),
          },
        }),
      );
      if (t.latest?.symbol || t.latest?.websiteUrl || t.latest?.twitterUrl || t.latest?.telegramUrl) {
        // Metadata is free — it rides along on a price observation we already
        // made. Phase 3 needs the socials, and only a live capture stored them
        // before, which meant none were ever stored at all.
        writes.push(
          this.prisma.token.update({
            where: { id: t.tokenId },
            data: {
              dexChainId: t.latest.dexChainId,
              chainResolvedAt: t.latest.observedAt,
              poolAddress: t.latest.pairAddress ?? undefined,
              symbol: t.latest.symbol ?? undefined,
              name: t.latest.name ?? undefined,
              imageUrl: t.latest.imageUrl ?? undefined,
              websiteUrl: t.latest.websiteUrl ?? undefined,
              twitterUrl: t.latest.twitterUrl ?? undefined,
              telegramUrl: t.latest.telegramUrl ?? undefined,
              metadataFetched: true,
            },
          }),
        );
      }
      if (t.latest) {
        snapshots.push({
          tokenId: t.tokenId,
          at: t.latest.observedAt,
          marketCapUsd: t.latest.marketCapUsd,
          priceUsd: t.latest.priceUsd,
          liquidityUsd: t.latest.liquidityUsd,
          volume24hUsd: t.latest.volume24hUsd,
        });
        t.persistedLatest = t.latest.marketCapUsd;
      }
      t.persistedPeak = t.peakMarketCapUsd;
      t.lastFlushAt = now;
      if (t.status === "CLOSED_DEAD") this.tokens.delete(t.callId); // visible in the database, no longer polled
    }
    if (snapshots.length > 0) writes.push(this.prisma.priceSnapshot.createMany({ data: snapshots }));

    // Array form: one round trip, not an interactive transaction (whose 5s
    // default is shorter than a Neon cold start).
    await withTransientRetry("market flush", () => this.prisma.$transaction(writes));
    this.stats.flushes++;
    this.stats.rowsWritten += writes.length;
    console.log(`[market] flushed ${ids.length} call(s), ${snapshots.length} snapshot(s)`);
    revalidateFeed("price flush");
    return ids.length;
  }

  statsLine(): string {
    const active = [...this.tokens.values()].filter((t) => t.status === "ACTIVE").length;
    return (
      `[market] tracking=${active} polls=${this.stats.polls} observations=${this.stats.observations} ` +
      `flushes=${this.stats.flushes} rows=${this.stats.rowsWritten} closed=${this.stats.closed} ` +
      `httpErrors=${this.stats.httpErrors} pendingFlush=${this.pendingFlush.size}`
    );
  }
}
