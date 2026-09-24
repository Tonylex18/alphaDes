/**
 * What may reach a card, and what may not.
 *
 * The rule under test is Phase 2b's: `peakMarketCapUsd` alone is not
 * publishable. Price polling began on 21 September and most calls are from
 * August, so a peak with no `peakSource` is "the highest price since we started
 * watching" — a fact about our infrastructure that reads, on a card, as a fact
 * about the token. Only a peak whose window demonstrably starts at the call
 * gets out, and it carries how it was obtained.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toFeedCall } from "../lib/feed";

const row = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  calledAt: new Date("2026-08-09T07:17:05Z"),
  status: "ACTIVE",
  closeReason: null,
  channel: { displayName: "A channel", role: "TRACK" },
  token: { address: "So111", symbol: "TEST", name: "Test", imageUrl: null, chain: "SOLANA", dexChainId: "solana", narrative: null },
  calledAtMarketCapUsd: 10_000,
  marketCapObservedAt: null,
  marketCapSource: null,
  marketCapIsBackfilled: false,
  marketCapNullReason: null,
  statedMarketCapUsd: null,
  latestMarketCapUsd: 5_000,
  peakMarketCapUsd: null,
  peakAt: null,
  peakSource: null,
  peakIsBackfilled: false,
  peakNullReason: null,
  _count: { events: 0 },
  ...over,
});

test("a peak with no source is not published, however real the number looks", () => {
  // Exactly the shape the poller left behind: a genuine observed high, over a
  // window that starts weeks after the call.
  const c = toFeedCall(row({ peakMarketCapUsd: 42_000, peakAt: new Date("2026-09-21T12:00:00Z"), peakSource: null }));
  assert.equal(c.peak.marketCapUsd, null);
  assert.equal(c.peak.multiple, null, "and therefore no 4.2x either");
  assert.equal(c.peak.provenance, "MISSING");
  assert.equal(c.peak.timeToPeakSeconds, null);
});

test("a reconstructed peak is published, labelled, with its time to peak", () => {
  const c = toFeedCall(
    row({
      peakMarketCapUsd: 30_000,
      peakAt: new Date("2026-08-09T10:37:05Z"), // 3h 20m after the call
      peakSource: "geckoterminal:ohlcv minute high @... over calledAt→now",
      peakIsBackfilled: true,
    }),
  );
  assert.equal(c.peak.marketCapUsd, 30_000);
  assert.equal(c.peak.multiple, 3);
  assert.equal(c.peak.provenance, "RECONSTRUCTED");
  assert.equal(c.peak.timeToPeakSeconds, 3 * 3600 + 20 * 60);
});

test("a peak measured by our own polling is not called reconstructed", () => {
  const c = toFeedCall(
    row({ peakMarketCapUsd: 30_000, peakAt: new Date("2026-08-09T08:17:05Z"), peakSource: "measured: polled high", peakIsBackfilled: false }),
  );
  assert.equal(c.peak.provenance, "MEASURED");
  assert.equal(c.peak.timeToPeakSeconds, 3600);
});

test("no entry price means no peak multiple, even with a peak", () => {
  const c = toFeedCall(
    row({ calledAtMarketCapUsd: null, peakMarketCapUsd: 30_000, peakAt: new Date(), peakSource: "geckoterminal:ohlcv hour high", peakIsBackfilled: true }),
  );
  assert.equal(c.peak.marketCapUsd, 30_000, "the absolute figure still stands on its own");
  assert.equal(c.peak.multiple, null, "but it is not divided by a number we do not have");
});

test("a missing peak carries its reason so the gap reads as a finding", () => {
  const c = toFeedCall(row({ peakNullReason: "peak reconstruction: no pool on solana" }));
  assert.equal(c.peak.provenance, "MISSING");
  assert.match(c.peak.nullReason ?? "", /no pool on solana/);
});
