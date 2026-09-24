/**
 * The card must not blur what the data says. These render it and read the
 * markup back, because the three contracts from Phases 2 and 3 are only worth
 * anything if they survive the last step to the screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CallCard } from "./CallCard";
import type { FeedCall } from "../lib/feed";

const base = (over: Partial<FeedCall> = {}): FeedCall => ({
  id: "c1",
  calledAt: new Date(Date.now() - 3600_000).toISOString(),
  status: "ACTIVE",
  closeReason: null,
  channel: "A channel",
  token: { address: "So111", symbol: "TEST", name: "Test", imageUrl: null, chain: "SOLANA", dexChainId: "solana" },
  entry: { marketCapUsd: 10_000, provenance: "MEASURED", observedAt: null, observedLagSeconds: 3, source: null, nullReason: null },
  statedMarketCapUsd: null,
  latestMarketCapUsd: 20_000,
  latestMultiple: 2,
  peak: {
    marketCapUsd: 30_000, multiple: 3, provenance: "MEASURED",
    at: new Date(Date.now() - 3400_000).toISOString(), timeToPeakSeconds: 200 * 60,
    source: "measured: polled high", nullReason: null,
  },
  narrative: { source: "CALLER", summary: "The caller said this.", nullReason: null, sourceUrls: [] },
  eventCount: 2,
  ...over,
});

/// React escapes apostrophes in text nodes, so decode before matching rather
/// than writing &#x27; into every expectation.
const html = (c: FeedCall) =>
  renderToStaticMarkup(<CallCard call={c} fresh={false} />).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

test("a measured entry says so, and shows how late the reading was", () => {
  const out = html(base());
  assert.match(out, /measured at the call/);
  assert.match(out, /read 3s after the call/);
  assert.doesNotMatch(out, /reconstructed/);
});

test("a reconstructed entry is never presented as measured", () => {
  const out = html(base({ entry: { ...base().entry, provenance: "RECONSTRUCTED", observedLagSeconds: null } }));
  assert.match(out, /reconstructed from history/);
  assert.doesNotMatch(out, /measured at the call/);
});

test("no entry price means no multiple anywhere on the card", () => {
  const out = html(
    base({
      entry: { marketCapUsd: null, provenance: "MISSING", observedAt: null, observedLagSeconds: null, source: null, nullReason: "no pool on solana" },
      latestMultiple: null,
      peak: { marketCapUsd: null, multiple: null, provenance: "MISSING", at: null, timeToPeakSeconds: null, source: null, nullReason: null },
    }),
  );
  assert.match(out, /no entry price/);
  assert.match(out, /unknown/, "the called-at figure reads as unknown");
  assert.match(out, /no pool on solana/, "and says why");
  // The failure this guards against: a 0x or 1x conjured from a null entry.
  assert.doesNotMatch(out, /\d+(\.\d+)?x/, "no multiple may appear without an entry price");
  assert.doesNotMatch(out, />0</, "and never a bare zero");
});

test("the three narrative sources read differently", () => {
  assert.match(html(base()), /the caller's own words/);
  assert.match(
    html(base({ narrative: { source: "GENERATED", summary: "A summary.", nullReason: null, sourceUrls: [] } })),
    /summarised from the project's own socials/,
  );
  const none = html(base({ narrative: { source: "NONE", summary: null, nullReason: "no website, X or Telegram link on the token's DEX listing", sourceUrls: [] } }));
  // NONE is roughly half the board: it must read as a finding about the call.
  assert.match(none, /no story/);
  assert.match(none, /had no website, X or Telegram on its listing/);
  const pending = html(base({ narrative: { source: "PENDING", summary: null, nullReason: null, sourceUrls: [] } }));
  assert.match(pending, /not looked up yet/, "never looked up is not the same as looked up and found nothing");
});

test("a dead call stays on the feed, with its reason", () => {
  const out = html(base({ status: "CLOSED_DEAD", closeReason: "liquidity $71 below $500" }));
  assert.match(out, /DEAD/);
  assert.match(out, /liquidity \$71 below \$500/);
});

test("the caller's claim is shown as theirs, not as ours", () => {
  const out = html(base({ statedMarketCapUsd: 8_000 }));
  assert.match(out, /caller said/);
  assert.match(out, /their claim, not our measurement/);
});

/// Phase 2b. The peak used to mean "the highest price since polling started on
/// 21 September", which for an August call is a fact about us wearing the label
/// of a fact about the token. These three guard the replacement contract.

test("a reconstructed peak is labelled, and says how long there was to act", () => {
  const out = html(
    base({
      peak: {
        marketCapUsd: 30_000, multiple: 3, provenance: "RECONSTRUCTED",
        at: new Date().toISOString(), timeToPeakSeconds: 3 * 3600 + 20 * 60,
        source: "geckoterminal:ohlcv minute high", nullReason: null,
      },
    }),
  );
  assert.match(out, /3h 20m to peak/, "the duration, not a timestamp");
  assert.match(out, /reconstructed/);
  assert.match(out, /3.00x/);
});

test("a peak we cannot stand behind shows nothing, not 1.0x and not the entry", () => {
  const out = html(
    base({
      peak: {
        marketCapUsd: null, multiple: null, provenance: "MISSING",
        at: null, timeToPeakSeconds: null, source: null,
        nullReason: "peak reconstruction: no pool on solana",
      },
    }),
  );
  assert.match(out, /no peak/);
  assert.match(out, /no pool on solana/, "and says why, since the entry price IS known here");
  // The specific failure: falling back to the entry, or to a flat 1x, either of
  // which would read as "this call never moved".
  assert.doesNotMatch(out, /1\.00x/);
  assert.doesNotMatch(out, /to peak/);
});

test("a measured peak and a reconstructed one do not read the same", () => {
  const measured = html(base());
  const rebuilt = html(base({ peak: { ...base().peak, provenance: "RECONSTRUCTED" } }));
  assert.notStrictEqual(measured, rebuilt, "the two claims must be distinguishable on the card");
  assert.match(measured, /peak-note measured/);
  assert.match(rebuilt, /peak-note reconstructed/);
});
