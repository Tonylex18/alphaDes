/**
 * npm run seed:channels
 *
 * Upserts the Channel rows from CHANNEL_<n>_* in .env. Safe to re-run: it
 * updates the descriptive fields and leaves the ingest cursor
 * (lastSeenMessageId, backfilledAt) alone, so re-seeding never replays history.
 *
 * A channel that disappears from .env is NOT deleted — deleting it would orphan
 * its calls. Set CHANNEL_<n>_ACTIVE=false to switch one off instead.
 */
import "../lib/env.js"; // loads the repo-root .env — must precede the prisma import
import { prisma } from "@alphades/db";
import { readChannelConfig } from "../ingest/channel-config.js";

const configured = readChannelConfig();
if (configured.length === 0) {
  console.error("No CHANNEL_1_ID in .env — nothing to seed. See .env.example.");
  process.exit(1);
}

for (const c of configured) {
  const row = await prisma.channel.upsert({
    where: { telegramId: c.telegramId },
    create: {
      telegramId: c.telegramId,
      kind: c.kind,
      role: c.role,
      displayName: c.displayName,
      username: c.username,
      active: c.active,
    },
    update: {
      kind: c.kind,
      role: c.role,
      displayName: c.displayName,
      username: c.username,
      active: c.active,
    },
  });
  console.log(
    `  ${row.displayName.padEnd(28)} role=${row.role.padEnd(7)} kind=${row.kind.padEnd(9)} active=${String(row.active).padEnd(5)}` +
      ` cursor=${row.role === "OBSERVE" ? "n/a (observe only: no backfill, nothing stored)" : (row.lastSeenMessageId ?? "none (will backfill)")}`,
  );
}

const total = await prisma.channel.count();
console.log(`\n${configured.length} configured, ${total} channel row(s) in the database.`);
await prisma.$disconnect();
