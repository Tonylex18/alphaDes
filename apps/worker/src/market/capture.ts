/**
 * Capturing `Call.calledAtMarketCapUsd` — the one number that cannot be
 * corrected later, and from which every multiple on the site is derived.
 *
 * Four rules, from CLAUDE.md rule 3 and the Phase 2 brief:
 *
 *  1. Captured on the ingest path, the moment the Call row exists — not on a
 *     later sweep.
 *  2. `marketCapObservedAt` is stored beside it. Ingest takes ~0.6s but the
 *     price lookup takes longer and may be cached, so the record states how
 *     long after the call we looked. An entry price with no timestamp cannot
 *     be checked by anyone.
 *  3. Never overwritten. The update is conditional on the column still being
 *     null, so a second attempt cannot move it even if one is somehow queued.
 *  4. A brand-new token is often not indexed yet. Retry with backoff for a
 *     bounded window, then store null WITH a reason. A null is honest; a guess
 *     is not.
 *
 * A call we did not witness — backfilled, or caught by a catch-up hours later —
 * is NOT captured here. Its current price is not its called-at price. Those go
 * to reconstruction, flagged, and the two never mix.
 */
import type { PrismaClient } from "@alphades/db";
import { resolveToken, fetchTokens, type Observation } from "./dexscreener.js";
import { withTransientRetry } from "../lib/db-wake.js";

/// A call older than this when we first see it was not witnessed live; a price
/// now would not be its called-at price.
export const CAPTURE_MAX_CALL_AGE_MS = 10 * 60_000;
/// How long to keep trying before accepting null. A pump.fun token is usually
/// indexed within seconds; past a few minutes it is not coming. Total window
/// ~8.5 minutes. Overridable so tests do not have to wait it out.
export const DEFAULT_RETRY_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

export type CaptureTarget = {
  callId: string;
  tokenId: string;
  address: string;
  /// Null when the specific chain is not yet known (any EVM token).
  dexChainId: string | null;
  calledAt: Date;
};

export type CaptureResult =
  | { ok: true; callId: string; marketCapUsd: number; lagMs: number; attempts: number }
  | { ok: false; callId: string; reason: string; attempts: number };

/// One observation for one token, whatever we know about its chain.
async function observe(address: string, dexChainId: string | null): Promise<Observation | null> {
  if (dexChainId) {
    const found = await fetchTokens(dexChainId, [address]);
    const hit = found.get(address.toLowerCase());
    if (hit) return hit;
    // Fall through: the chain we recorded may be wrong, or the pair may have
    // moved. The chain-agnostic lookup is the authority.
  }
  return resolveToken(address);
}

/**
 * Write the number, once. Also stores whatever metadata the same response
 * carried — symbol, socials, pool, and the resolved chain — since it is free.
 */
async function persist(prisma: PrismaClient, t: CaptureTarget, obs: Observation): Promise<boolean> {
  const marketCap = obs.marketCapUsd;
  if (marketCap === null || marketCap <= 0) return false;

  // Conditional on still being null: rule 3, enforced by the database rather
  // than by everyone remembering.
  const written = await withTransientRetry(`capture ${t.callId}`, () =>
    prisma.call.updateMany({
      where: { id: t.callId, calledAtMarketCapUsd: null },
      data: {
        calledAtMarketCapUsd: marketCap,
        marketCapObservedAt: obs.observedAt,
        marketCapSource: `dexscreener:${obs.dexChainId}/${obs.pairAddress ?? "?"} at ingest`,
        marketCapIsBackfilled: false,
        marketCapNullReason: null,
        latestMarketCapUsd: marketCap,
        latestAt: obs.observedAt,
        peakMarketCapUsd: marketCap,
        peakAt: obs.observedAt,
      },
    }),
  );

  await withTransientRetry(`token meta ${t.tokenId}`, () =>
    prisma.token.update({
      where: { id: t.tokenId },
      data: {
        dexChainId: obs.dexChainId,
        chainResolvedAt: obs.observedAt,
        poolAddress: obs.pairAddress,
        symbol: obs.symbol ?? undefined,
        name: obs.name ?? undefined,
        imageUrl: obs.imageUrl ?? undefined,
        websiteUrl: obs.websiteUrl ?? undefined,
        twitterUrl: obs.twitterUrl ?? undefined,
        telegramUrl: obs.telegramUrl ?? undefined,
        metadataFetched: true,
      },
    }),
  );

  // The observation itself is worth keeping as the first point on the chart.
  await withTransientRetry(`snapshot ${t.tokenId}`, () =>
    prisma.priceSnapshot.create({
      data: {
        tokenId: t.tokenId,
        at: obs.observedAt,
        marketCapUsd: obs.marketCapUsd,
        priceUsd: obs.priceUsd,
        liquidityUsd: obs.liquidityUsd,
        volume24hUsd: obs.volume24hUsd,
      },
    }),
  );

  return written.count > 0;
}

