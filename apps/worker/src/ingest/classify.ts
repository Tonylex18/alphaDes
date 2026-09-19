/**
 * Message classification, written from the Day 0 dumps in `data/dumps/`.
 * See docs/CLASSIFIER.md for the shapes and the message ids they came from.
 *
 * Two channels, two message shapes, one entry point. The rule set is chosen by
 * `Channel.kind`, which is a column — never by channel id, and never by handle.
 *
 * The bias throughout is rule 8: ambiguity is dropped, not guessed. Every
 * "call" test requires a positive signal, not merely the absence of a negative.
 */
import { extractAddresses, normaliseAddress, type Chain, type FoundAddress } from "./address.js";
import { parseMultiple, parseStatedMarketCap, parseTicker, multipleOffset } from "./numbers.js";

export type ChannelKind = "BARE_CA" | "NARRATIVE";

export type Category = "NEW_CALL" | "MILESTONE" | "SCANNER_CARD" | "NOISE";

export type ClassifierMessage = {
  id: number;
  text: string;
  hasMedia?: boolean;
  replyTo?: number | null;
};

export type Classification = {
  category: Category;
  address: string | null;
  chain: Chain | null;
  ticker: string | null;
  /// What the caller CLAIMED the cap was. Never our measurement.
  statedMarketCapUsd: number | null;
  /// What the channel CLAIMED the multiple was, on a MILESTONE.
  claimedMultiple: number | null;
  /// The caller's own prose, when they wrote any. Becomes the Narrative.
  narrative: string | null;
  /// Which rule fired. Carried so a surprising classification can be traced
  /// back to a line in this file instead of being re-derived from scratch.
  reason: string;
};

// ---------------------------------------------------------------------------
// Machine-generated cards
// ---------------------------------------------------------------------------

/// Unambiguous signatures of a bot card. Every one of these appears verbatim in
/// the dumps and in no human message in them.
const CARD_SIGNATURE =
  /#MIGRATED|#DEXPAID|\bFDV:|\bFDV now:|Trench Track|Buy\s?Bot\b|Bonding Process|Turn alerts off|\bMCap:|Market\s?Cap\s*[:$]/i;

/// Field labels from the scanner card layout. Any three means a card even if
/// the header emoji changes, which it does: 💊 ☄️ ⚡️ 🔥 🦅 🔄 💰 all appear.
const CARD_FIELDS = [/\bFDV:/i, /\bLiq:/i, /\bVol:/i, /\bTH:/i, /\bChart:/i, /\bAge:/i, /Total:/i, /Fresh 1D/i];

/// Box-drawing characters. The compact "migration" and "multiple" cards use
/// them as a tree and no human in either channel types them.
const CARD_TREE = /[├└┕┌│┃]/;

export function isScannerCard(text: string): boolean {
  if (CARD_SIGNATURE.test(text)) return true;
  if (CARD_TREE.test(text)) return true;
  return CARD_FIELDS.filter((re) => re.test(text)).length >= 3;
}

// ---------------------------------------------------------------------------
// Call intent (NARRATIVE channels)
// ---------------------------------------------------------------------------

/// A narrative-channel message is only a call if the caller says they are in,
/// or tags it with the risk boilerplate they attach to their own calls. An
/// address on its own is not enough — they also paste addresses when linking,
/// quoting and replying.
const CALL_INTENT =
  /\baped\b|\bape[ds]?\s+(?:some|this|smol|in)\b|\bentry\b|\bdyor\b|\bnfa\b|\brn at\b|\bin this\b|\bkeep an eye\b|\bi'?m in\b|\btook a bet\b|\bwatch entry\b|\bconviction play\b/i;

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

/// Words that turn a multiple into a claim about a call we made, rather than
/// general chat about multiples ("take profit after a 2x", "I need a 10x").
const MILESTONE_CUE = /\bsmashed\b|\bdone\b|\bso far\b|\bfrom call\b|✅|\bnow!|\bATH\b/i;

/// "9k to 500k", "14k to 53k", "$10k --> $77k". <private-channel> states progress this
/// way as often as it says "3x".
const PROGRESSION =
  /^\s*\$?\d+(?:\.\d+)?\s*[kKmM]?\s*(?:to|-->|->|→|>)\s*\$?\d+(?:\.\d+)?\s*[kKmM]\b/;

const AMOUNT_ANYWHERE = /\$?\d+(?:\.\d+)?\s*[kKmM]\b/;

/// The multiple leads the message, allowing for a stray emoji or quote mark.
function multipleLeads(text: string): boolean {
  const offset = multipleOffset(text.trimStart());
  return offset !== null && offset <= 2;
}

// ---------------------------------------------------------------------------
// Narrative capture
// ---------------------------------------------------------------------------

/// Lines that are pure boilerplate or a bare address carry no story.
const BOILERPLATE = /^(?:nfa[,.\s]*dyor!?|dyor!?|nfa!?|treat as gamble[.\s]*(?:nfa[,.\s]*dyor!?)?)$/i;

const NARRATIVE_MIN_CHARS = 80;

