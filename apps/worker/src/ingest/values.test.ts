/**
 * The numbers and prose pulled off a call, checked against the real messages.
 * Every id here is a message in the Day 0 dumps.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { dumpsDir } from "../lib/paths.js";
import { classify } from "./classify.js";
import { parseStatedMarketCap, parseTicker, parseMultiple } from "./numbers.js";

function jurix(): Map<number, { text: string; replyTo: number | null }> | null {
  const path = join(dumpsDir(), "dump_AlphaDesJurix.json");
  if (!existsSync(path)) return null;
  const msgs = JSON.parse(readFileSync(path, "utf8")).messages as {
    id: number;
    text: string | null;
    replyTo: number | null;
  }[];
  return new Map(msgs.map((m) => [m.id, { text: m.text ?? "", replyTo: m.replyTo }]));
}

/// The caller's stated cap for every call in the dump. null where they gave
/// none, which is 8 of the 23 — the field has to tolerate that.
const STATED_MARKET_CAP: [number, number | null][] = [
  [7469, 62_000],      // "Aped. 62k entry."
  [7480, 98_000],      // "In this. $SD rn at 98k."
  [7486, 480_000],     // "480k mc entry"
  [7494, 3_500],       // "Rn at $3.5k."
  [7520, 200_000],     // "200k MC entry"
  [7526, 750_000],     // "Aped $HONSE. 750K rn."
  [7534, null],        // "BabyCate spawned same day with CATE."
  [7550, null],        // "Good narrative on HyperEVM, $TESTICLES. I aped smol."
  [7559, 6_500],       // "Rn at 6.5k MC."
  [7562, 10_000],      // "...at 1.2M. But this is the OG sitting at 10k MC." — 10k, not 1.2M
  [7577, null],
  [7598, null],
  [7608, 125_000],
  [7610, 24_000],
  [7614, null],        // says "ATH was 600k" — a level it already left, not an entry
  [7629, 200_000],
  [7634, 3_000_000],   // "Aped $UBER here at 3m MC."
  [7640, 22_000],      // "EMBER currently at 11m ... Entry 22k MC." — 22k, not 11m
  [7647, null],
  [7650, 8_000],       // "at $8k MC"
  [7660, null],
  [7666, null],
  [7676, 87_000],      // "Rn at 87k MC."
];

test("stated market cap is the caller's entry, not the loudest number in the message", async (t) => {
  const byId = jurix();
  if (!byId) return t.skip("dump not present");
  for (const [id, expected] of STATED_MARKET_CAP) {
    const m = byId.get(id);
    assert.ok(m, `message ${id} missing from dump`);
    const c = classify({ id, text: m.text, replyTo: m.replyTo }, "NARRATIVE");
    assert.equal(c.category, "NEW_CALL", `${id} should be a call`);
    assert.equal(c.statedMarketCapUsd, expected, `stated market cap for ${id}`);
  }
});

test("stated market cap, unit by unit", () => {
  assert.equal(parseStatedMarketCap("Aped $ROMANSTORM. Rn at 87k MC."), 87_000);
  assert.equal(parseStatedMarketCap("Aped $UBER here at 3m MC."), 3_000_000);
  assert.equal(parseStatedMarketCap("Aped. 62k entry."), 62_000);
  assert.equal(parseStatedMarketCap("Aped $HONSE. 750K rn."), 750_000);
  assert.equal(parseStatedMarketCap("Rn at $3.5k."), 3_500);
  // A cap the token already left is not an entry.
  assert.equal(parseStatedMarketCap("ATH was 600k and still under the radar."), null);
  assert.equal(parseStatedMarketCap("GM Legends!"), null);
});

test("ticker is the first $TAG, uppercased", () => {
  assert.equal(parseTicker("$DEGS gives Solana the exact narrative ... paired with $SILV."), "DEGS");
  assert.equal(parseTicker("X2 on $babycate.✅"), "BABYCATE");
  // No ticker at all is normal: 7469 is "Aped. 62k entry."
  assert.equal(parseTicker("Aped. 62k entry."), null);
  // A dollar amount is not a ticker.
  assert.equal(parseTicker("JUST IN: $100,000,000 worth of shorts liquidated"), null);
});

test("claimed multiple reads both spellings", () => {
  assert.equal(parseMultiple("3x"), 3);
  assert.equal(parseMultiple("X2 smashed on $BOXCAT. ✅"), 2);
  assert.equal(parseMultiple("Damn!. 7.3x smashed on $SOLCAT.✅"), 7.3);
  assert.equal(parseMultiple("115x btw 🦅💧"), 115);
  assert.equal(parseMultiple("Send it!"), null);
});

/// Nine of the 23 calls carry prose worth keeping. The rest are "Aped $JAS." —
/// a verb and a ticker, which is not a narrative.
const WITH_NARRATIVE = [7480, 7486, 7562, 7577, 7614, 7634, 7647, 7660, 7676];

test("the caller's own words are captured, and only when there are some", async (t) => {
  const byId = jurix();
  if (!byId) return t.skip("dump not present");
  const withNarrative: number[] = [];
  for (const [id, m] of byId) {
    const c = classify({ id, text: m.text, replyTo: m.replyTo }, "NARRATIVE");
    if (c.category === "NEW_CALL" && c.narrative) withNarrative.push(id);
  }
  assert.deepEqual(withNarrative.sort((a, b) => a - b), WITH_NARRATIVE);

  // The address and the risk boilerplate are not part of the story.
  const romanStorm = byId.get(7676)!;
  const c = classify({ id: 7676, text: romanStorm.text, replyTo: null }, "NARRATIVE");
  assert.ok(c.narrative);
  assert.ok(!c.narrative.includes("FkZL1HP8EqZStvyx5myGw7SW2SiCyWbWQVhMNrhjAh8E"));
  assert.match(c.narrative, /Roman Storm is the CoFounder of tornado cash/);
});

test("a BARE_CA call carries no narrative — the channel posts none", async (t) => {
  const path = join(dumpsDir(), "dump_private-channel.json");
  if (!existsSync(path)) return t.skip("dump not present");
  const msgs = JSON.parse(readFileSync(path, "utf8")).messages as { id: number; text: string | null }[];
  for (const m of msgs) {
    const c = classify({ id: m.id, text: m.text ?? "" }, "BARE_CA");
    if (c.category === "NEW_CALL") assert.equal(c.narrative, null, `message ${m.id}`);
  }
});
