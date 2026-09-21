/**
 * DexScreener: prices, market caps and token metadata. No key, no account.
 *
 * RATE LIMITS. DexScreener publishes "60 requests per minute" for its profile
 * and trending endpoints, but the reference page renders the limits for the
 * price endpoints client-side and they could not be read from the document;
 * the responses carry no rate-limit headers either (checked). So the limit used
 * here is chosen, not quoted: one request per 2 seconds, 30/minute, below the
 * lowest figure DexScreener publishes for anything.
 *
 * That is affordable because the batch endpoint takes many addresses at once —
 * measured: 30 addresses in one request, one pair returned per token. Every
 * token we track is covered by two or three requests per poll, not fifty.
 *
 * A token with no pair is a normal answer, not an error: 7 of 30 of our tokens
 * came back empty, which is what a rugged or never-indexed token looks like.
 */

const BASE = "https://api.dexscreener.com";
/// Measured to work; kept below it for headroom.
export const MAX_ADDRESSES_PER_REQUEST = 25;
const MIN_REQUEST_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type Observation = {
  address: string;
  /// DexScreener's chain id: "solana", "bsc", "hyperevm", "robinhood"...
  dexChainId: string;
  pairAddress: string | null;
  dexId: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pairCreatedAt: Date | null;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;
  /// When WE received the response. Every number above is as of this moment,
  /// give or take DexScreener's own caching — which is why it is recorded.
  observedAt: Date;
};

// ---------------------------------------------------------------------------

let nextAllowedAt = 0;
let chain: Promise<unknown> = Promise.resolve();

/// Serialise every request through one queue with a minimum gap. Simpler than
/// a token bucket and impossible to burst through by accident.
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

export class RateLimited extends Error {}

/// Transient by nature: a timeout or a 5xx says nothing about the token.
/// Measured the hard way — a 10s timeout on one lookup was being recorded as
/// "this token is on no chain", which is a network fact masquerading as a fact
/// about the token.
const HTTP_ATTEMPTS = 3;

async function getJson(path: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++) {
    try {
      return await schedule(async () => {
        const res = await fetch(`${BASE}${path}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 429) {
          // Back off hard: the next request waits a full minute.
          nextAllowedAt = Date.now() + 60_000;
          throw new RateLimited("dexscreener returned 429");
        }
        if (res.status >= 500) throw new Error(`dexscreener ${path} -> HTTP ${res.status}`);
        if (!res.ok) throw new NotRetryable(`dexscreener ${path} -> HTTP ${res.status}`);
        return res.json();
      });
    } catch (e) {
      lastError = e;
      if (e instanceof NotRetryable) throw e;
      if (attempt < HTTP_ATTEMPTS) await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  throw lastError;
}

export class NotRetryable extends Error {}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function toObservation(pair: any, observedAt: Date): Observation | null {
  const address = pair?.baseToken?.address;
  const dexChainId = pair?.chainId;
  if (typeof address !== "string" || typeof dexChainId !== "string") return null;
  const websites: any[] = pair?.info?.websites ?? [];
  const socials: any[] = pair?.info?.socials ?? [];
  const social = (type: string) =>
    socials.find((s) => String(s?.type ?? "").toLowerCase() === type)?.url ?? null;
  return {
    address,
    dexChainId,
    pairAddress: pair?.pairAddress ?? null,
    dexId: pair?.dexId ?? null,
    priceUsd: num(pair?.priceUsd),
    // marketCap is circulating; fdv is fully diluted. For the memecoins we
    // track they are usually identical — fall back rather than report nothing.
    marketCapUsd: num(pair?.marketCap) ?? num(pair?.fdv),
    fdvUsd: num(pair?.fdv),
    liquidityUsd: num(pair?.liquidity?.usd),
    volume24hUsd: num(pair?.volume?.h24),
    pairCreatedAt: pair?.pairCreatedAt ? new Date(pair.pairCreatedAt) : null,
    symbol: pair?.baseToken?.symbol ?? null,
    name: pair?.baseToken?.name ?? null,
    imageUrl: pair?.info?.imageUrl ?? null,
    websiteUrl: websites[0]?.url ?? null,
    twitterUrl: social("twitter"),
    telegramUrl: social("telegram"),
    observedAt,
  };
}

/// Of several pairs for one token, the one with the deepest liquidity is the
/// one whose price means anything.
function bestPair(pairs: any[]): any | null {
  let best: any = null;
  let bestLiq = -1;
  for (const p of pairs) {
    const liq = num(p?.liquidity?.usd) ?? 0;
    if (liq > bestLiq) {
      best = p;
      bestLiq = liq;
    }
  }
  return best;
}

/**
 * Prices for many tokens on ONE known chain, in one request.
 * Tokens with no indexed pair are simply absent from the result.
 */
export async function fetchTokens(dexChainId: string, addresses: string[]): Promise<Map<string, Observation>> {
  const out = new Map<string, Observation>();
  for (let i = 0; i < addresses.length; i += MAX_ADDRESSES_PER_REQUEST) {
    const slice = addresses.slice(i, i + MAX_ADDRESSES_PER_REQUEST);
    const body = (await getJson(`/tokens/v1/${dexChainId}/${slice.join(",")}`)) as any;
    const observedAt = new Date();
    const pairs: any[] = Array.isArray(body) ? body : (body?.pairs ?? []);
    const byToken = new Map<string, any[]>();
    for (const p of pairs) {
      const a = p?.baseToken?.address;
      if (typeof a === "string") byToken.set(a, [...(byToken.get(a) ?? []), p]);
    }
    for (const [addr, ps] of byToken) {
      const obs = toObservation(bestPair(ps), observedAt);
      if (obs) out.set(addr.toLowerCase(), obs);
    }
  }
  return out;
}

/**
 * Find a token when we do not know its chain yet. This is how an EVM address
 * gets narrowed from "some EVM chain" to bsc / hyperevm / robinhood — none of
 * which can be told apart from the address.
 */
export async function resolveToken(address: string): Promise<Observation | null> {
  const body = (await getJson(`/latest/dex/tokens/${address}`)) as any;
  const pairs: any[] = body?.pairs ?? [];
  // Only pairs where OUR token is the base. A pair where it is the quote side
  // reports the other asset's price and market cap, and attributing those to
  // this token would write a wrong entry price into the one column that can
  // never be corrected. (The same mistake, made against GeckoTerminal OHLCV,
  // produced a $1.5bn reconstruction for a token the caller put at $3m.)
  const ours = pairs.filter(
    (p) => String(p?.baseToken?.address ?? "").toLowerCase() === address.toLowerCase(),
  );
  if (ours.length === 0) return null;
  return toObservation(bestPair(ours), new Date());
}
