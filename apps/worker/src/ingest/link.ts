/**
 * Attaching a milestone to the call it is about.
 *
 * Priority order, and it never falls past the end: replyTo, then an address we
 * have already seen, then a ticker seen in this channel. If none of the three
 * resolve, the event is UNCLASSIFIED and attaches to nothing. Guessing a parent
 * is how a channel's 5x ends up credited to the wrong token, which is exactly
 * the dishonesty this product exists to avoid.
 */
import type { Chain } from "./address.js";

export type LinkMethod = "REPLY" | "ADDRESS" | "TICKER";

export type LinkResult = { callId: string; via: LinkMethod } | null;

/**
 * Everything the linker needs to know about what came before, scoped to ONE
 * channel. The ingest layer backs this with Prisma; the tests back it with the
 * dumps. The linker itself stays pure.
 */
export interface CallIndex {
  /// The call a previous message in this channel belongs to, whether that
  /// message created the call or was an event on it. Null if unknown.
  callForMessage(messageId: number): string | null;
  /// The message a message replied to, so a reply chain can be walked.
  replyTargetOf(messageId: number): number | null;
  /// A call in this channel for an address we have already seen.
  callForAddress(chain: Chain, address: string): string | null;
  /// A call in this channel whose token carries this ticker. Null when the
  /// ticker is ambiguous — two live calls with the same ticker resolve to
  /// nothing rather than to a coin flip.
  callForTicker(ticker: string): string | null;
}

export type LinkInput = {
  messageId: number;
  replyTo?: number | null;
  address?: string | null;
  chain?: Chain | null;
  ticker?: string | null;
};

/// A reply often points at another milestone rather than at the call itself —
/// <private-channel> 1260 replies to 1255, which replies to the call at 1248. Walk up,
/// but bound it: a cycle or a very long chain means we do not actually know.
const MAX_REPLY_HOPS = 8;

export function linkMilestone(input: LinkInput, index: CallIndex): LinkResult {
  let cursor = input.replyTo ?? null;
  const seen = new Set<number>();
  for (let hop = 0; cursor !== null && hop < MAX_REPLY_HOPS; hop++) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const callId = index.callForMessage(cursor);
    if (callId) return { callId, via: "REPLY" };
    cursor = index.replyTargetOf(cursor);
  }

  if (input.address && input.chain) {
    const callId = index.callForAddress(input.chain, input.address);
    if (callId) return { callId, via: "ADDRESS" };
  }

  if (input.ticker) {
    const callId = index.callForTicker(input.ticker);
    if (callId) return { callId, via: "TICKER" };
  }

  return null;
}
