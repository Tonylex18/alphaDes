/**
 * npm run tg:dump -- @AlphaDesJurix -1001234567890 --limit 200
 *
 * Writes data/dumps/dump_<channel>.json per channel, where <channel> is the
 * @handle, or the numeric id when the channel is private and has none.
 *
 * `--as <label>` overrides that name for the FIRST target. A private channel's
 * id is an identifier we would rather not hardcode into a committed test
 * fixture, so its dump is written as a label instead:
 *
 *   npm run tg:dump -- -1001234567890 --as private-channel --limit 200
 *
 * Read these before writing the classifier — the whole point of Day 0.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../lib/telegram.js";
import { dumpsDir } from "../lib/paths.js";
import { extractAddresses } from "../lib/solana.js";

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 100;
const asIdx = argv.indexOf("--as");
const label = asIdx >= 0 ? argv[asIdx + 1] : undefined;
const consumed = new Set([limitIdx + 1, asIdx + 1].filter((i) => i > 0));
const targets = argv.filter((a, i) => !a.startsWith("--") && !consumed.has(i));

if (targets.length === 0) {
  console.error("Pass one or more @handles or numeric ids. See the header of this file.");
  process.exit(1);
}

const client = createClient();
await client.connect();

for (const [i, target] of targets.entries()) {
  const key = /^-?\d+$/.test(target) ? BigInt(target) : target;
  const entity: any = await client.getEntity(key as any);
  const name =
    i === 0 && label ? label : (entity.username ?? String(entity.id)).replace(/^@/, "");

  const messages: unknown[] = [];
  for await (const m of client.iterMessages(entity, { limit })) {
    const text = m.message ?? "";
    messages.push({
      id: m.id,
      date: new Date(m.date * 1000).toISOString(),
      text,
      hasMedia: Boolean(m.media),
      mediaType: m.media ? (m.media as any).className : null,
      replyTo: m.replyTo?.replyToMsgId ?? null,
      candidateAddresses: extractAddresses(text),
    });
  }

  const file = join(dumpsDir(), `dump_${name}.json`);
  writeFileSync(file, JSON.stringify({ channel: entity.title ?? name, messages }, null, 2));

  const withCa = messages.filter((m: any) => m.candidateAddresses.length).length;
  const withMedia = messages.filter((m: any) => m.hasMedia).length;
  console.log(`\n${entity.title ?? name} -> ${file}`);
  console.log(`  ${messages.length} messages | ${withCa} contain a possible CA | ${withMedia} have media`);
}

await client.disconnect();
