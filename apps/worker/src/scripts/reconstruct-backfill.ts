/**
 * npm run market:reconstruct [-- --dry-run] [-- --limit N]
 *
 * Rebuilds `calledAtMarketCapUsd` for calls we were not there for, from
 * GeckoTerminal's free OHLCV, and flags every one of them
 * `marketCapIsBackfilled = true`.
 *
 * Method, recorded per call in `marketCapSource`:
 *
 *   price   the OPEN of the 1-minute candle containing the call. Open, not
 *           close: it is the price at the start of the minute the call landed
 *           in, so it cannot include a pump the call itself caused.
 *   supply  implied from a CURRENT observation as fdv / price, then multiplied
 *           by the historical price. Market cap is not in the OHLCV feed, and
 *           a memecoin's supply is fixed after launch, so this is sound —
 *           but it is an assumption, and it is written into the record.
 *
 * Anything missing leaves the number null with a reason. A null is honest.
 * Runs once, off the ingest path: GeckoTerminal's free tier is 10 calls/min.
 */
import "../lib/env.js";
import { prisma } from "@alphades/db";
import { waitForDatabase, withTransientRetry } from "../lib/db-wake.js";
import { resolveToken } from "../market/dexscreener.js";
import { candleAt, geckoNetwork, tokenInfo, topPool } from "../market/geckoterminal.js";

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;

await waitForDatabase(prisma);

const calls = await prisma.call.findMany({
  where: { calledAtMarketCapUsd: null },
  orderBy: { calledAt: "asc" },
  take: limit,
  select: {
    id: true, calledAt: true, source: true,
    token: { select: { id: true, address: true, chain: true, dexChainId: true, poolAddress: true } },
    channel: { select: { displayName: true } },
  },
});

console.log(`${calls.length} call(s) with no called-at market cap${dryRun ? " (dry run)" : ""}\n`);

let done = 0, failed = 0;
const reasons: Record<string, number> = {};
const byTimeframe: Record<string, number> = {};

