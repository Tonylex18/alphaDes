/**
 * GeckoTerminal: historical candles, for calls we were not there for.
 *
 * Free tier is 10 calls per minute — published on their API page, and the
 * reason this client serialises requests with a 7-second gap rather than
 * hammering. A reconstruction of ~50 calls therefore takes minutes, which is
 * fine: it runs once, from a script, not on the ingest path.
 *
 * Network slugs mostly match DexScreener's chain ids — "solana", "bsc",
 * "hyperevm" and "robinhood" all exist under the same name (checked against
 * their networks list). The exceptions are mapped below.
 */
const BASE = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };
/// 10 requests/minute published; 7s leaves headroom for clock drift.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.GECKO_MIN_INTERVAL_MS ?? 7_000);

/// DexScreener chain id -> GeckoTerminal network id, where they differ.
const NETWORK_ALIASES: Record<string, string> = {
  ethereum: "eth",
  binancesmartchain: "bsc",
  avalanche: "avax",
  polygon: "polygon_pos",
};

export function geckoNetwork(dexChainId: string): string {
  return NETWORK_ALIASES[dexChainId] ?? dexChainId;
}

let nextAllowedAt = 0;
let chain: Promise<unknown> = Promise.resolve();

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAllowedAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

const HTTP_ATTEMPTS = 3;

