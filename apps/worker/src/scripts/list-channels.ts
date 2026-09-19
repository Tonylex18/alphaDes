/**
 * npm run tg:channels
 *
 * Lists every channel/group this account can see, with id, subs and @handle.
 * This is how we identify "<private-channel>": a private channel has NO @handle,
 * only a numeric id — and the numeric id is all the worker needs.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../lib/telegram.js";
import { dumpsDir } from "../lib/paths.js";

const client = createClient();
await client.connect();

type Row = { id: string; title: string; username: string | null; participants: number | null };
const rows: Row[] = [];

for await (const dialog of client.iterDialogs({})) {
  if (!dialog.isChannel && !dialog.isGroup) continue;
  const e = dialog.entity as any;
  rows.push({
    id: String(dialog.id),
    title: dialog.name ?? "(untitled)",
    username: e?.username ?? null,
    participants: e?.participantsCount ?? null,
  });
}

rows.sort((a, b) => (b.participants ?? 0) - (a.participants ?? 0));
const outFile = join(dumpsDir(), "channels.json");
writeFileSync(outFile, JSON.stringify(rows, null, 2));

console.log(`${"id".padEnd(18)}${"subs".padStart(7)}  ${"@handle".padEnd(24)}title`);
console.log("-".repeat(92));
for (const r of rows) {
  const handle = r.username ? `@${r.username}` : "(private)";
  console.log(`${r.id.padEnd(18)}${String(r.participants ?? "").padStart(7)}  ${handle.padEnd(24)}${r.title}`);
}
console.log(`\n${rows.length} channels written to ${outFile}`);
await client.disconnect();
