/**
 * The ingest path: one Telegram message in, zero or more rows out.
 *
 * Three properties this file exists to guarantee.
 *
 * 1. IDEMPOTENT. Processing the same message twice produces no second row.
 *    Every write is keyed on something the message already determines — Token
 *    by address, Call by (tokenId, channelId), CallEvent and SeenMessage by
 *    (channelId, messageId). Nothing is keyed on "have we seen this before?",
 *    because that is exactly the question that goes wrong after a crash.
 *
 * 2. NO INTERACTIVE TRANSACTIONS. Prisma's default interactive transaction
 *    timeout is 5s and a Neon cold start is 20-30s, so one on this path would
 *    fail precisely when the database is slow — the moment the write matters
 *    most. Nested writes and conditional inserts only.
 *
 * 3. FEW ROUND TRIPS. Reads come from an in-memory ChannelState loaded once;
 *    writes happen only when something changes. See state.ts for the measured
 *    reason this is not premature.
 *
 * Ordering matters: a batch MUST be processed oldest-first, or a milestone
 * arrives before the call it belongs to and attaches to nothing.
 */
import type { PrismaClient, Channel } from "@alphades/db";
import { classify, type ChannelKind, type Category } from "./classify.js";
import { normaliseAddress, type Chain } from "./address.js";
import { stitchCommentary, windowStart } from "./stitch.js";
import { ChannelState, loadChannelState, type KnownCall } from "./state.js";

export type IncomingMessage = {
  messageId: number;
  postedAt: Date;
  text: string;
  hasMedia: boolean;
  replyTo: number | null;
  /// Which path delivered it, and when it reached our code. Recorded on the
  /// SeenMessage row so the live-vs-poll measurement survives restarts.
  path?: "LIVE" | "POLL" | "CATCHUP" | "BACKFILL";
  receivedAt?: Date;
};

export type EventKind =
  | "FIRST_CALL"
  | "CHANNEL_MILESTONE"
  | "REPOST"
  | "SCANNER_CARD"
  | "COMMENTARY"
  | "UNCLASSIFIED";

export type Outcome =
  | { action: "call_created"; callId: string; address: string }
  | { action: "call_reposted"; callId: string; address: string }
  | { action: "milestone_attached"; callId: string; via: string }
  | { action: "milestone_unattached" }
  | { action: "card_attached"; callId: string }
  | { action: "commentary_attached"; callId: string }
  | { action: "ignored"; reason: string };

export type ProcessResult = { messageId: number; category: Category; outcome: Outcome };

export type ProcessOptions = { source: "LIVE" | "BACKFILL" };

/// A reply chain is walked in memory. Bounded, because a cycle or a very long
/// chain means we do not actually know the answer.
const MAX_REPLY_HOPS = 8;

function resolveReplyChain(state: ChannelState, replyTo: number | null): string | null {
  let cursor = replyTo;
  const visited = new Set<number>();
  for (let hop = 0; cursor !== null && hop < MAX_REPLY_HOPS; hop++) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const callId = state.callForMessage(cursor);
    if (callId) return callId;
    if (!state.replyTo.has(cursor)) break; // never saw it, cannot follow it
    cursor = state.replyTo.get(cursor) ?? null;
  }
  return null;
}

function linkFromState(
  state: ChannelState,
  message: IncomingMessage,
  address: string | null,
  chain: Chain | null,
  ticker: string | null,
): { callId: string; via: string } | null {
  const byReply = resolveReplyChain(state, message.replyTo);
  if (byReply) return { callId: byReply, via: "REPLY" };

  if (address && chain) {
    const tokenId = state.tokenByAddress.get(`${chain}:${normaliseAddress(address, chain)}`);
    const call = tokenId ? state.callByToken.get(tokenId) : undefined;
    if (call) return { callId: call.callId, via: "ADDRESS" };
  }

  if (ticker) {
    const matches = state.callsForTicker(ticker);
    // An ambiguous ticker resolves to nothing rather than to a coin flip.
    if (matches.length === 1) return { callId: matches[0]!.callId, via: "TICKER" };
  }

  return null;
}

/// Insert a SeenMessage row per message, in one statement, skipping any we
/// already have. This replaced a per-message upsert that cost ~2.5s each.
async function recordSeen(prisma: PrismaClient, channel: Channel, messages: IncomingMessage[], state: ChannelState) {
  const fresh = messages.filter((m) => !state.seen.has(m.messageId));
  if (fresh.length === 0) return;
  await prisma.seenMessage.createMany({
    data: fresh.map((m) => ({
      channelId: channel.id,
      messageId: BigInt(m.messageId),
      postedAt: m.postedAt,
      replyToMessageId: m.replyTo === null ? null : BigInt(m.replyTo),
      ingestPath: m.path ?? null,
      receivedAt: m.receivedAt ?? null,
    })),
    skipDuplicates: true,
  });
  for (const m of fresh) {
    state.seen.add(m.messageId);
    state.replyTo.set(m.messageId, m.replyTo);
  }
}