async function getJson(path: string): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++) {
    try {
      return await schedule(async () => {
        const res = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
        if (res.status === 429) {
          nextAllowedAt = Date.now() + 60_000;
          throw new Error("geckoterminal 429 — rate limited");
        }
        if (res.status === 404) return null; // a real answer: no such pool
        if (!res.ok) throw new Error(`geckoterminal ${path} -> HTTP ${res.status}`);
        return res.json();
      });
    } catch (e) {
      // A timeout is not evidence that history does not exist.
      lastError = e;
      if (attempt < HTTP_ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  throw lastError;
}

export class WrongSideOfPool extends Error {}

export type Candle = {
  at: Date; open: number; high: number; low: number; close: number; volumeUsd: number;
  /// Which resolution this came from. A day candle is a far weaker claim about
  /// the price at a given minute than a minute candle, and the difference has
  /// to reach the record rather than be averaged away.
  timeframe: "minute" | "hour" | "day";
  /// Seconds between the candle's start and the moment asked about.
  offsetSeconds: number;
};

/**
 * The minute candle covering `at`, if there is one.
 *
 * `before_timestamp` is exclusive of later candles, so asking for a few and
 * picking the newest one that starts at or before the call gives the minute the
 * call actually happened in.
 */
/**
 * The candle covering `at`, at the finest resolution still retained.
 *
 * GeckoTerminal's free tier keeps minute candles only for recent history, so
 * older calls fall back to hour and then day candles. The resolution used is
 * returned, not hidden: a day candle dates a price to within 24 hours, and a
 * record that cannot say which one it used is not worth much.
 */
export async function candleAt(
  network: string,
  pool: string,
  at: Date,
  /// The token the price must be FOR.
  ///
  /// GeckoTerminal prices a pool's BASE side by default, and it does not always
  /// agree with DexScreener about which side that is: for one of our pools
  /// DexScreener called the memecoin the base while GeckoTerminal called wXRP
  /// the base. Taking the default gave $1.44 (wXRP) where the token was
  /// $0.00128, and reconstructed a $1.5bn entry for a call the caller put at
  /// $3m. Passing `token` makes the side explicit, and the response is then
  /// checked to confirm it answered about the right one.
  mustPriceToken?: string,
): Promise<Candle | null> {
  const target = Math.floor(at.getTime() / 1000);
  for (const timeframe of ["minute", "hour", "day"] as const) {
    // Ask for a window ending after the target so the covering candle is in it.
    const span = timeframe === "minute" ? 120 : timeframe === "hour" ? 7200 : 172800;
    const tokenParam = mustPriceToken ? `&token=${mustPriceToken}` : "";
    const body = await getJson(
      `/networks/${network}/pools/${pool}/ohlcv/${timeframe}` +
        `?aggregate=1&limit=10&before_timestamp=${target + span}&currency=usd${tokenParam}`,
    );
    if (mustPriceToken) {
      const base = String(body?.meta?.base?.address ?? "");
      if (base && base.toLowerCase() !== mustPriceToken.toLowerCase()) {
        throw new WrongSideOfPool(
          `pool ${pool} prices ${body?.meta?.base?.symbol ?? base}, not the token asked about`,
        );
      }
    }
    const list: number[][] = body?.data?.attributes?.ohlcv_list ?? [];
    let best: Candle | null = null;
    for (const [ts, o, h, l, c, v] of list) {
      if (ts === undefined || ts > target) continue;
      const cand: Candle = {
        at: new Date(ts * 1000), open: o!, high: h!, low: l!, close: c!, volumeUsd: v ?? 0,
        timeframe, offsetSeconds: target - ts,
      };
      if (!best || cand.at > best.at) best = cand;
    }
    if (best) return best;
  }
  return null;
}

/// One OHLCV bar, unconverted. `ts` is the bar's START, in seconds.
export type Bar = { ts: number; open: number; high: number; low: number; close: number };

/// GeckoTerminal's documented maximum bars per OHLCV request.
const MAX_BARS_PER_REQUEST = 1000;

/**
 * One page of bars, newest first, ending before `beforeTs`.
 *
 * Same `token` discipline as `candleAt`: a pool has two sides and the wrong one
 * produced a $1.5bn entry once already.
 */
async function ohlcvPage(
  network: string,
  pool: string,
  timeframe: "minute" | "hour",
  beforeTs: number,
  limit: number,
  mustPriceToken?: string,
): Promise<Bar[]> {
  const tokenParam = mustPriceToken ? `&token=${mustPriceToken}` : "";
  const body = await getJson(
    `/networks/${network}/pools/${pool}/ohlcv/${timeframe}` +
      `?aggregate=1&limit=${Math.min(limit, MAX_BARS_PER_REQUEST)}` +
      `&before_timestamp=${beforeTs}&currency=usd${tokenParam}`,
  );
  if (mustPriceToken) {
    const base = String(body?.meta?.base?.address ?? "");
    if (base && base.toLowerCase() !== mustPriceToken.toLowerCase()) {
      throw new WrongSideOfPool(
        `pool ${pool} prices ${body?.meta?.base?.symbol ?? base}, not the token asked about`,
      );
    }
  }
  const list: number[][] = body?.data?.attributes?.ohlcv_list ?? [];
  const bars: Bar[] = [];
  for (const [ts, o, h, l, c] of list) {
    if (ts === undefined || !Number.isFinite(h)) continue;
    bars.push({ ts, open: o!, high: h!, low: l!, close: c! });
  }
  return bars;
}

/**
 * The minute bars that belong to a peak window starting at `fromTs`.
 *
 * The window starts at the bar CONTAINING the call, not at the call. That bar
 * begins at most 59 seconds earlier and it is the same bar the entry price was
 * read the open of, so peak and entry share a starting instant and the ratio
 * between them is a ratio of two prices.
 *
 * Exported because this is where it went wrong: the floor was once computed as
 * `Math.max(...barTimestamps, fromTs)`, and `fromTs` always wins — the call is
 * inside its bar, not at the start of it. That dropped the call's own minute
 * from every scan and understated every peak. It surfaced as a call whose peak
 * came out below its entry, which cannot happen when both are read off one bar.
 */
export function minutesInWindow(minutes: Bar[], fromTs: number, toTs: number): Bar[] {
  const startingBefore = minutes.filter((b) => b.ts <= fromTs).map((b) => b.ts);
  const floor = startingBefore.length > 0 ? Math.max(...startingBefore) : fromTs;
  return minutes.filter((b) => b.ts >= floor && b.ts <= toTs);
}

export type WindowPeak = {
  /// The highest traded price in the window, in USD.
  high: number;
  /// Start of the bar that contained it. An hour bar dates the peak to within
  /// an hour; the caller must not present it as an instant.
  at: Date;
  timeframe: "minute" | "hour";
  /// Human-readable account of what was actually scanned, for `peakSource`.
  coverage: string;
  /// True when the first partial hour of the window had to be skipped because
  /// minute bars were not retained that far back. The peak is then a lower
  /// bound, which for a token that peaked in its first hour understates badly.
  firstHourSkipped: boolean;
  /// How many HTTP requests this cost, for the run's rate-limit budget.
  requests: number;
};

/**
 * The highest price traded between `from` and `to`.
 *
 * **Why this is not the same question as `candleAt`, and why hourly is allowed
 * here.** An entry needs the price at one instant, so a coarse bar is a wrong
 * answer — a day open was 340% out, which is why those reconstructions were
 * withdrawn. A peak is the maximum over a window, and an hour bar's high is a
 * price something actually traded at inside that hour. Aggregating cannot
 * invent a high; it can only lose the exact minute it happened at, and it can
 * understate the window's edges. So hourly is sound for a maximum and unsound
 * for an instant. Day bars are still refused: they would date a peak to within
 * 24 hours, which makes "time to peak" meaningless.
 *
 * **The window.** 45 days of minute bars is ~65,000, far past the 1,000-bar cap
 * and ~65 requests per call at 10 requests/minute. So: minute bars for the
 * ~16 hours after the call, where a memecoin usually does whatever it is going
 * to do, and hourly bars, paginated, for the whole window. The two agree where
 * they overlap — an hour's high IS the maximum of its minutes — so the hourly
 * sweep finds the peak and the minute pass only sharpens when it happened.
 *
 * **The first bar.** Hour bars that START before the call are excluded: their
 * high may be a price from before the call, which nobody reading the channel
 * could have acted on. Minute bars are included from the bar containing the
 * call, because that is the bar the entry price itself came from.
 */
export async function peakBetween(
  network: string,
  pool: string,
  from: Date,
  to: Date,
  mustPriceToken?: string,
): Promise<WindowPeak | null> {
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.ceil(to.getTime() / 1000);
  if (toTs <= fromTs) return null;
  let requests = 0;

  // 1. Minute bars from the call forward — one page, ~16.6 hours.
  const minuteEnd = Math.min(toTs, fromTs + MAX_BARS_PER_REQUEST * 60);
  let minutes: Bar[] = [];
  try {
    minutes = await ohlcvPage(network, pool, "minute", minuteEnd + 60, MAX_BARS_PER_REQUEST, mustPriceToken);
    requests++;
  } catch (e) {
    if (e instanceof WrongSideOfPool) throw e;
    // Minute retention is best-effort. The hourly sweep below is the real scan.
  }
  const nearMinutes = minutesInWindow(minutes, fromTs, toTs);

  // 2. Hourly across the whole window, paginated backwards from now.
  const hours: Bar[] = [];
  let cursor = toTs + 3600;
  for (let page = 0; page < 12; page++) {
    let bars: Bar[];
    try {
      bars = await ohlcvPage(network, pool, "hour", cursor, MAX_BARS_PER_REQUEST, mustPriceToken);
      requests++;
    } catch (e) {
      if (e instanceof WrongSideOfPool) throw e;
      break;
    }
    if (bars.length === 0) break;
    hours.push(...bars);
    const oldest = Math.min(...bars.map((b) => b.ts));
    if (oldest <= fromTs || oldest >= cursor) break; // reached the call, or no progress
    cursor = oldest;
  }
  // Only hours that begin at or after the call: see the doc comment.
  const fullHours = hours.filter((b) => b.ts >= fromTs && b.ts <= toTs);

  let best: { high: number; ts: number; timeframe: "minute" | "hour" } | null = null;
  for (const b of nearMinutes) if (!best || b.high > best.high) best = { high: b.high, ts: b.ts, timeframe: "minute" };
  for (const b of fullHours) if (!best || b.high > best.high) best = { high: b.high, ts: b.ts, timeframe: "hour" };
  if (!best) return null;

  // 3. If the winner is an hour bar, try to say WHICH MINUTE inside it. Cheap
  //    (one request) and it is the difference between "3h to peak" and
  //    "3h 20m to peak", which is the number a reader actually wants.
  let refined = false;
  if (best.timeframe === "hour") {
    try {
      const inHour = await ohlcvPage(network, pool, "minute", best.ts + 3600, 60, mustPriceToken);
      requests++;
      const within = inHour.filter((b) => b.ts >= best!.ts && b.ts < best!.ts + 3600);
      let sharpest: Bar | null = null;
      for (const b of within) if (!sharpest || b.high > sharpest.high) sharpest = b;
      // Only accept the refinement if it agrees with the hour it came from.
      // A minute high well below its own hour's high means the pages disagree,
      // and a disagreement is not something to average away.
      if (sharpest && sharpest.high >= best.high * 0.98) {
        best = { high: Math.max(best.high, sharpest.high), ts: sharpest.ts, timeframe: "minute" };
        refined = true;
      }
    } catch (e) {
      if (e instanceof WrongSideOfPool) throw e;
    }
  }

  const firstHourSkipped = nearMinutes.length === 0;
  const parts = [
    `${fullHours.length} hour bar(s)`,
    nearMinutes.length > 0 ? `${nearMinutes.length} minute bar(s) from the call` : "no minute bars retained",
    refined ? "peak minute resolved inside its hour" : null,
    firstHourSkipped ? "partial first hour excluded (lower bound)" : null,
  ].filter(Boolean);

  return {
    high: best.high,
    at: new Date(best.ts * 1000),
    timeframe: best.timeframe,
    coverage: parts.join(", "),
    firstHourSkipped,
    requests,
  };
}

export type GeckoToken = { priceUsd: number | null; fdvUsd: number | null; totalSupply: number | null; symbol: string | null };

/// Current token facts, used to imply a supply when DexScreener has nothing.
export async function tokenInfo(network: string, address: string): Promise<GeckoToken | null> {
  const body = await getJson(`/networks/${network}/tokens/${address}`);
  const a = body?.data?.attributes;
  if (!a) return null;
  const decimals = Number(a.decimals ?? 0);
  const rawSupply = a.total_supply === null || a.total_supply === undefined ? null : Number(a.total_supply);
  return {
    priceUsd: a.price_usd === null ? null : Number(a.price_usd),
    fdvUsd: a.fdv_usd === null ? null : Number(a.fdv_usd),
    totalSupply: rawSupply === null || !Number.isFinite(rawSupply) ? null : rawSupply / 10 ** decimals,
    symbol: a.symbol ?? null,
  };
}

/// The token's pools, best first, for when we have no pool address stored.
export async function topPool(network: string, address: string): Promise<string | null> {
  const body = await getJson(`/networks/${network}/tokens/${address}/pools?page=1`);
  const pools: any[] = body?.data ?? [];
  let best: { id: string; liq: number } | null = null;
  for (const p of pools) {
    const id = String(p?.attributes?.address ?? "");
    const liq = Number(p?.attributes?.reserve_in_usd ?? 0);
    if (id && (!best || liq > best.liq)) best = { id, liq };
  }
  return best?.id ?? null;
}
