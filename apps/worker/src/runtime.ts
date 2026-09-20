/**
 * Everything the worker knows about its own liveness, held in process memory.
 *
 * It used to live in the database — a heartbeat row and Channel.lastPolledAt,
 * written on every tick. That kept Neon awake permanently: a write every 30-60s
 * means the compute never reaches its 5-minute idle threshold, and the free
 * tier's compute hours go on proving the worker is alive. Liveness is a
 * property of this process, so it lives in this process. The database is
 * touched only when a real message arrives in a watched channel.
 *
 * The cost: it resets on restart. That is acceptable for liveness (a fresh
 * process IS fresh), and the measurements that must survive — which path
 * delivered each tracked message, and how late — are written onto the
 * SeenMessage rows that the message's arrival already writes.
 */
import type { Channel } from "@alphades/db";
import { dbQueryCount } from "@alphades/db";
import type { ChannelState } from "./ingest/state.js";

export type Path = "LIVE" | "POLL" | "CATCHUP" | "BACKFILL";

/// Lags kept per path for median/worst. Bounded so a long-running process on a
/// busy channel cannot grow without limit; 5000 covers ~12 days of the busiest
/// channel we watch.
const LAG_SAMPLES = 5000;

export type PathStats = { count: number; lagsMs: number[] };

export type ChannelRuntime = {
  channel: Channel;
  /// Highest message id processed. For TRACK channels this is also persisted
  /// (Channel.lastSeenMessageId) when a message is processed; for OBSERVE
  /// channels it exists only here.
  cursor: number | null;
  lastSeenAt: Date | null;
  /// Last time a poll round-trip to Telegram for this channel succeeded.
  lastPollOkAt: Date | null;
  lastPollError: string | null;
  /// Messages already handled, so live and poll never process one twice. For
  /// TRACK channels this is ChannelState.seen (loaded from the database); for
  /// OBSERVE channels an in-memory set, trimmed as the cursor advances.
  seen: Set<number>;
  state: ChannelState | null;
  /// Serialises live and poll for this channel. Without it a message can be
  /// processed by both at once, and "which path delivered it" stops meaning
  /// anything.
  lock: Promise<unknown>;
  stats: Record<Path, PathStats>;
};

export const worker = {
  startedAt: new Date(),
  /// Telegram session connected and verified.
  telegramConnectedAt: null as Date | null,
  /// Startup catch-up finished for every channel; live from here on.
  caughtUpAt: null as Date | null,
  /// Bumped by a timer. A stale value means the event loop is wedged.
  lastTickAt: new Date(),
  /// GramJS update-loop errors, by message ("TIMEOUT", "Not connected", ...).
  updateLoopErrors: {} as Record<string, number>,
  /// Connection-state warnings from GramJS: "disconnected" then "connected".
  /// NOT the same as reconnects — GramJS emits this pair whenever a keep-alive
  /// ping is merely SLOW, socket intact. Measured locally: 26 of these in nine
  /// minutes against 2 real reconnects. Real socket reconnects are counted by
  /// updateLoopErrors, since every update-loop error triggers one.
  connectionWarnings: 0,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
  channels: new Map<string, ChannelRuntime>(),
};

export function newChannelRuntime(channel: Channel, seen: Set<number>, state: ChannelState | null): ChannelRuntime {
  const empty = (): PathStats => ({ count: 0, lagsMs: [] });
  return {
    channel,
    cursor: channel.lastSeenMessageId === null ? null : Number(channel.lastSeenMessageId),
    lastSeenAt: channel.lastSeenAt,
    lastPollOkAt: null,
    lastPollError: null,
    seen,
    state,
    lock: Promise.resolve(),
    stats: { LIVE: empty(), POLL: empty(), CATCHUP: empty(), BACKFILL: empty() },
  };
}

/// Run `fn` with this channel's lock held.
export function withChannelLock<T>(rt: ChannelRuntime, fn: () => Promise<T>): Promise<T> {
  const run = rt.lock.then(fn, fn);
  rt.lock = run.catch(() => {});
  return run;
}

export function recordPath(rt: ChannelRuntime, path: Path, lagMs: number) {
  const s = rt.stats[path];
  s.count++;
  s.lagsMs.push(lagMs);
  if (s.lagsMs.length > LAG_SAMPLES) s.lagsMs.splice(0, s.lagsMs.length - LAG_SAMPLES);
}