/// The caller's own words, with the address lines and the risk boilerplate
/// removed. Returns null when what is left is just "Aped $JAS." — a ticker and
/// a verb is not a narrative, and claiming it is one would be worse than
/// having none.
export function extractNarrative(text: string, addresses: FoundAddress[]): string | null {
  const addrSet = new Set(addresses.map((a) => a.address));
  const kept = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (BOILERPLATE.test(line)) return false;
      // "CA: <address>" or a line that is only an address.
      const stripped = line.replace(/^ca\s*[:=]\s*/i, "").trim();
      if (addrSet.has(stripped)) return false;
      return true;
    })
    // Addresses pasted mid-line add nothing to the prose.
    .map((line) => {
      let out = line;
      for (const a of addrSet) out = out.replace(a, "").trim();
      return out;
    })
    .filter((line) => line.length > 0);

  const prose = kept.join("\n").trim();
  return prose.length >= NARRATIVE_MIN_CHARS ? prose : null;
}

// ---------------------------------------------------------------------------

function empty(category: Category, reason: string): Classification {
  return {
    category,
    address: null,
    chain: null,
    ticker: null,
    statedMarketCapUsd: null,
    claimedMultiple: null,
    narrative: null,
    reason,
  };
}

/**
 * Classify one message. Stateless and per-message by design.
 *
 * NEW_CALL means "this message asserts a call and carries an address" — NOT
 * "this token is new to us". First-sighting is a database question and stays in
 * the ingest layer, where `@@unique([tokenId, channelId])` answers it. A repeat
 * of a token we already track becomes a CallEvent, per rule 2.
 */
export function classify(message: ClassifierMessage, channelKind: ChannelKind): Classification {
  const text = message.text ?? "";
  if (text.trim().length === 0) {
    return empty("NOISE", "empty text (media-only message)");
  }

  // Cards first, always. A card can contain everything a call contains.
  if (isScannerCard(text)) {
    const found = extractAddresses(text);
    const first = found[0];
    // The address and ticker on a card are reliable. Its numbers are not: the
    // first "xN" in a card is as likely to be "Liq: 22.3K [x13]" as a price
    // multiple, and 7570 yields 10 from "[x10]" liquidity. A card contributes
    // identity, never a claimed multiple.
    return {
      ...empty("SCANNER_CARD", "matched a bot-card signature"),
      address: first ? normaliseAddress(first.address, first.chain) : null,
      chain: first?.chain ?? null,
      ticker: parseTicker(text),
    };
  }

  const found = extractAddresses(text);
  const first = found[0];

  if (first) {
    const isCall =
      channelKind === "BARE_CA" ? isBareCall(text, first) : CALL_INTENT.test(text);

    if (isCall) {
      return {
        category: "NEW_CALL",
        address: normaliseAddress(first.address, first.chain),
        chain: first.chain,
        ticker: parseTicker(text),
        statedMarketCapUsd: parseStatedMarketCap(text),
        claimedMultiple: null,
        narrative: channelKind === "NARRATIVE" ? extractNarrative(text, found) : null,
        reason:
          channelKind === "BARE_CA"
            ? "address is the whole first line of the message"
            : "address plus call intent",
      };
    }

    // An address we cannot justify calling a call. Rule 8: drop it.
    return empty("NOISE", "address present but no call signal");
  }

  const milestone = classifyMilestone(text, channelKind);
  if (milestone) return milestone;

  return empty("NOISE", "no address, no milestone shape");
}

/// In a BARE_CA channel the call IS the address: it is the entire first line.
/// Anything else that happens to contain an address is commentary or a promo —
/// <private-channel> 1200 buries an EVM address in a testnet airdrop pitch, and
/// treating that as a call would have put a testnet token on the board.
function isBareCall(text: string, first: FoundAddress): boolean {
  const firstLine = text.split("\n")[0]!.trim();
  return firstLine === first.address;
}

function classifyMilestone(text: string, channelKind: ChannelKind): Classification | null {
  const multiple = parseMultiple(text);
  const short = text.trim().length <= 80;

  if (channelKind === "BARE_CA") {
    if (multiple !== null && multipleLeads(text) && short) {
      return {
        ...empty("MILESTONE", "message opens with a multiple"),
        claimedMultiple: multiple,
      };
    }
    if (PROGRESSION.test(text)) {
      return { ...empty("MILESTONE", "message opens with a market-cap progression"), claimedMultiple: null };
    }
    return null;
  }

  // NARRATIVE
  if (multiple !== null && (multipleLeads(text) || MILESTONE_CUE.test(text))) {
    return {
      ...empty("MILESTONE", multipleLeads(text) ? "message opens with a multiple" : "multiple plus milestone cue"),
      ticker: parseTicker(text),
      claimedMultiple: multiple,
    };
  }
  if (/\bATH\b/.test(text) && AMOUNT_ANYWHERE.test(text)) {
    return {
      ...empty("MILESTONE", "states a new ATH with a figure"),
      ticker: parseTicker(text),
    };
  }
  return null;
}
