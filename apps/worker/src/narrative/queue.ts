/**
 * Generating a narrative for a call that just landed, off the ingest path.
 *
 * Runs after the market-cap capture, because capture is what stores the token's
 * socials — and the socials are the only thing a generated narrative may be
 * sourced from.
 *
 * Nothing here decides "is this a BARE_CA channel". It asks whether the token
 * already has a narrative. A call from a NARRATIVE channel arrives with the
 * caller's own words already written at ingest, so it is skipped for the right
 * reason: it has a narrative, and we never replace one.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@alphades/db";
import { withTransientRetry } from "../lib/db-wake.js";
import { generateNarrative, MODEL } from "./generate.js";

export class NarrativeQueue {
  private running = new Set<string>();
  readonly stats = { generated: 0, none: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };

  constructor(
    private prisma: PrismaClient,
    private client: Anthropic,
  ) {}

  /// Fire and forget. The call row and its market cap are already written; a
  /// story arriving a few seconds later is not worth blocking anything for.
  enqueue(tokenId: string): void {
    if (this.running.has(tokenId)) return;
    this.running.add(tokenId);
    void this.run(tokenId)
      .catch((e) => console.error(`[narrative] ${tokenId}: ${String((e as Error)?.message ?? e).split("\n")[0]}`))
      .finally(() => this.running.delete(tokenId));
  }

  private async run(tokenId: string): Promise<void> {
    const token = await this.prisma.token.findUnique({
      where: { id: tokenId },
      select: {
        id: true, address: true, symbol: true, name: true,
        websiteUrl: true, twitterUrl: true, telegramUrl: true,
        narrative: { select: { id: true } },
      },
    });
    // Already has one — the caller's words, a previous generation, or a
    // recorded "nothing to say". All three mean leave it alone.
    if (!token || token.narrative) return;

    const r = await generateNarrative(this.client, token);
    this.stats.inputTokens += r.inputTokens;
    this.stats.outputTokens += r.outputTokens;
    this.stats.costUsd += r.costUsd;

    const data = r.ok
      ? {
          tokenId, source: "GENERATED" as const, summary: r.summary,
          sourceNote: "Summarised from the project's own socials",
          sourceUrls: r.sourceUrls, model: MODEL,
          inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd,
        }
      : {
          tokenId, source: "NONE" as const, summary: null, nullReason: r.reason.slice(0, 500),
          sourceNote: "No narrative: the project published nothing we could read",
          sourceUrls: r.sourceUrls, model: r.inputTokens > 0 ? MODEL : null,
          inputTokens: r.inputTokens || null, outputTokens: r.outputTokens || null,
          costUsd: r.costUsd || null,
        };

    // One row, written once. The unique constraint on tokenId is the guarantee
    // that a race cannot produce a second, different narrative.
    await withTransientRetry(`narrative ${tokenId}`, () =>
      this.prisma.narrative.create({ data }),
    ).catch((e) => {
      if (!/Unique constraint/i.test(String((e as Error)?.message))) throw e;
    });

    if (r.ok) {
      this.stats.generated++;
      console.log(`[narrative] ${token.symbol ?? token.address.slice(0, 8)}: ${r.summary.replace(/\s+/g, " ").slice(0, 90)}…`);
    } else {
      this.stats.none++;
      console.log(`[narrative] ${token.symbol ?? token.address.slice(0, 8)}: none — ${r.reason.slice(0, 80)}`);
    }
  }

  statsLine(): string {
    return (
      `[narrative] generated=${this.stats.generated} none=${this.stats.none} ` +
      `tokens=${this.stats.inputTokens}in/${this.stats.outputTokens}out cost=$${this.stats.costUsd.toFixed(4)}`
    );
  }
}
