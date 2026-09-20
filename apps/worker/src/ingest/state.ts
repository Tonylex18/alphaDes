/**
 * An in-memory view of one channel's ingest state.
 *
 * Why this exists: measured against the dev Neon branch from a laptop, a single
 * round trip is ~245ms and a Prisma `upsert` is ~2.5s, because upsert runs a
 * transaction. The first version of the ingest path did one upsert plus several
 * point reads per message and backfilled at 0.31 messages/second — a 200-message
 * backfill took over ten minutes, and a catch-up after an hour's outage would
 * have taken half an hour, during which nothing is live. That is the same
 * silent-failure class this phase exists to remove, just wearing a different hat.
 *
 * So reads happen once, in bulk, and writes happen only when something actually
 * changes. On the Day 0 dumps 164 of 200 messages in the private channel are
 * noise that writes nothing at all beyond the SeenMessage row, which is itself
 * inserted for the whole batch in one statement.
 */
import type { Channel, PrismaClient } from "@alphades/db";

export type KnownCall = {
  callId: string;
  tokenId: string;
  messageId: number;
  calledAt: Date;
  ticker: string | null;
};

export type KnownEvent = { callId: string | null; kind: string };

export class ChannelState {
  /// messageId -> the message it replied to. Every message, so a reply CHAIN
  /// can be walked through messages we did not act on.
  readonly replyTo = new Map<number, number | null>();
  readonly seen = new Set<number>();
  /// messageId -> the event recorded for it, so we know whether to insert.
  readonly events = new Map<number, KnownEvent>();
  /// "CHAIN:address" -> tokenId
  readonly tokenByAddress = new Map<string, string>();
  /// tokenId -> the call this channel made for it
  readonly callByToken = new Map<string, KnownCall>();
  /// every call in this channel, ascending by calledAt
  readonly calls: KnownCall[] = [];
  readonly tokensWithNarrative = new Set<string>();

  /// messageId -> callId, for the call message itself and for attributed events
  callForMessage(messageId: number): string | null {
    const ev = this.events.get(messageId);
    if (ev?.callId) return ev.callId;
    for (const c of this.calls) if (c.messageId === messageId) return c.callId;
    return null;
  }

  callsInWindow(from: Date, to: Date): KnownCall[] {
    return this.calls.filter((c) => c.calledAt > from && c.calledAt <= to);
  }

  callsForTicker(ticker: string): KnownCall[] {
    return this.calls.filter((c) => c.ticker !== null && c.ticker === ticker);
  }

  addCall(call: KnownCall) {
    this.calls.push(call);
    this.calls.sort((a, b) => a.calledAt.getTime() - b.calledAt.getTime());
    this.callByToken.set(call.tokenId, call);
  }
}

/// Three queries, whatever the size of the channel's history.
export async function loadChannelState(prisma: PrismaClient, channel: Channel): Promise<ChannelState> {
  const state = new ChannelState();

  const [messages, calls, events] = await Promise.all([
    prisma.seenMessage.findMany({
      where: { channelId: channel.id },
      select: { messageId: true, replyToMessageId: true },
    }),
    prisma.call.findMany({
      where: { channelId: channel.id },
      select: {
        id: true,
        tokenId: true,
        messageId: true,
        calledAt: true,
        token: { select: { address: true, chain: true, symbol: true, narrative: { select: { id: true } } } },
      },
    }),
    prisma.callEvent.findMany({
      where: { channelId: channel.id },
      select: { messageId: true, callId: true, kind: true },
    }),
  ]);

  for (const m of messages) {
    const id = Number(m.messageId);
    state.seen.add(id);
    state.replyTo.set(id, m.replyToMessageId === null ? null : Number(m.replyToMessageId));
  }
  for (const c of calls) {
    state.tokenByAddress.set(`${c.token.chain}:${c.token.address}`, c.tokenId);
    if (c.token.narrative) state.tokensWithNarrative.add(c.tokenId);
    state.addCall({
      callId: c.id,
      tokenId: c.tokenId,
      messageId: Number(c.messageId),
      calledAt: c.calledAt,
      ticker: c.token.symbol,
    });
  }
  for (const e of events) {
    state.events.set(Number(e.messageId), { callId: e.callId, kind: e.kind });
  }

  return state;
}