async function writeEvent(
  prisma: PrismaClient,
  channel: Channel,
  message: IncomingMessage,
  state: ChannelState,
  fields: { callId: string | null; kind: EventKind; claimedMultiple: number | null },
) {
  const existing = state.events.get(message.messageId);

  if (!existing) {
    await prisma.callEvent.create({
      data: {
        channelId: channel.id,
        callId: fields.callId,
        kind: fields.kind,
        messageId: BigInt(message.messageId),
        postedAt: message.postedAt,
        rawText: message.text,
        hasMedia: message.hasMedia,
        replyToMessageId: message.replyTo === null ? null : BigInt(message.replyTo),
        claimedMultiple: fields.claimedMultiple,
      },
    });
    state.events.set(message.messageId, { callId: fields.callId, kind: fields.kind });
    return;
  }

  // The row is already there. The only change worth a write is an attribution
  // we could not make last time: a milestone processed before its call existed
  // gets attached on the replay. Re-processing an unchanged message writes
  // nothing, which is what makes replay cheap as well as safe.
  const improved = fields.callId !== null && existing.callId === null;
  if (!improved) return;

  await prisma.callEvent.update({
    where: { channelId_messageId: { channelId: channel.id, messageId: BigInt(message.messageId) } },
    data: { callId: fields.callId, kind: fields.kind },
  });
  state.events.set(message.messageId, { callId: fields.callId, kind: fields.kind });
}

async function ensureToken(
  prisma: PrismaClient,
  state: ChannelState,
  address: string,
  chain: Chain,
  ticker: string | null,
): Promise<string> {
  const key = `${chain}:${address}`;
  const cached = state.tokenByAddress.get(key);
  if (cached) return cached;

  const existing = await prisma.token.findUnique({ where: { address }, select: { id: true } });
  if (existing) {
    state.tokenByAddress.set(key, existing.id);
    return existing.id;
  }
  try {
    const created = await prisma.token.create({
      data: { address, chain, symbol: ticker },
      select: { id: true },
    });
    state.tokenByAddress.set(key, created.id);
    return created.id;
  } catch {
    // Lost a race, or the token exists under a different chain row. Re-read.
    const again = await prisma.token.findUniqueOrThrow({ where: { address }, select: { id: true } });
    state.tokenByAddress.set(key, again.id);
    return again.id;
  }
}

