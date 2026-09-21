# Deploying the worker

**The worker only.** The web app is not deployed — it runs locally for now.

The worker holds a persistent Telegram connection and must never sleep, so it cannot
go on Vercel. Railway (or Fly) runs it as an always-on container. It writes to the
Neon `dev` branch; the web app reads the same database.

Most of this is already in `railway.json` at the repo root and needs no clicking.
The settings are listed anyway, because a dashboard setting silently disagreeing with
the file is a bad afternoon.

## Service settings

| Setting | Value | Why |
|---|---|---|
| Root directory | `/` | It is an npm workspaces monorepo. The worker depends on `packages/db`, so the build needs the whole repo, not `apps/worker`. |
| Build command | `npm install && npm run db:generate` | `db:generate` writes the Prisma client into `node_modules`. It needs no environment variables. |
| Start command | `npm run start -w @alphades/worker` | Runs `tsx src/index.ts`. No compile step — see below. |
| Health check path | `/health` | |
| Health check timeout | `600` seconds | The grace period. A first backfill reads 200 messages per channel; a deploy must not be failed for being slow. |
| Restart policy | `ALWAYS` | Not `ON_FAILURE`: its retry cap would leave the worker dead for good after a long enough Telegram outage. |
| Replicas | **exactly 1** | Two replicas means two processes on one Telegram session, which is how a session gets revoked. |
| Region | `us-east4` | Next to Neon in `us-east-2`. A message costs several database round trips and one Telegram delivery, so proximity to the database wins. |
| `overlapSeconds` | `"0"` | See "Redeploys" below. |
| `drainingSeconds` | `"15"` | Time for `SIGTERM` to disconnect Telegram cleanly before `SIGKILL`. |

`npm install` rather than `npm ci` in the build only because Railway may reuse a
cache; both work — `npm ci --omit=dev` is tested (see "Production dependencies").

## Environment variables

Set these in the Railway dashboard. **No secret belongs in the repo.**

| Variable | Notes |
|---|---|
| `TG_API_ID`, `TG_API_HASH` | From my.telegram.org. Per-person, permanent. |
| `TG_SESSION` | Full access to the Telegram account. The most dangerous string here. |
| `DATABASE_URL` | Neon **pooled** (`-pooler` in the hostname). Runtime queries. |
| `DIRECT_URL` | Neon **non-pooled**. Migrations only; the worker does not use it at runtime, but Prisma's schema references it. |
| `NEON_BRANCH` | `dev`. The worker **refuses to start** if this is `production`. |
| `POLL_INTERVAL_MS` | `60000`. Leave it. A faster poll would do the live handler's job and hide it being dead — which is what we are measuring. |
| `STARTUP_DELAY_MS` | `20000` on Railway. See "Redeploys". |
| `CHANNEL_<n>_ID` / `_KIND` / `_NAME` / `_USERNAME` / `_ROLE` | Only read by `npm run seed:channels`. The worker reads the `Channel` table, never these. Setting them on Railway is optional. |
| `PORT` | Railway injects it. Do not set it. |

The worker scrubs `TG_SESSION`, `TG_API_HASH` and both database URLs — and a database
password on its own — from every log line, including error paths and uncaught
exceptions. Railway retains logs, so this matters; `apps/worker/src/lib/redact.ts`.

## Production dependencies

The worker runs TypeScript directly through `tsx`; there is no build output. So `tsx`
is a **dependency**, not a devDependency, and so is `prisma` in `packages/db` (the
build runs `db:generate`). Railway may install with `NODE_ENV=production`, which skips
devDependencies — without this the container starts and immediately dies on
`tsx: not found`.

Tested, not assumed:

```bash
rm -rf node_modules && npm ci --omit=dev && npm run db:generate
npm run start -w @alphades/worker      # reaches "[worker] live."
```

## Redeploys, and the one rule about the Telegram session

**Never run two processes on one Telegram session.** Telegram may revoke it, and
recovering means logging in again with a phone code. In practice:

- Do not run a local worker, `tg:login`, `tg:channels` or `tg:dump` while the deployed
  worker is up. Stop it first.
- Railway starts the new container **before** stopping the old one. So the worker
  answers `/health` as soon as its HTTP server is up — which lets Railway stop the old
  deployment — and only then, after `STARTUP_DELAY_MS`, connects to Telegram. With
  `overlapSeconds: "0"` the window where both could be connected is closed.

## Adding or changing a channel

Channels are configuration, not code, but the worker reads them **at startup** rather
than polling for changes — polling the channel table every minute was a database query
every minute, which kept Neon awake.

```bash
# edit CHANNEL_<n>_* in .env, then, locally, against the dev branch:
npm run seed:channels
# then restart the Railway service
```

`role = OBSERVE` channels are watched for ingestion measurements only. Nothing they
post is written to the database, so nothing they post can reach the track record.

## Market data (Phase 2)

Runs inside the worker: prices are polled in memory and flushed to the database on a
slow cadence. Environment variables, all optional:

| Variable | Default | Notes |
|---|---|---|
| `MARKET_ENABLED` | on | Set to `false` to run ingestion without the price loop. |
| `MARKET_TICK_MS` | `15000` | How often the poller LOOKS. Cheap: in memory. |
| `MARKET_FLUSH_INTERVAL_MS` | `900000` | How often it WRITES. This is the Neon dial — longer means the database sleeps more and the site's "latest" is staler. |
| `GECKO_MIN_INTERVAL_MS` | `7000` | GeckoTerminal's free tier is 10 calls/min. |

Two scripts, both run locally against the dev branch:

```bash
npm run market:report                  # state of every called-at market cap
npm run market:reconstruct -- --dry-run   # rebuild historical entry prices
npm run market:reconstruct
```

`market:reconstruct` is resumable — it only selects calls still missing a price — and
slow by design, because GeckoTerminal allows 10 calls a minute. It never overwrites a
measured number.

## After deploying

```bash
npm run ingest:report -- 2026-09-20T00:00:00Z   # messages by path, lag per path
```

- `/health` returns 200 when alive, 503 otherwise, and reports `dbQueries` — which must
  not move while no messages are arriving.
- **Railway checks `/health` only during a deploy.** It does not monitor it afterwards.
  The ongoing guard is the worker's own watchdog: if no channel has polled successfully
  for 10 minutes, or the event loop stops ticking, it logs the reason and exits, and
  the `ALWAYS` restart policy brings it back. For outside alerting, point an uptime
  monitor at `/health` — that needs a public domain, which also exposes the channel
  names, so it is not enabled by default.
- The worker prints a `[stats]` line every 15 minutes: messages by path, median and
  worst lag, database queries, connection warnings. That is where an OBSERVE channel's
  numbers live, since it writes nothing.