/**
 * Try to capture, retrying while the token is too new to be indexed.
 *
 * Resolves only when the number is stored or the window has closed, so a
 * caller can await it — but callers on the ingest path should not: see
 * CaptureQueue below.
 */
export async function capture(
  prisma: PrismaClient,
  t: CaptureTarget,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<CaptureResult> {
  let lastError = "no pair indexed";
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    const delay = retryDelaysMs[attempt]!;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const obs = await observe(t.address, t.dexChainId);
      if (obs && (await persist(prisma, t, obs))) {
        return {
          ok: true,
          callId: t.callId,
          marketCapUsd: obs.marketCapUsd!,
          lagMs: obs.observedAt.getTime() - t.calledAt.getTime(),
          attempts: attempt + 1,
        };
      }
      if (obs && obs.marketCapUsd === null) lastError = "pair found but no market cap";
    } catch (e) {
      lastError = String((e as Error)?.message ?? e).slice(0, 150);
    }
  }

  // Record the failure rather than leaving a silent null.
  await withTransientRetry(`capture-null ${t.callId}`, () =>
    prisma.call.updateMany({
      where: { id: t.callId, calledAtMarketCapUsd: null },
      data: {
        marketCapNullReason:
          `no market cap ${Math.round(retryDelaysMs.reduce((a, b) => a + b, 0) / 1000)}s after the call: ${lastError}`,
      },
    }),
  ).catch(() => {});

  return { ok: false, callId: t.callId, reason: lastError, attempts: retryDelaysMs.length };
}

/**
 * Captures run off the ingest path.
 *
 * The first attempt is immediate, but retries can run for minutes and the
 * ingest path must not wait: the channel lock it holds would stall every
 * message behind it. So the queue is fire-and-forget, and its results are
 * logged.
 */
export class CaptureQueue {
  private running = new Set<string>();
  readonly results: CaptureResult[] = [];

  constructor(private prisma: PrismaClient) {}

  enqueue(t: CaptureTarget): void {
    if (this.running.has(t.callId)) return;
    const age = Date.now() - t.calledAt.getTime();
    if (age > CAPTURE_MAX_CALL_AGE_MS) {
      console.log(
        `[capture] ${t.address.slice(0, 10)}… skipped: call is ${Math.round(age / 1000)}s old, ` +
          `so a price now is not its called-at price. Left for reconstruction.`,
      );
      return;
    }
    this.running.add(t.callId);
    void capture(this.prisma, t)
      .then((r) => {
        this.results.push(r);
        if (r.ok) {
          console.log(
            `[capture] ${t.address.slice(0, 10)}… $${r.marketCapUsd.toLocaleString()} ` +
              `observed ${(r.lagMs / 1000).toFixed(1)}s after the call (attempt ${r.attempts})`,
          );
        } else {
          console.warn(`[capture] ${t.address.slice(0, 10)}… no market cap: ${r.reason}`);
        }
      })
      .catch((e) => console.error(`[capture] ${t.callId} failed: ${String((e as Error)?.message ?? e)}`))
      .finally(() => this.running.delete(t.callId));
  }

  get inFlight(): number {
    return this.running.size;
  }
}
