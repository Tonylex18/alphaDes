/**
 * The long-running worker. Railway (not Vercel): it holds a persistent Telegram
 * connection and must never sleep.
 *
 * Startup order, and each step is here for a reason:
 *
 *   1. redact secrets from every log line, before anything can print
 *   2. start /health — reads memory only, so it answers immediately
 *   3. wait STARTUP_DELAY_MS. On a Railway redeploy the new container starts
 *      before the old one stops; the old one is stopped once this one's health
 *      check passes. Two processes on one Telegram session is how a session
 *      gets revoked, so this one does not touch Telegram until the old one has
 *      had time to go. 0 locally.
 *   4. read channels and their ingest state (the only routine database reads)
 *   5. connect to Telegram
 *   6. catch up every channel, in message order
 *   7. only then attach the live handler; sweep once more for the gap
 *   8. poll every POLL_INTERVAL_MS as the backstop; watchdog; stats line
 *
 * After startup, the database is touched only when a message arrives in a
 * TRACK channel. Everything else — heartbeat, poll times, path measurements for
 * OBSERVE channels — is process memory. /health reports dbQueries so that
 * claim can be checked, not taken on trust.
 */
import { installLogRedaction } from "./lib/redact.js";
import { createClient } from "./lib/telegram.js"; // loads .env — must precede the prisma import
import { prisma, type Channel } from "@alphades/db";

import { startHealthServer } from "./health.js";
import { waitForDatabase } from "./lib/db-wake.js";
import { loadChannelState } from "./ingest/state.js";
import { attachLive, primeObserver, setCallCreatedHook, sweep } from "./listener.js";
import Anthropic from "@anthropic-ai/sdk";
import { CaptureQueue } from "./market/capture.js";
import { NarrativeQueue } from "./narrative/queue.js";
import { FLUSH_INTERVAL_MS, MarketPoller } from "./market/poller.js";
import {
  worker,
  newChannelRuntime,
  noteError,
  statsLine,
  watchdogReason,
  TICK_MS,
  type ChannelRuntime,
} from "./runtime.js";

