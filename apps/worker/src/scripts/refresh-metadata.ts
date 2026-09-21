/**
 * npm run market:metadata
 *
 * Fills in token metadata — symbol, name, image and the project's own socials —
 * from DexScreener, for every token missing it.
 *
 * Phase 2 wrote these only on the live capture path, and no call was ever
 * captured live, so nothing was stored: all 55 tokens had zero socials. Phase 3
 * needs the socials, since they are the only thing a generated narrative is
 * allowed to be sourced from.
 *
 * One batched request per chain, so the whole set costs three or four calls.
 */
import "../lib/env.js";
import { prisma } from "@alphades/db";
import { waitForDatabase, withTransientRetry } from "../lib/db-wake.js";
import { fetchTokens, resolveToken } from "../market/dexscreener.js";

await waitForDatabase(prisma);

const tokens = await prisma.token.findMany({
  select: { id: true, address: true, dexChainId: true, chain: true, symbol: true },
});
const byChain = new Map<string, typeof tokens>();
const unknown: typeof tokens = [];
for (const t of tokens) {
  if (t.dexChainId) byChain.set(t.dexChainId, [...(byChain.get(t.dexChainId) ?? []), t]);
  else unknown.push(t);
}

let updated = 0, withSocials = 0, notFound = 0;
const writes: any[] = [];

async function record(t: { id: string }, obs: Awaited<ReturnType<typeof resolveToken>>) {
  if (!obs) { notFound++; return; }
  updated++;
  if (obs.websiteUrl || obs.twitterUrl || obs.telegramUrl) withSocials++;
  writes.push(
    prisma.token.update({
      where: { id: t.id },
      data: {
        dexChainId: obs.dexChainId,
        chainResolvedAt: obs.observedAt,
        poolAddress: obs.pairAddress ?? undefined,
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
}

for (const [chainId, group] of byChain) {
  const found = await fetchTokens(chainId, group.map((t) => t.address));
  for (const t of group) await record(t, found.get(t.address.toLowerCase()) ?? null);
  console.log(`  ${chainId}: ${group.length} token(s) looked up`);
}
for (const t of unknown) await record(t, await resolveToken(t.address).catch(() => null));
if (unknown.length) console.log(`  unknown chain: ${unknown.length} token(s) looked up one by one`);

// One round trip, like every other batched write in this worker.
if (writes.length) await withTransientRetry("metadata flush", () => prisma.$transaction(writes));

console.log(`\n${updated} token(s) updated, ${withSocials} have at least one social, ${notFound} not on DexScreener`);
await prisma.$disconnect();
