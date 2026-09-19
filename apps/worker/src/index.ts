/**
 * The long-running worker. NOT deployable to Vercel — it needs a persistent
 * connection and a process that never sleeps. Railway or Fly.io.
 *
 * Phase 1 builds this out. Right now it is a skeleton that proves the wiring:
 * env loads, database reachable, Telegram session valid.
 */
// telegram.js loads the repo-root .env as a side effect. It is imported FIRST
// on purpose: ESM evaluates imports in order, and the Prisma client reads
// DATABASE_URL when it is constructed by @alphades/db.
import { createClient } from "./lib/telegram.js";
import { prisma } from "@alphades/db";

async function main() {
  const channels = await prisma.channel.findMany({ where: { active: true } });
  console.log(`[worker] ${channels.length} active channel(s) configured`);

  const client = createClient();
  await client.connect();
  const me: any = await client.getMe();
  console.log(`[worker] telegram session valid, signed in as @${me.username ?? me.id}`);

  // TODO Phase 1: subscribe to new messages on every active channel,
  // extract CAs, first sighting -> Call, later sightings -> CallEvent.
  await client.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
