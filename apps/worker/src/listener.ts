/**
 * Getting messages from Telegram into the ingest path — by two routes, on
 * purpose, and measured.
 *
 *   LIVE   Telegram pushes a NewMessage event. Seconds. The primary path.
 *   POLL   Every POLL_INTERVAL_MS we ask Telegram for recent history and
 *          ingest anything the live path did not deliver. The backstop.
 *
 * Every message records which route delivered it first and how late (see
 * runtime.ts and SeenMessage.ingestPath). The poll is kept at 60s deliberately:
 * a fast poll would quietly do the live path's job and hide a dead handler,
 * which is the thing being measured.
 *
 * Catch-up happens before the live handler is attached, because messages are
 * causally ordered — a milestone must not be processed before its call.
 */
import type { TelegramClient } from "telegram";
import { NewMessage, Raw, type NewMessageEvent } from "telegram/events/index.js";
import { UpdateConnectionState } from "telegram/network/index.js";
import type { PrismaClient } from "@alphades/db";

import { processBatch, type IncomingMessage, type ProcessResult } from "./ingest/process.js";
import { withTransientRetry } from "./lib/db-wake.js";
import {
  worker,
  withChannelLock,
  recordPath,
  noteError,
  type ChannelRuntime,
  type Path,
} from "./runtime.js";

/// How much history to read when a TRACK channel is switched on.
export const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT ?? 200);
/// Cap on one catch-up read after downtime. Read oldest-first, so a longer
/// outage is finished by the following polls rather than silently truncated.
const CATCHUP_LIMIT = Number(process.env.CATCHUP_LIMIT ?? 500);
const POLL_LIMIT = 100;
/// The poll re-reads this many message ids BELOW the cursor. Without it, a
/// message the live path missed is lost for good the moment a later message
/// arrives live: the cursor jumps past it and the poll only asks for newer ones.
/// Channel message ids are sequential, so a fixed id window covers any gap the
/// live path can leave between polls.
export const POLL_OVERLAP = 50;
/// Messages processed between cursor writes, so a restart mid-backfill resumes
/// rather than starting over.
const CHUNK = 25;

function toIncoming(m: any, path: Path, receivedAt: Date): IncomingMessage {
  return {
    messageId: m.id,
    postedAt: new Date(m.date * 1000),
    text: m.message ?? "",
    hasMedia: Boolean(m.media),
    replyTo: m.replyTo?.replyToMsgId ?? null,
    path,
    receivedAt,
  };
}

function summarise(results: ProcessResult[]): string {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome.action] = (counts[r.outcome.action] ?? 0) + 1;
  const parts = Object.entries(counts)
    .filter(([k]) => k !== "ignored")
    .map(([k, v]) => `${k}=${v}`);
  if (counts.ignored) parts.push(`ignored=${counts.ignored}`);
  return parts.join(" ") || "nothing";
}

const entities = new Map<string, unknown>();
async function entityFor(client: TelegramClient, rt: ChannelRuntime) {
  const key = rt.channel.id;
  if (!entities.has(key)) entities.set(key, await client.getEntity(BigInt(rt.channel.telegramId.toString()) as any));
  return entities.get(key) as any;
}

/**
 * Hand messages to the ingest path, once each, under the channel's lock.
 *
 * TRACK channels write rows. OBSERVE channels write nothing at all — they exist
 * to measure the two paths, and a busy observation channel (hundreds of
 * messages a day) would otherwise keep the database awake around the clock.
 */
