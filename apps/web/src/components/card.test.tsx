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
  peakMarketCapUsd: 30_000,
  latestMultiple: 2,
  peakMultiple: 3,
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
      peakMultiple: null,
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
