/**
 * Parsing the numbers a caller says out loud.
 *
 * Everything here produces a CLAIM. It is stored on Call.statedMarketCapUsd and
 * CallEvent.claimedMultiple, never on calledAtMarketCapUsd or peakMarketCapUsd,
 * which are ours and measured.
 */

/// "87k" -> 87000, "3m" -> 3000000, "$3.5k" -> 3500, "440" -> 440.
const AMOUNT = String.raw`\$?\s?(\d+(?:[.,]\d+)?)\s*([kKmMbB])?`;

function toNumber(digits: string, suffix: string | undefined): number {
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  switch (suffix?.toLowerCase()) {
    case "k": return n * 1_000;
    case "m": return n * 1_000_000;
    case "b": return n * 1_000_000_000;
    default:  return n;
  }
}

/**
 * The market cap the caller stated for their own entry.
 *
 * Ordered, and the order matters. A single message routinely quotes two
 * figures — AlphaDesJurix 7640 is "EMBER currently at 11m. So, $BABYEMBER is a
 * good beta. Entry 22k MC." The entry is 22k; 11m is a different token. So an
 * amount glued to "MC" wins over an amount after a loose preposition, and a
 * bare "at <amount>" is deliberately NOT a cue: 7614 says "ATH was 600k" about
 * a level the token already left.
 */
const MARKET_CAP_PATTERNS: RegExp[] = [
  // "200k MC entry", "3m MC", "10k MC", "480k mc"
  new RegExp(AMOUNT + String.raw`\s*(?:mc\b|market\s?cap\b)`, "i"),
  // "MC: 24k", "market cap 9,445"
  new RegExp(String.raw`(?:mc|market\s?cap)\s*[:=]?\s*` + AMOUNT, "i"),
  // "62k entry"
  new RegExp(AMOUNT + String.raw`\s*entry\b`, "i"),
  // "750K rn"
  new RegExp(AMOUNT + String.raw`\s*\brn\b`, "i"),
  // "Entry 22k", "rn at 98k", "sitting at 10k", "currently at 11m", "in at 5k"
  new RegExp(
    String.raw`\b(?:entry|rn\s+at|currently\s+at|sitting\s+at|now\s+at|got\s+in\s+at|in\s+at|aped\s+at)\s*` +
      AMOUNT,
    "i",
  ),
];

export function parseStatedMarketCap(text: string): number | null {
  for (const re of MARKET_CAP_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const v = toNumber(m[1]!, m[2]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/// "3x" / "X2" / "7.3x" -> 3, 2, 7.3. Returns the first in the text.
const MULTIPLE = /(?:\b(\d+(?:\.\d+)?)\s*[xX]\b|\b[xX](\d+(?:\.\d+)?)\b)/;

export function parseMultiple(text: string): number | null {
  const m = MULTIPLE.exec(text);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function multipleOffset(text: string): number | null {
  const m = MULTIPLE.exec(text);
  return m ? m.index : null;
}

/// "$TICKER" -> "TICKER", first one, uppercased. Null when the caller named no
/// ticker, which happens: 7469 is just "Aped. 62k entry."
const TICKER = /\$([A-Za-z][A-Za-z0-9_]{1,14})\b/;

export function parseTicker(text: string): string | null {
  const m = TICKER.exec(text);
  return m ? m[1]!.toUpperCase() : null;
}
