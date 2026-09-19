/**
 * Milestone linking, replayed over the dumps in order.
 *
 * Builds the same index the ingest layer will build from Prisma, then walks
 * each channel oldest-first exactly as the listener will see it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { dumpsDir } from "../lib/paths.js";
import { classify, type ChannelKind } from "./classify.js";
import { linkMilestone, type CallIndex, type LinkMethod } from "./link.js";
import type { Chain } from "./address.js";

type Raw = { id: number; text: string | null; replyTo: number | null };

type Replay = {
  /// messageId -> how its milestone attached, or null for "attached to nothing"
  links: Map<number, { callId: string; via: LinkMethod } | null>;
  calls: number;
};

function replay(file: string, kind: ChannelKind): Replay | null {
  const path = join(dumpsDir(), file);
  if (!existsSync(path)) return null;
  const messages = (JSON.parse(readFileSync(path, "utf8")).messages as Raw[])
    .slice()
    .sort((a, b) => a.id - b.id);

  const callOfMessage = new Map<number, string>();
  const replyTarget = new Map<number, number>();
  const callOfAddress = new Map<string, string>();
  // A ticker maps to one call, or to null once it is ambiguous.
  const callOfTicker = new Map<string, string | null>();

  const index: CallIndex = {
    callForMessage: (id) => callOfMessage.get(id) ?? null,
    replyTargetOf: (id) => replyTarget.get(id) ?? null,
    callForAddress: (chain, address) => callOfAddress.get(`${chain}:${address}`) ?? null,
    callForTicker: (ticker) => callOfTicker.get(ticker) ?? null,
  };

  const links = new Map<number, { callId: string; via: LinkMethod } | null>();
  let calls = 0;

  for (const m of messages) {
    if (m.replyTo != null) replyTarget.set(m.id, m.replyTo);
    const c = classify({ id: m.id, text: m.text ?? "", replyTo: m.replyTo }, kind);

    if (c.category === "NEW_CALL" && c.address && c.chain) {
      const key = `${c.chain}:${c.address}`;
      // Rule 2: first sighting creates the call; a repeat joins the existing one.
      const callId = callOfAddress.get(key) ?? `call:${c.address.slice(0, 10)}`;
      if (!callOfAddress.has(key)) {
        callOfAddress.set(key, callId);
        calls++;
      }
      callOfMessage.set(m.id, callId);
      if (c.ticker) {
        callOfTicker.set(c.ticker, callOfTicker.has(c.ticker) && callOfTicker.get(c.ticker) !== callId
          ? null // ambiguous: two calls share a ticker, so resolve to nothing
          : callId);
      }
      continue;
    }

    if (c.category === "MILESTONE") {
      const link = linkMilestone(
        { messageId: m.id, replyTo: m.replyTo, address: c.address, chain: c.chain as Chain | null, ticker: c.ticker },
        index,
      );
      links.set(m.id, link);
      // A linked milestone becomes an anchor itself, so a reply to the reply
      // still finds the call.
      if (link) callOfMessage.set(m.id, link.callId);
      continue;
    }

    // Scanner cards are not milestones, but they do anchor a reply chain: a
    // "X2 done" replying to a card must still reach the call.
    if (c.category === "SCANNER_CARD" && c.address && c.chain) {
      const callId = callOfAddress.get(`${c.chain}:${c.address}`);
      if (callId) callOfMessage.set(m.id, callId);
    }
  }

  return { links, calls };
}

test("<private-channel>: milestones attach by walking the reply chain", async (t) => {
  const r = replay("dump_private-channel.json", "BARE_CA");
  if (!r) return t.skip("dump not present");

  // 1174 "2x 💆🏽‍♂️" replies straight to the call at 1172.
  assert.deepEqual(r.links.get(1174), { callId: "call:3HSYyCe1xs", via: "REPLY" });
  // 1240 "3x" replies to 1237, which replies to the call at 1234. Two hops.
  assert.deepEqual(r.links.get(1240), { callId: "call:3qbBseQzxK", via: "REPLY" });
  // 1121 "14k to 53k" -> 1119 -> the call at 1114.
  assert.deepEqual(r.links.get(1121), { callId: "call:AY9mRp4v2S", via: "REPLY" });

  // 1176 "3x" and 1179 "5x" were posted with no reply, no address and no
  // ticker. There is nothing to attach them to, so nothing is attached.
  assert.equal(r.links.get(1176), null);
  assert.equal(r.links.get(1179), null);
});

test("AlphaDesJurix: reply first, then ticker", async (t) => {
  const r = replay("dump_AlphaDesJurix.json", "NARRATIVE");
  if (!r) return t.skip("dump not present");

  // 7616 "2x smashed on $MANGO" replies to the call at 7610.
  assert.deepEqual(r.links.get(7616)?.via, "REPLY");
  // 7663 "$SPOONAI is up 2x from call" has no replyTo — the ticker carries it.
  assert.deepEqual(r.links.get(7663)?.via, "TICKER");
  // 7657 "18x on $biketyson" replies to 7655, which is an X link, not a call.
  // $biketyson was never called in this channel, so it attaches to nothing.
  assert.equal(r.links.get(7657), null);
});

test("link coverage across both dumps", async (t) => {
  const rows: string[] = [];
  for (const [name, file, kind] of [
    ["<private-channel>", "dump_private-channel.json", "BARE_CA"],
    ["AlphaDesJurix", "dump_AlphaDesJurix.json", "NARRATIVE"],
  ] as [string, string, ChannelKind][]) {
    const r = replay(file, kind);
    if (!r) return t.skip("dumps not present");
    const all = [...r.links.values()];
    const by = (v: LinkMethod) => all.filter((l) => l?.via === v).length;
    const unattached = all.filter((l) => l === null).length;
    rows.push(
      `  ${name.padEnd(14)} ${r.calls} calls, ${all.length} milestones -> ` +
        `reply ${by("REPLY")}, address ${by("ADDRESS")}, ticker ${by("TICKER")}, unattached ${unattached}`,
    );
  }
  console.log(`\nmilestone linking\n${rows.join("\n")}`);
});