export async function ingest(
  prisma: PrismaClient,
  rt: ChannelRuntime,
  messages: IncomingMessage[],
  path: Path,
): Promise<number> {
  return withChannelLock(rt, async () => {
    // Checked inside the lock: live and poll can both reach here for the same
    // message, and only the first may count.
    const fresh = messages
      .filter((m) => !rt.seen.has(m.messageId))
      .sort((a, b) => a.messageId - b.messageId);
    if (fresh.length === 0) return 0;

    const lag = (m: IncomingMessage) => (m.receivedAt ?? new Date()).getTime() - m.postedAt.getTime();

    if (rt.channel.role === "OBSERVE") {
      for (const m of fresh) {
        rt.seen.add(m.messageId);
        recordPath(rt, path, lag(m));
      }
      advanceCursor(rt, fresh[fresh.length - 1]!);
      trimSeen(rt);
      return fresh.length;
    }

    // TRACK. A message we only saw because we were not listening cannot have
    // its called-at market cap measured at call time, so CATCHUP is recorded
    // on the Call as BACKFILL, same as history.
    const source = path === "BACKFILL" || path === "CATCHUP" ? "BACKFILL" : "LIVE";
    const started = Date.now();
    const results: ProcessResult[] = [];
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const chunk = fresh.slice(i, i + CHUNK);
      results.push(
        ...(await withTransientRetry(`${path.toLowerCase()} ${rt.channel.displayName}`, () =>
          processBatch(prisma, rt.channel, chunk, { source }, rt.state!),
        )),
      );
      const last = chunk[chunk.length - 1]!;
      // Advance only after the chunk's rows have landed. A crash before this
      // line replays the chunk, harmlessly; a crash after it resumes from here.
      if (rt.cursor === null || last.messageId > rt.cursor) {
        await withTransientRetry(`cursor ${rt.channel.displayName}`, () =>
          prisma.channel.update({
            where: { id: rt.channel.id },
            data: { lastSeenMessageId: BigInt(last.messageId), lastSeenAt: last.postedAt },
          }),
        );
        advanceCursor(rt, last);
      }
      for (const m of chunk) recordPath(rt, path, lag(m));
    }
    if (path === "BACKFILL") {
      await prisma.channel.update({ where: { id: rt.channel.id }, data: { backfilledAt: new Date() } });
      rt.channel.backfilledAt = new Date();
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const lags = fresh.map(lag);
    console.log(
      `[${path.toLowerCase()}] ${rt.channel.displayName}: ${fresh.length} message(s) in ${secs}s` +
        ` (lag ${Math.min(...lags)}-${Math.max(...lags)}ms) -> ${summarise(results)}; cursor=${rt.cursor}`,
    );
    return fresh.length;
  });
}

function advanceCursor(rt: ChannelRuntime, m: IncomingMessage) {
  if (rt.cursor === null || m.messageId > rt.cursor) {
    rt.cursor = m.messageId;
    rt.lastSeenAt = m.postedAt;
  }
}

/// OBSERVE channels keep their seen-set in memory; drop ids the poll can no
/// longer reach so a busy channel does not grow it forever.
function trimSeen(rt: ChannelRuntime) {
  if (rt.cursor === null || rt.seen.size < 2000) return;
  const floor = rt.cursor - POLL_OVERLAP * 4;
  for (const id of rt.seen) if (id < floor) rt.seen.delete(id);
}

/**
 * Read from Telegram and ingest what we have not seen.
 *
 *   BACKFILL  newest BACKFILL_LIMIT messages — a TRACK channel's first run
 *   CATCHUP   oldest-first from just below the cursor, after time away
 *   POLL      oldest-first from POLL_OVERLAP ids below the cursor
 *
 * A successful Telegram round trip is recorded whether or not it found
 * anything. That is the fact the health check needs, and it costs no query.
 */
export async function sweep(
  prisma: PrismaClient,
  client: TelegramClient,
  rt: ChannelRuntime,
  path: Path,
): Promise<number> {
  const entity = await entityFor(client, rt);
  const receivedAt = new Date();
  const batch: IncomingMessage[] = [];

  if (path === "BACKFILL") {
    for await (const m of client.iterMessages(entity, { limit: BACKFILL_LIMIT })) {
      batch.push(toIncoming(m, path, receivedAt));
    }
  } else {
    const minId = rt.cursor === null ? 0 : Math.max(0, rt.cursor - POLL_OVERLAP);
    const limit = path === "CATCHUP" ? CATCHUP_LIMIT : POLL_LIMIT;
    for await (const m of client.iterMessages(entity, { reverse: true, minId, limit })) {
      batch.push(toIncoming(m, path, receivedAt));
    }
  }

  rt.lastPollOkAt = new Date();
  rt.lastPollError = null;
  return ingest(prisma, rt, batch, path);
}