export async function processMessage(
  prisma: PrismaClient,
  channel: Channel,
  message: IncomingMessage,
  options: ProcessOptions,
  providedState?: ChannelState,
): Promise<ProcessResult> {
  const state = providedState ?? (await loadChannelState(prisma, channel));
  if (!providedState) await recordSeen(prisma, channel, [message], state);

  const c = classify(
    { id: message.messageId, text: message.text, hasMedia: message.hasMedia, replyTo: message.replyTo },
    channel.kind as ChannelKind,
  );
  const base = { messageId: message.messageId, category: c.category };

  // ---- a call -------------------------------------------------------------
  if (c.category === "NEW_CALL" && c.address && c.chain) {
    const address = normaliseAddress(c.address, c.chain);
    const tokenId = await ensureToken(prisma, state, address, c.chain, c.ticker);
    const existing = state.callByToken.get(tokenId);

    if (existing) {
      // Replaying the call's OWN message after a crash is not a re-post.
      // Without this check the first pass records FIRST_CALL and the second
      // rewrites it as REPOST, so the call ends up announced by a message that
      // no longer claims to have announced it.
      const kind: EventKind = existing.messageId === message.messageId ? "FIRST_CALL" : "REPOST";
      await writeEvent(prisma, channel, message, state, { callId: existing.callId, kind, claimedMultiple: null });
      return {
        ...base,
        outcome:
          kind === "FIRST_CALL"
            ? { action: "call_created", callId: existing.callId, address }
            : { action: "call_reposted", callId: existing.callId, address },
      };
    }

    const call = await prisma.call.create({
      data: {
        tokenId,
        channelId: channel.id,
        calledAt: message.postedAt,
        messageId: BigInt(message.messageId),
        source: options.source,
        // Phase 2 measures this. A backfilled call can never have a measured
        // one, so it is flagged now rather than quietly filled in later.
        calledAtMarketCapUsd: null,
        marketCapIsBackfilled: options.source === "BACKFILL",
        statedMarketCapUsd: c.statedMarketCapUsd ?? null,
        events: {
          create: {
            channelId: channel.id,
            kind: "FIRST_CALL",
            messageId: BigInt(message.messageId),
            postedAt: message.postedAt,
            rawText: message.text,
            hasMedia: message.hasMedia,
            replyToMessageId: message.replyTo === null ? null : BigInt(message.replyTo),
          },
        },
      },
      select: { id: true },
    });

    const known: KnownCall = {
      callId: call.id,
      tokenId,
      messageId: message.messageId,
      calledAt: message.postedAt,
      ticker: c.ticker,
    };
    state.addCall(known);
    state.events.set(message.messageId, { callId: call.id, kind: "FIRST_CALL" });

    // The caller's own words, when the channel gave us any. Generated
    // narratives are Phase 3, and only for calls that arrived with nothing.
    if (c.narrative && !state.tokensWithNarrative.has(tokenId)) {
      await prisma.narrative
        .create({
          data: { tokenId, summary: c.narrative, sourceNote: "The caller's own words at call time" },
        })
        .catch(() => {}); // generated once, never regenerated — a race loses harmlessly
      state.tokensWithNarrative.add(tokenId);
    }

    return { ...base, outcome: { action: "call_created", callId: call.id, address } };
  }

  // ---- a milestone --------------------------------------------------------
  if (c.category === "MILESTONE") {
    const link = linkFromState(state, message, c.address, c.chain, c.ticker);
    await writeEvent(prisma, channel, message, state, {
      callId: link?.callId ?? null,
      kind: link ? "CHANNEL_MILESTONE" : "UNCLASSIFIED",
      claimedMultiple: c.claimedMultiple,
    });
    return link
      ? { ...base, outcome: { action: "milestone_attached", callId: link.callId, via: link.via } }
      : { ...base, outcome: { action: "milestone_unattached" } };
  }

  // ---- a third party's card ----------------------------------------------
  if (c.category === "SCANNER_CARD") {
    const link = linkFromState(state, message, c.address, c.chain, c.ticker);
    if (!link) {
      // A card about a token nobody called is not our business. Storing every
      // one would bury the real events.
      return { ...base, outcome: { action: "ignored", reason: "card for a token we do not track" } };
    }
    await writeEvent(prisma, channel, message, state, {
      callId: link.callId,
      kind: "SCANNER_CARD",
      claimedMultiple: null, // a card's numbers are not trustworthy — see CLASSIFIER.md
    });
    return { ...base, outcome: { action: "card_attached", callId: link.callId } };
  }

  // ---- chatter, which on a BARE_CA channel may be commentary --------------
  if (channel.kind === "BARE_CA") {
    const callsInWindow = state.callsInWindow(windowStart(message.postedAt), message.postedAt);
    const repliedCall = message.replyTo === null ? null : resolveReplyChain(state, message.replyTo);

    const decision = stitchCommentary(
      { postedAt: message.postedAt, text: message.text, category: c.category, replyTo: message.replyTo },
      {
        callsInWindow: callsInWindow.map((c2) => ({
          callId: c2.callId,
          messageId: c2.messageId,
          calledAt: c2.calledAt,
        })),
        callForMessage: () => repliedCall,
      },
    );

    if (decision.attach) {
      await writeEvent(prisma, channel, message, state, {
        callId: decision.callId,
        kind: "COMMENTARY",
        claimedMultiple: null,
      });
      return { ...base, outcome: { action: "commentary_attached", callId: decision.callId } };
    }
    return { ...base, outcome: { action: "ignored", reason: decision.reason } };
  }

  return { ...base, outcome: { action: "ignored", reason: c.reason } };
}

/**
 * Process a batch oldest-first. Used by catch-up, backfill and the tests.
 *
 * Sequential on purpose: these messages are causally ordered — a milestone
 * needs its call to exist first — so they cannot be parallelised without
 * reintroducing the ordering bug the whole design avoids.
 */
export async function processBatch(
  prisma: PrismaClient,
  channel: Channel,
  messages: IncomingMessage[],
  options: ProcessOptions,
  providedState?: ChannelState,
): Promise<ProcessResult[]> {
  const ordered = [...messages].sort((a, b) => a.messageId - b.messageId);
  const state = providedState ?? (await loadChannelState(prisma, channel));

  // One statement for the whole batch, before anything is decided: a message we
  // ignore today may be the middle of a reply chain we need tomorrow.
  await recordSeen(prisma, channel, ordered, state);

  const results: ProcessResult[] = [];
  for (const m of ordered) {
    results.push(await processMessage(prisma, channel, m, options, state));
  }
  return results;
}

export { loadChannelState, ChannelState };
