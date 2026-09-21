/**
 * npm run market:poll -- [minutes]
 *
 * Runs ONLY the price loop — no Telegram, no listener — so its database impact
 * can be measured on its own. That matters because the deployed worker holds
 * the Telegram session and two processes must never share it.
 *
 * Prints the database query count every 30s. The number to watch is how rarely
 * it moves: polling happens in memory, and only a flush touches Neon.
 */
import "../lib/env.js";
import { prisma, dbQueryCount } from "@alphades/db";
import { waitForDatabase } from "../lib/db-wake.js";
import { FLUSH_INTERVAL_MS, MarketPoller } from "../market/poller.js";

const minutes = Number(process.argv[2] ?? 30);
await waitForDatabase(prisma);

const poller = new MarketPoller(prisma);
const tracked = await poller.load();
const afterLoad = dbQueryCount();
console.log(`[market] tracking ${tracked} open call(s); flush every ${FLUSH_INTERVAL_MS / 60_000}min; ` +
  `startup queries=${afterLoad}; running for ${minutes}min`);

const tick = setInterval(() => void poller.poll().catch((e) => console.error("poll:", String(e).slice(0, 120))), 15_000);
const flush = setInterval(() => void poller.flush().catch((e) => console.error("flush:", String(e).slice(0, 120))), FLUSH_INTERVAL_MS);
const report = setInterval(() => console.log(`  t+${Math.round(process.uptime())}s dbQueries=${dbQueryCount()} ${poller.statsLine()}`), 30_000);

setTimeout(async () => {
  clearInterval(tick); clearInterval(flush); clearInterval(report);
  await poller.flush().catch(() => {});
  console.log(`\nfinal: dbQueries=${dbQueryCount()} (${afterLoad} of them were the startup load)`);
  console.log(poller.statsLine());
  await prisma.$disconnect();
  process.exit(0);
}, minutes * 60_000);