/**
 * OBSERVE channels do not backfill: their history is not ours to record. On
 * start they are pointed at "now" — the latest POLL_OVERLAP ids are marked seen
 * — so the first poll measures new messages instead of ingesting the past.
 */
export async function primeObserver(client: TelegramClient, rt: ChannelRuntime): Promise<void> {
  const entity = await entityFor(client, rt);
  let newest: IncomingMessage | null = null;
  for await (const m of client.iterMessages(entity, { limit: POLL_OVERLAP })) {
    rt.seen.add(m.id);
    if (!newest) newest = toIncoming(m, "CATCHUP", new Date());
  }
  if (newest) advanceCursor(rt, newest);
  rt.lastPollOkAt = new Date();
}

/**
 * Attach the live handler, the GramJS error counter, and the connection-state
 * watcher. Called once, after catch-up.
 */
export function attachLive(
  prisma: PrismaClient,
  client: TelegramClient,
  onReconnected: () => void,
): void {
  const byTelegramId = new Map<string, ChannelRuntime>();
  for (const rt of worker.channels.values()) byTelegramId.set(rt.channel.telegramId.toString(), rt);

  client.addEventHandler(async (event: NewMessageEvent) => {
    const receivedAt = new Date();
    // GramJS reports a channel as its marked id, "-100" + channel id, which is
    // how Channel.telegramId is stored. The fallback covers an unmarked id.
    const chatId = event.message.chatId?.toString();
    if (!chatId) return;
    const rt = byTelegramId.get(chatId) ?? byTelegramId.get(`-100${chatId.replace(/^-/, "")}`);
    if (!rt) return; // not a watched channel — no database, no work

    const msg = toIncoming(event.message, "LIVE", receivedAt);
    try {
      const n = await ingest(prisma, rt, [msg], "LIVE");
      if (n > 0 && rt.channel.role === "OBSERVE") {
        console.log(`[live] ${rt.channel.displayName} #${msg.messageId} lag ${receivedAt.getTime() - msg.postedAt.getTime()}ms`);
      }
    } catch (e) {
      // Not advanced, so the next poll picks it up (and records it as POLL).
      console.error(`[live] ${rt.channel.displayName} #${msg.messageId} FAILED: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      noteError(e);
    }
  }, new NewMessage({}));

  // Every error GramJS's update loop hits goes through here before it is
  // printed — "TIMEOUT" from a failed ping, "Not connected" mid-reconnect.
  // Counted in memory; the stats line reports them.
  client.onError = async (err: Error) => {
    const key = (err?.message ?? String(err)).split("\n")[0]!.slice(0, 60);
    worker.updateLoopErrors[key] = (worker.updateLoopErrors[key] ?? 0) + 1;
  };

  // Connection state. GramJS says "disconnected" when a keep-alive ping is slow
  // and "connected" when it answers — a warning, not necessarily a dropped
  // socket. Either way the live stream may have missed something in between,
  // so sweep once rather than wait up to a minute for the next poll. Counted as
  // a warning, not as a reconnect: see runtime.ts.
  let wasDown = false;
  client.addEventHandler((update: unknown) => {
    if (!(update instanceof UpdateConnectionState)) return;
    const state = (update as any).state as number;
    if (state === UpdateConnectionState.disconnected || state === UpdateConnectionState.broken) {
      wasDown = true;
    } else if (state === UpdateConnectionState.connected && wasDown) {
      wasDown = false;
      worker.connectionWarnings++;
      onReconnected();
    }
  }, new Raw({}));

  console.log(`[live] subscribed to ${byTelegramId.size} channel(s)`);
}
