/**
 * npm run ingest:report [-- <since ISO timestamp>]      (default: last 24h)
 *
 * Messages by path, and median / worst lag per path, for TRACK channels — read
 * from SeenMessage, so it survives restarts. OBSERVE channels are never written
 * to the database; their numbers are in the worker's `[stats]` log lines.
 *
 *   receivedLag = receivedAt  - postedAt   Telegram -> our code (no database)
 *   writeLag    = processedAt - postedAt   Telegram -> row written (incl. cold start)
 *
 * Telegram timestamps have one-second resolution, so lags are +/- 1s.
 * Reading this wakes Neon, which is fine for a report and why it is not a timer.
 */
import "../lib/env.js";
import { prisma } from "@alphades/db";
import { waitForDatabase } from "../lib/db-wake.js";

const since = process.argv[2] ? new Date(process.argv[2]) : new Date(Date.now() - 24 * 3600_000);
await waitForDatabase(prisma);

type Row = {
  channel: string; path: string | null; n: number;
  recv_med: number | null; recv_max: number | null; write_med: number | null; write_max: number | null;
};
const raw = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
  `select c."displayName" as channel, s."ingestPath"::text as path, count(*)::int as n,
          round(percentile_cont(0.5) within group (order by extract(epoch from s."receivedAt" - s."postedAt")) * 1000)::bigint as recv_med,
          round(max(extract(epoch from s."receivedAt" - s."postedAt")) * 1000)::bigint as recv_max,
          round(percentile_cont(0.5) within group (order by extract(epoch from s."processedAt" - s."postedAt")) * 1000)::bigint as write_med,
          round(max(extract(epoch from s."processedAt" - s."postedAt")) * 1000)::bigint as write_max
     from "SeenMessage" s join "Channel" c on c.id = s."channelId"
    where s."processedAt" >= $1 and c.role = 'TRACK'
    group by c."displayName", s."ingestPath" order by 1, 2`,
  since,
);
// bigint lags (a backfilled message can be weeks old) come back as BigInt.
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const rows: Row[] = raw.map((r) => ({
  channel: String(r.channel), path: (r.path as string | null) ?? null, n: Number(r.n),
  recv_med: num(r.recv_med), recv_max: num(r.recv_max), write_med: num(r.write_med), write_max: num(r.write_max),
}));

const s = (ms: number | null) =>
  ms === null ? "   -" : ms >= 86_400_000 ? `${(ms / 86_400_000).toFixed(1)}d` : `${(ms / 1000).toFixed(1)}s`;
console.log(`TRACK channels since ${since.toISOString()} (OBSERVE channels: see [stats] log lines)\n`);
console.log(`${"channel".padEnd(26)}${"path".padEnd(10)}${"msgs".padStart(5)}   received med / worst     written med / worst`);
for (const r of rows) {
  console.log(
    `${r.channel.slice(0, 25).padEnd(26)}${(r.path ?? "(untagged)").padEnd(10)}${String(r.n).padStart(5)}` +
      `   ${s(r.recv_med).padStart(7)} / ${s(r.recv_max).padEnd(9)}   ${s(r.write_med).padStart(7)} / ${s(r.write_max)}`,
  );
}
if (rows.length === 0) console.log("(no messages in window)");
const live = rows.filter((r) => r.path === "LIVE").reduce((a, r) => a + r.n, 0);
const poll = rows.filter((r) => r.path === "POLL").reduce((a, r) => a + r.n, 0);
console.log(`\nlive=${live} poll=${poll}` + (live + poll ? `  -> ${((100 * live) / (live + poll)).toFixed(0)}% delivered live` : ""));
await prisma.$disconnect();
