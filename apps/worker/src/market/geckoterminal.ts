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
