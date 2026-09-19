/**
 * The classifier measured against the Day 0 dumps.
 *
 * Prints per-category precision and recall. "It works" is not a result; the
 * numbers are. Run with `npm test`.
 *
 * The dumps are gitignored (they are channel content), so this suite skips
 * loudly rather than failing when they are absent. Re-create them with
 * `npm run tg:dump -- <channel> --limit 200`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { dumpsDir } from "../lib/paths.js";
import { classify, type Category } from "./classify.js";
import { DUMPS, type Label } from "./fixtures/labels.js";

type DumpMessage = { id: number; text: string | null; replyTo: number | null };

const CATEGORIES: Label[] = ["NEW_CALL", "MILESTONE", "SCANNER_CARD"];

function loadDump(file: string): DumpMessage[] | null {
  const path = join(dumpsDir(), file);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")).messages as DumpMessage[];
}

for (const dump of DUMPS) {
  test(`${dump.name} (${dump.kind})`, async (t) => {
    const messages = loadDump(dump.file);
    if (!messages) {
      t.skip(`${dump.file} not in ${dumpsDir()} — run npm run tg:dump`);
      return;
    }

    const actual = new Map<number, Category>();
    for (const m of messages) {
      actual.set(m.id, classify({ id: m.id, text: m.text ?? "", replyTo: m.replyTo }, dump.kind).category);
    }

    const truth = new Map<number, Label>();
    for (const c of CATEGORIES) for (const id of dump.expected[c]) truth.set(id, c);

    const lines: string[] = [];
    let totalFp = 0;
    let totalFn = 0;

    for (const c of CATEGORIES) {
      const expected = new Set(dump.expected[c]);
      const got = [...actual.entries()].filter(([, v]) => v === c).map(([id]) => id);
      const tp = got.filter((id) => expected.has(id));
      const fp = got.filter((id) => !expected.has(id));
      const fn = [...expected].filter((id) => actual.get(id) !== c);
      totalFp += fp.length;
      totalFn += fn.length;

      const pct = (n: number, d: number) => (d === 0 ? "   n/a" : `${((100 * n) / d).toFixed(1)}%`);
      lines.push(
        `  ${c.padEnd(13)} expected ${String(expected.size).padStart(3)}  found ${String(got.length).padStart(3)}` +
          `  tp ${String(tp.length).padStart(3)}  fp ${String(fp.length).padStart(2)}  fn ${String(fn.length).padStart(2)}` +
          `  precision ${pct(tp.length, got.length)}  recall ${pct(tp.length, expected.size)}`,
      );
      if (fp.length) lines.push(`      false positives: ${fp.join(", ")}`);
      if (fn.length) lines.push(`      false negatives: ${fn.join(", ")}`);
    }

    const labelled = truth.size;
    const noise = messages.length - labelled;
    const noiseWrong = [...actual.entries()].filter(([id, v]) => v !== "NOISE" && !truth.has(id));
    lines.push(
      `  ${"NOISE".padEnd(13)} expected ${String(noise).padStart(3)}` +
        `  leaked into a category: ${noiseWrong.length}`,
    );

    console.log(`\n${dump.name} — ${messages.length} messages, ${labelled} labelled\n${lines.join("\n")}`);

    assert.equal(totalFp, 0, "false positives against the hand-checked labels");
    assert.equal(totalFn, 0, "false negatives against the hand-checked labels");
  });

  test(`${dump.name}: known misses stay NOISE`, async (t) => {
    const messages = loadDump(dump.file);
    if (!messages) {
      t.skip("dump not present");
      return;
    }
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const miss of dump.knownMisses) {
      const m = byId.get(miss.id);
      assert.ok(m, `message ${miss.id} is not in ${dump.file}`);
      const c = classify({ id: m.id, text: m.text ?? "", replyTo: m.replyTo }, dump.kind);
      assert.equal(c.category, "NOISE", `${miss.id} (${miss.why}) is no longer NOISE`);
    }
  });
}
