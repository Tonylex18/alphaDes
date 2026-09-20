/**
 * Stitching a BARE_CA channel's commentary onto the call it follows.
 *
 * The private channel posts the address alone and then says what it thinks in
 * separate messages, seconds later: "gamble", "Risking this", "Got in 14k".
 * Without stitching the feed shows a bare address and the caller's read of it
 * is lost.
 *
 * The window was measured, not guessed. Across 26 calls in the Day 0 dump,
 * on-topic commentary lands within 77 seconds; past about 90 the thread has
 * drifted to other tokens, to media, and to replies to older messages. A 90s
 * window admits 26 messages, of which 24 are about the call they follow.
 *
 * The two that are not are the reason for the hard rule below:
 *
 *   call 1242  +54s  "Send is at 600k mc now"
 *   call 1242  +63s  "So maybe a 2nd runner"
 *
 * Both are about a different token, and the first contains a market cap.
 * NOTHING stitched here may write a number onto the Call — not
 * statedMarketCapUsd, not anything. "Got in 14k" (call 1114, +72s) and "Send is
 * at 600k mc now" are the same shape in the same channel and we cannot tell
 * them apart. Commentary is stored as a COMMENTARY event with its raw text and
 * shown as chatter that followed the call. That is all it is good for.
 *
 * The rule is expressed backwards — from a message, find its call — so that a
 * live message and a replayed one take exactly the same path.
 */
import type { Category } from "./classify.js";

export const COMMENTARY_WINDOW_SECONDS = 90;
const MAX_COMMENTARY_CHARS = 160;
const HAS_URL = /https?:\/\//i;

export type CommentaryMessage = {
  postedAt: Date;
  text: string;
  category: Category;
  replyTo: number | null;
};

/// A call recently made in this channel, and the message that made it.
export type RecentCall = {
  callId: string;
  messageId: number;
  calledAt: Date;
};

export type StitchDeps = {
  /// Calls in this channel with calledAt inside the window ending at the
  /// message. Ordered does not matter.
  callsInWindow: RecentCall[];
  /// For an explicit reply, the call that the replied-to message belongs to.
  /// Null when we do not track that message — which is itself a reason to skip.
  callForMessage: (messageId: number) => string | null;
};

export type StitchResult =
  | { attach: true; callId: string }
  | { attach: false; reason: string };

/**
 * Decide whether a message is commentary on a recent call, and on which one.
 *
 * Returns `attach: false` far more often than true, on purpose. Every reason
 * string names a specific guard so that a surprising attachment — or a
 * surprising miss — can be traced without re-deriving the rule.
 */
export function stitchCommentary(m: CommentaryMessage, deps: StitchDeps): StitchResult {
  if (m.category !== "NOISE") return { attach: false, reason: "not chatter — has its own linking" };

  const text = m.text.trim();
  if (text.length === 0) return { attach: false, reason: "media-only message" };
  if (text.length > MAX_COMMENTARY_CHARS) return { attach: false, reason: "too long to be a reaction" };
  if (HAS_URL.test(text)) return { attach: false, reason: "contains a link — promos are not commentary" };

  const { callsInWindow } = deps;
  if (callsInWindow.length === 0) return { attach: false, reason: "no call within the window" };
  // Two calls inside one window. Chatter between them is genuinely ambiguous,
  // so it attaches to neither. Never seen in the Day 0 dump — the closest two
  // calls are 22 minutes apart — but it costs nothing to be right about it.
  if (callsInWindow.length > 1) {
    return { attach: false, reason: `${callsInWindow.length} calls inside the window — ambiguous` };
  }

  const anchor = callsInWindow[0]!;

  // An explicit reply is an explicit subject. If it answers anything other than
  // this call, it is not about this call however close in time it landed.
  if (m.replyTo !== null) {
    const repliedCall = deps.callForMessage(m.replyTo);
    if (repliedCall === null) return { attach: false, reason: "replies to a message we do not track" };
    if (repliedCall !== anchor.callId) return { attach: false, reason: "replies to a different call" };
  }

  return { attach: true, callId: anchor.callId };
}

/// The earliest calledAt that could anchor a message posted at `at`.
export function windowStart(at: Date): Date {
  return new Date(at.getTime() - COMMENTARY_WINDOW_SECONDS * 1000);
}