for (const [i, call] of calls.entries()) {
  const t = call.token;
  const tag = `${(t.address ?? "").slice(0, 10)}…`;
  const fail = async (reason: string) => {
    failed++;
    reasons[reason.split(":")[0]!] = (reasons[reason.split(":")[0]!] ?? 0) + 1;
    console.log(`  [${i + 1}/${calls.length}] ${tag} NULL — ${reason}`);
    if (!dryRun) {
      await withTransientRetry(`null-reason ${call.id}`, () =>
        prisma.call.updateMany({
          where: { id: call.id, calledAtMarketCapUsd: null },
          data: { marketCapNullReason: `reconstruction: ${reason}`.slice(0, 500) },
        }),
        { attempts: 8, baseDelayMs: 5_000 },
      );
    }
  };

  // 1. Which chain, and which pool? DexScreener answers both in one request
  //    and does not count against GeckoTerminal's 10/min.
  let dexChainId = t.dexChainId;
  let pool = t.poolAddress;
  let impliedSupply: number | null = null;
  let supplySource = "";

  // A failed lookup and an unlisted token are different facts. Conflating them
  // writes "this token is on no chain" when the truth was a 10s timeout.
  let lookupFailed: string | null = null;
  const current = await resolveToken(t.address).catch((e) => {
    lookupFailed = String((e as Error)?.message ?? e).slice(0, 120);
    return null;
  });
  if (current) {
    dexChainId ??= current.dexChainId;
    pool ??= current.pairAddress;
    if (current.fdvUsd && current.priceUsd) {
      impliedSupply = current.fdvUsd / current.priceUsd;
      supplySource = `dexscreener fdv/price`;
    }
    if (!dryRun) {
      await withTransientRetry(`token ${t.id}`, () => prisma.token.update({
        where: { id: t.id },
        data: {
          dexChainId: current.dexChainId,
          chainResolvedAt: new Date(),
          poolAddress: current.pairAddress ?? undefined,
          symbol: current.symbol ?? undefined,
          name: current.name ?? undefined,
        },
      }), { attempts: 8, baseDelayMs: 5_000 });
    }
  }

  if (!dexChainId && t.chain === "SOLANA") dexChainId = "solana"; // the one chain the address shape does tell us
  if (!dexChainId) {
    await fail(
      lookupFailed
        ? `lookup failed: ${lookupFailed} — retry, do not treat as a verdict`
        : "chain unknown: no DexScreener pair and the address is EVM, which names no chain",
    );
    continue;
  }
  const network = geckoNetwork(dexChainId);

  // 2. A pool, and a supply, from GeckoTerminal if DexScreener had nothing.
  if (!pool) pool = await topPool(network, t.address).catch(() => null);
  if (!pool) {
    await fail(`no pool on ${network}: token never indexed, or delisted`);
    continue;
  }
  if (impliedSupply === null) {
    const info = await tokenInfo(network, t.address).catch(() => null);
    if (info?.fdvUsd && info.priceUsd) {
      impliedSupply = info.fdvUsd / info.priceUsd;
      supplySource = "geckoterminal fdv/price";
    } else if (info?.totalSupply) {
      impliedSupply = info.totalSupply;
      supplySource = "geckoterminal total_supply";
    }
  }
  if (impliedSupply === null || !Number.isFinite(impliedSupply) || impliedSupply <= 0) {
    await fail(`no supply: neither source reports a current price and fdv on ${network}`);
    continue;
  }

  // 3. The candle the call landed in.
  let candleError: string | null = null;
  const candle = await candleAt(network, pool, call.calledAt, t.address).catch((e) => {
    candleError = String((e as Error)?.message ?? e).slice(0, 120);
    return null;
  });
  if (!candle) {
    await fail(
      candleError
        ? `lookup failed: ${candleError} — retry, do not treat as a verdict`
        : `no candle at ${call.calledAt.toISOString()} on ${network} at any resolution — history not retained`,
    );
    continue;
  }
  // Day candles are refused. Measured against the callers' own stated figures:
  // minute candles disagree by a median 8%, an hour candle by 54%, and day
  // candles by 340% — a token that moves 7x in a day cannot have its entry
  // priced from that day's open. A number that wrong in the denominator of
  // every multiple is worse than no number.
  if (candle.timeframe === "day") {
    await fail(
      `only a day candle available at ${call.calledAt.toISOString()} on ${network} — too coarse to price an entry`,
    );
    continue;
  }

  const marketCap = candle.open * impliedSupply;
  if (!Number.isFinite(marketCap) || marketCap <= 0) {
    await fail("candle produced no usable market cap");
    continue;
  }
  // A last guard against a method that has silently gone wrong. These are
  // memecoins called in Telegram channels; a billion-dollar entry is a bug,
  // not a find. Better an explained null than a fabricated number in the one
  // column everything else divides by.
  if (marketCap > 1_000_000_000) {
    await fail(`implausible: $${Math.round(marketCap).toLocaleString()} from a ${candle.timeframe} candle — method unsound for this pool`);
    continue;
  }

  const offsetS = candle.offsetSeconds;
  const source =
    `geckoterminal:ohlcv ${candle.timeframe} open @${candle.at.toISOString()} ` +
    `(${offsetS}s before the call) x supply ${impliedSupply.toExponential(4)} implied from ${supplySource}`;

  // A day candle dates a price to within 24 hours. Still worth having, but the
  // reader must be able to see which calls rest on one.
  byTimeframe[candle.timeframe] = (byTimeframe[candle.timeframe] ?? 0) + 1;
  console.log(
    `  [${i + 1}/${calls.length}] ${tag} $${Math.round(marketCap).toLocaleString()} ` +
      `(${candle.timeframe} candle, ${offsetS}s before the call, ${network})`,
  );
  done++;

  if (!dryRun) {
    // Conditional on still being null: a reconstruction must never overwrite a
    // measured number, even if this script is run twice.
    await withTransientRetry(`reconstruct ${call.id}`, () => prisma.call.updateMany({
      where: { id: call.id, calledAtMarketCapUsd: null },
      data: {
        calledAtMarketCapUsd: marketCap,
        marketCapObservedAt: candle.at,
        marketCapSource: source.slice(0, 500),
        marketCapIsBackfilled: true,
        marketCapNullReason: null,
      },
    }), { attempts: 8, baseDelayMs: 5_000 });
  }
}

console.log(`\nreconstructed ${done}, still null ${failed}`);
if (done) console.log("candle resolution used:", byTimeframe);
if (failed) console.log("reasons:", reasons);
await prisma.$disconnect();