export function noteError(e: unknown) {
  // First line only: a Prisma error is a dozen lines of source excerpt, and
  // this string is shown on /health.
  worker.lastError = String((e as Error)?.message ?? e).split("\n").find((l) => l.trim()) ?? String(e);
  worker.lastErrorAt = new Date();
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const TICK_MS = 15_000;
/// A channel whose poll has not succeeded for this long is unhealthy. Three
/// missed 60s polls — long enough to ride out one slow Telegram round trip,
/// short enough that a dead listener shows within minutes.
export const POLL_STALE_MS = 180_000;
/// Past this, the process exits so the host restarts it. Longer than
/// POLL_STALE_MS on purpose: /health reports the problem first, and a restart
/// is the last resort, not the first.
export const WATCHDOG_MS = 600_000;

export type Health = {
  ok: boolean;
  phase: "connecting" | "catching-up" | "live";
  problems: string[];
  uptimeSeconds: number;
  dbQueries: number;
  worker: {
    secondsSinceTick: number;
    connectionWarnings: number;
    updateLoopErrors: Record<string, number>;
    lastError: string | null;
    lastErrorAt: string | null;
  };
  channels: {
    name: string;
    role: string;
    kind: string;
    cursor: number | null;
    secondsSinceLastMessage: number | null;
    secondsSincePollOk: number | null;
    healthy: boolean;
    byPath: Record<string, { count: number; medianLagMs: number | null; worstLagMs: number | null }>;
  }[];
};

export function health(now = new Date()): Health {
  const problems: string[] = [];
  const secs = (d: Date | null) => (d === null ? null : Math.round((now.getTime() - d.getTime()) / 1000));

  const phase = worker.caughtUpAt ? "live" : worker.telegramConnectedAt ? "catching-up" : "connecting";

  if (now.getTime() - worker.lastTickAt.getTime() > TICK_MS * 4) {
    problems.push(`event loop has not ticked for ${secs(worker.lastTickAt)}s`);
  }

  const channels = [...worker.channels.values()].map((rt) => {
    // Poll freshness is only meaningful once we are live. Before that the
    // process is connecting or catching up, which can take minutes, and
    // calling that unhealthy is how a backfill gets killed by its own check.
    const stale =
      phase === "live" &&
      (rt.lastPollOkAt === null || now.getTime() - rt.lastPollOkAt.getTime() > POLL_STALE_MS);
    if (stale) {
      problems.push(
        `${rt.channel.displayName}: no successful poll for ${secs(rt.lastPollOkAt) ?? "ever"}s` +
          (rt.lastPollError ? ` (${rt.lastPollError})` : ""),
      );
    }
    const byPath: Health["channels"][number]["byPath"] = {};
    for (const [path, s] of Object.entries(rt.stats)) {
      if (s.count === 0) continue;
      byPath[path] = { count: s.count, medianLagMs: median(s.lagsMs), worstLagMs: Math.max(...s.lagsMs) };
    }
    return {
      name: rt.channel.displayName,
      role: rt.channel.role,
      kind: rt.channel.kind,
      cursor: rt.cursor,
      secondsSinceLastMessage: secs(rt.lastSeenAt),
      secondsSincePollOk: secs(rt.lastPollOkAt),
      healthy: !stale,
      byPath,
    };
  });

  return {
    // Healthy while connecting or catching up, as long as the process is
    // alive: a slow backfill is not a failure.
    ok: problems.length === 0,
    phase,
    problems,
    uptimeSeconds: secs(worker.startedAt)!,
    dbQueries: dbQueryCount(),
    worker: {
      secondsSinceTick: secs(worker.lastTickAt)!,
      connectionWarnings: worker.connectionWarnings,
      updateLoopErrors: worker.updateLoopErrors,
      lastError: worker.lastError,
      lastErrorAt: worker.lastErrorAt?.toISOString() ?? null,
    },
    channels,
  };
}

/// Whether the process should give up and let the host restart it.
export function watchdogReason(now = new Date()): string | null {
  if (now.getTime() - worker.lastTickAt.getTime() > WATCHDOG_MS) return "event loop wedged";
  if (!worker.caughtUpAt) {
    // Connecting or catching up for over half an hour is not a slow backfill.
    const bootAge = now.getTime() - worker.startedAt.getTime();
    return bootAge > 3 * WATCHDOG_MS ? `still not live after ${Math.round(bootAge / 1000)}s` : null;
  }
  for (const rt of worker.channels.values()) {
    const last = rt.lastPollOkAt ?? worker.caughtUpAt;
    if (now.getTime() - last.getTime() > WATCHDOG_MS) {
      return `${rt.channel.displayName}: no successful poll for ${Math.round((now.getTime() - last.getTime()) / 1000)}s`;
    }
  }
  return null;
}

/// One line, no database. Written every STATS_INTERVAL so the 24h numbers
/// survive in the host's logs even though the counters themselves reset on
/// restart. Cumulative since process start.
export function statsLine(now = new Date()): string {
  const h = health(now);
  const ch = h.channels
    .map((c) => {
      const paths = Object.entries(c.byPath)
        .map(([p, s]) => `${p}=${s.count}(med ${s.medianLagMs}ms, worst ${s.worstLagMs}ms)`)
        .join(" ");
      return `[${c.name}|${c.role}] ${paths || "no messages"}`;
    })
    .join(" ; ");
  const ule = Object.entries(h.worker.updateLoopErrors).map(([k, v]) => `${k}=${v}`).join(",") || "0";
  return (
    `[stats] up=${h.uptimeSeconds}s phase=${h.phase} ok=${h.ok} dbQueries=${h.dbQueries} ` +
    `updateLoopErrors={${ule}} connectionWarnings=${h.worker.connectionWarnings} :: ${ch}`
  );
}
