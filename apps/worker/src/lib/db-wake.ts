/**
 * Surviving Neon's scale-to-zero.
 *
 * Observed on the dev branch, from a laptop, after a few idle minutes:
 *
 *   - the first connection takes ~5s and succeeds (the compute is waking);
 *   - NEW connections opened in the following seconds fail with P1001 "Can't
 *     reach database server", because Prisma's connect timeout is 5s and the
 *     compute is not fully up;
 *   - a few seconds later, everything works.
 *
 * So a single `select 1` is not proof the database is ready: it proves ONE
 * pooled connection is. The ingest path opens several at once (loadChannelState
 * reads three tables in parallel), and those are the ones that failed.
 */
import type { PrismaClient } from "@alphades/db";

/// How many connections to prove before calling the database awake. Matches the
/// widest fan-out on the ingest path.
const WARM_PARALLELISM = 4;

export async function waitForDatabase(
  prisma: PrismaClient,
  { timeoutMs = 120_000, intervalMs = 3_000 } = {},
): Promise<number> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await Promise.all(
        Array.from({ length: WARM_PARALLELISM }, () => prisma.$queryRawUnsafe("select 1")),
      );
      return Date.now() - started;
    } catch (e) {
      // A wrong password or a malformed URL is not going to wake up. Fail now,
      // with the real reason, instead of reporting "unreachable" two minutes
      // later — which is what a misconfigured deploy used to do.
      if (!isTransient(e)) {
        throw new Error(`database rejected the connection: ${firstLine(e)}`);
      }
      lastError = e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  // Neon reports a WRONG PASSWORD exactly as it reports a network failure —
  // "Can't reach database server", no error code — because its proxy just
  // drops the connection. Measured, not assumed. So this message has to name
  // both possibilities, or a bad DATABASE_URL on Railway reads as an outage.
  throw new Error(
    `database unreachable after ${timeoutMs / 1000}s — either the network, or DATABASE_URL's ` +
      `credentials are wrong (Neon reports both the same way): ${firstLine(lastError)}`,
  );
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split("\n").map((l) => l.trim()).find(Boolean) ?? String(e);
}

/// Connection-level failures worth retrying. Anything else — a constraint
/// violation, a bad query — is a bug, and retrying a bug only hides it.
const TRANSIENT = /P1001|P1002|P1008|P1017|P2024|Can't reach database server|Timed out fetching a new connection|Server has closed the connection/;

export function isTransient(e: unknown): boolean {
  return TRANSIENT.test(String((e as Error)?.message ?? e));
}

/**
 * Retry a unit of ingest work on transient connection errors.
 *
 * Safe ONLY because the ingest path is idempotent: a batch that half-landed
 * before the connection dropped is replayed from the start, and every write it
 * already made is a no-op the second time. If that property is ever broken,
 * this function turns a crash into duplicate rows. process.test.ts guards it.
 */
export async function withTransientRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { attempts = 5, baseDelayMs = 2_000 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= attempts) throw e;
      const delay = baseDelayMs * attempt;
      console.warn(`[retry] ${label}: transient database error, attempt ${attempt}/${attempts}, retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
