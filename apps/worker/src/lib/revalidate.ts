/**
 * Telling the feed that something changed.
 *
 * The worker is the only writer, so it is the only thing that knows when the
 * feed's cached payload is stale. Pushing from here is what lets the web app
 * poll without ever touching Neon: readers never trigger a query, the writer
 * does.
 *
 * Fire-and-forget and deliberately toothless — a feed that fails to refresh is
 * a cosmetic problem, and it must never be able to fail an ingest or a flush.
 */
const URL_ = process.env.FEED_REVALIDATE_URL;
const SECRET = process.env.REVALIDATE_SECRET;

let lastWarnedAt = 0;

export function revalidateFeed(why: string): void {
  if (!URL_ || !SECRET) return; // not configured: local worker, no web app
  void fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(5_000),
  })
    .then((res) => {
      if (!res.ok && Date.now() - lastWarnedAt > 300_000) {
        lastWarnedAt = Date.now();
        console.warn(`[feed] revalidate after ${why} returned HTTP ${res.status}`);
      }
    })
    .catch((e) => {
      if (Date.now() - lastWarnedAt > 300_000) {
        lastWarnedAt = Date.now();
        console.warn(`[feed] revalidate after ${why} failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
    });
}