const redacted = installLogRedaction();
process.on("uncaughtException", (e) => {
  // Node prints an uncaught exception straight to stderr, around the console
  // wrapper. Route it through console so it is redacted too, then die: the
  // restart policy brings us back in a known state.
  console.error(`[fatal] uncaught exception: ${e?.stack ?? e}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error(`[fatal] unhandled rejection: ${(e as Error)?.stack ?? e}`);
  process.exit(1);
});

/// 60s, deliberately. A faster poll would do the live path's job for it and
/// hide a dead handler — the thing we are measuring.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const STARTUP_DELAY_MS = Number(process.env.STARTUP_DELAY_MS ?? 0);
const STATS_INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS ?? 15 * 60_000);
/// How often the poller LOOKS. It looks in memory; what it writes is governed
/// by the flush interval, which is much slower. See market/poller.ts.
const MARKET_TICK_MS = Number(process.env.MARKET_TICK_MS ?? 15_000);
const MARKET_ENABLED = process.env.MARKET_ENABLED !== "false";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sweepAll(client: ReturnType<typeof createClient>, path: "POLL" | "CATCHUP") {
  for (const rt of worker.channels.values()) {
    try {
      await sweep(prisma, client, rt, path);
    } catch (e) {
      rt.lastPollError = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200);
      console.error(`[${path.toLowerCase()}] ${rt.channel.displayName} failed: ${rt.lastPollError}`);
      noteError(e);
    }
  }
}

async function main() {
  const branch = process.env.NEON_BRANCH ?? "unknown";
  if (branch === "production") {
    // Test rows and experiments do not belong in the public record, and the
    // public record is the product.
    throw new Error("refusing to run against the production branch. Point DATABASE_URL at dev.");
  }
  console.log(`[worker] starting. database branch: ${branch}; ${redacted} secret value(s) redacted from logs`);

  const tick = setInterval(() => (worker.lastTickAt = new Date()), TICK_MS);
  const server = startHealthServer();

  if (STARTUP_DELAY_MS > 0) {
    console.log(`[worker] waiting ${STARTUP_DELAY_MS / 1000}s before connecting to Telegram, so a previous deployment can release the session`);
    await sleep(STARTUP_DELAY_MS);
  }

  // ---- 4. channels and their state (startup reads) ------------------------
  const woke = await waitForDatabase(prisma);
  if (woke > 1000) console.log(`[worker] database was asleep; woke in ${(woke / 1000).toFixed(1)}s`);
  const channels: Channel[] = await prisma.channel.findMany({ where: { active: true }, orderBy: { addedAt: "asc" } });
  for (const c of channels) {
    let rt: ChannelRuntime;
    if (c.role === "TRACK") {
      const state = await loadChannelState(prisma, c);
      rt = newChannelRuntime(c, state.seen, state);
    } else {
      rt = newChannelRuntime(c, new Set<number>(), null);
    }
    worker.channels.set(c.id, rt);
  }
  const summary = channels.map((c) => `${c.displayName} (${c.role}/${c.kind})`).join(", ");
  console.log(`[worker] ${channels.length} active channel(s): ${summary || "none — run seed:channels"}`);

  // ---- 5. telegram ---------------------------------------------------------
  const client = createClient();
  await client.connect();
  const me: any = await client.getMe();
  worker.telegramConnectedAt = new Date();
  console.log(`[worker] telegram session valid, signed in as @${me.username ?? me.id}`);

  // ---- 6. catch up, in order, before anything live -------------------------
  for (const rt of worker.channels.values()) {
    try {
      if (rt.channel.role === "OBSERVE") {
        await primeObserver(client, rt);
        console.log(`[observe] ${rt.channel.displayName}: watching from #${rt.cursor}, no backfill`);
      } else {
        await sweep(prisma, client, rt, rt.channel.backfilledAt === null ? "BACKFILL" : "CATCHUP");
      }
    } catch (e) {
      console.error(`[catchup] ${rt.channel.displayName} failed: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      noteError(e);
    }
  }

  // ---- 6b. market data ------------------------------------------------------
  // Narrative generation needs a key. Without one the worker runs exactly as
  // before and simply writes no generated narratives — it does not invent any.
  const narratives = process.env.ANTHROPIC_API_KEY
    ? new NarrativeQueue(prisma, new Anthropic())
    : null;
  if (!narratives) {
    console.warn("[narrative] ANTHROPIC_API_KEY not set — narratives will not be generated");
  }

  const captures = new CaptureQueue(prisma, (tokenId) => narratives?.enqueue(tokenId));
  const poller = new MarketPoller(prisma);
  if (MARKET_ENABLED) {
    // Capture the called-at market cap the moment a call is created, and start
    // polling it. Both are no-ops for calls we did not witness.
    setCallCreatedHook((t) => {
      captures.enqueue(t);
      poller.track({ ...t, calledAtMarketCapUsd: null });
    });
    const tracked = await poller.load();
    console.log(`[market] polling ${tracked} open call(s); flush every ${FLUSH_INTERVAL_MS / 60_000}min`);
  }

  // ---- 7. live -------------------------------------------------------------
  let reconnectSweep: Promise<void> | null = null;
  attachLive(prisma, client, () => {
    reconnectSweep ??= sweepAll(client, "POLL").finally(() => (reconnectSweep = null));
  });
  // Anything posted between the catch-up read and the handler attaching.
  await sweepAll(client, "CATCHUP");
  worker.caughtUpAt = new Date();
  console.log("[worker] live.");

  // ---- 8. the backstop, the watchdog, the stats line -----------------------
  let polling = false;
  const poll = setInterval(async () => {
    if (polling) return; // never stack polls behind a slow one
    polling = true;
    try {
      await sweepAll(client, "POLL");
    } finally {
      polling = false;
    }
  }, POLL_INTERVAL_MS);

  const watchdog = setInterval(() => {
    const reason = watchdogReason();
    if (!reason) return;
    // Railway does not watch /health after a deploy. Exiting is how a stuck
    // listener becomes a restarted one.
    console.error(`[watchdog] ${reason} — exiting so the host restarts the worker`);
    console.log(statsLine());
    process.exit(1);
  }, 60_000);

  const stats = setInterval(() => {
    console.log(statsLine());
    if (MARKET_ENABLED) console.log(poller.statsLine());
    if (narratives) console.log(narratives.statsLine());
  }, STATS_INTERVAL_MS);

  // The price loop. Polling is in memory; flushing is what touches Neon, and it
  // is deliberately far slower.
  let pollingMarket = false;
  const market = setInterval(async () => {
    if (!MARKET_ENABLED || pollingMarket) return;
    pollingMarket = true;
    try {
      await poller.poll();
    } catch (e) {
      console.error(`[market] poll failed: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      noteError(e);
    } finally {
      pollingMarket = false;
    }
  }, MARKET_TICK_MS);

  const marketFlush = setInterval(async () => {
    if (!MARKET_ENABLED) return;
    try {
      await poller.flush();
    } catch (e) {
      console.error(`[market] flush failed: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      noteError(e);
    }
  }, FLUSH_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} — shutting down`);
    console.log(statsLine());
    if (MARKET_ENABLED) console.log(poller.statsLine());
    for (const t of [tick, poll, watchdog, stats, market, marketFlush]) clearInterval(t);
    // Do not lose observations held in memory because the process is stopping.
    if (MARKET_ENABLED) await poller.flush().catch(() => {});
    server.close();
    await client.disconnect().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`[fatal] ${e?.stack ?? e}`);
  process.exit(1);
});
