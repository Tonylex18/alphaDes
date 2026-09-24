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
| `FEED_REVALIDATE_URL` | The web app's `/api/revalidate`. The worker POSTs here after writing so the feed can cache and never poll the database. Unset locally is fine. |
| `REVALIDATE_SECRET` | Shared with the web app. Without it the endpoint refuses every request, so nobody can force Neon awake. |
| `ANTHROPIC_API_KEY` | Narrative generation (Phase 3). Without it — or with a wrong one — the worker runs normally and writes **no narrative rows at all** for the tokens it could not reach. It never invents one, and never records "no narrative" because of its own failure, because that row could not be corrected later. |
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
npm run market:peaks -- --dry-run         # rebuild peak and time-to-peak
npm run market:peaks
```

`market:reconstruct` is resumable — it only selects calls still missing a price — and
slow by design, because GeckoTerminal allows 10 calls a minute. It never overwrites a
measured number.

`market:peaks` rebuilds `peakMarketCapUsd` / `peakAt` from OHLCV across the whole window
between the call and now, because a polled peak only covers the time since polling
started. Unlike the entry reconstruction it is **not** resumable-by-omission: it
re-examines every call, since the window grows. It is safe to re-run, costs ~2.5
GeckoTerminal requests per call, and prints the granularity split, the disagreement
against what the channels themselves claimed, and any call whose peak came out below its
entry. Stop the deployed worker first, or just let it be — the poller can only ever raise
a stored peak, never lower one.

## Narratives (Phase 3)

```bash
npm run narrative:generate -- --dry-run    # what would be read, spends nothing
npm run narrative:generate                 # needs ANTHROPIC_API_KEY
```

Generation only ever touches tokens with no narrative at all, so the caller's own words
are never replaced and nothing is regenerated. Writes are batched into one round trip.

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

## The web app — Vercel, not Railway

Next.js, reading the same Neon `dev` branch the worker writes to. Two hosts, one
database: the worker cannot go on Vercel because it holds a persistent Telegram
connection, and the web app has no reason to sit on Railway.

### Project settings

| Setting | Value | Why |
|---|---|---|
| Framework preset | Next.js | |
| Root directory | `apps/web` | |
| Include files outside the root directory | **on** | It is an npm workspaces monorepo. The build needs `packages/db` and the root `package-lock.json`; with this off, the install cannot resolve `@alphades/db`. |
| Install command | *(default)* | Vercel installs at the workspace root because the root `package.json` declares `workspaces` and the lockfile is there. |
| Build command | *(default)* | Vercel runs `vercel-build` when a package defines it, which this one does — see below. Do not override it with `next build`, which would skip the Prisma step. |
| Output directory | *(default)* | |
| Node version | 22.x | Matches local; the worker runs the same. |

### The Prisma trap, again

`apps/web/package.json` defines:

```json
"vercel-build": "npm --prefix ../.. run db:generate && next build"
```

The Prisma client is generated into `node_modules` and is not in the repo, so a build
that skips generation compiles against an empty client. `npm --prefix ../..` runs at the
workspace root, which is where `db:generate` and workspace resolution both live — `-w`
does not work from inside a workspace package.

This is not belt-and-braces. Tested on a clean `npm ci` from the root lockfile: the
client that `@prisma/client`'s own postinstall produced had **zero** knowledge of this
schema (`grep -c peakIsBackfilled` → 0), and after `vercel-build` it had 49. Vercel also
caches `node_modules` between builds, and a cache hit skips postinstall entirely.

`prisma generate` needs no database credentials — verified with both URLs unset — so
this step cannot fail for a missing secret.

### Environment variables

Four on Vercel, and **only** four. `apps/web/.env.local` exists locally and contains the
worker's secrets too, including `TG_SESSION`; do not paste it in wholesale. A Telegram
session string has no business in a second platform's environment store.

| Variable | Vercel | Railway | Must match |
|---|---|---|---|
| `DATABASE_URL` | yes — Neon **pooled** | yes | same Neon branch, or the two halves of the site disagree |
| `NEXT_PUBLIC_PRIVY_APP_ID` | yes | no | — |
| `PRIVY_APP_SECRET` | yes | no | — |
| `REVALIDATE_SECRET` | yes | yes | **yes** |
| `FEED_REVALIDATE_URL` | no | yes | must point at the Vercel deployment |
| `DIRECT_URL` | no | yes | migrations only |
| `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` | **no** | yes | — |
| `ANTHROPIC_API_KEY` | no | yes | — |
| `NEON_BRANCH`, `POLL_INTERVAL_MS`, `STARTUP_DELAY_MS` | no | yes | — |

**`REVALIDATE_SECRET` is the one with no safety net.** If the two sides disagree, the
worker's POST is rejected, the worker does not care, and the feed silently falls back to
expiring on its 10-minute cache. Nothing errors and nothing alerts — the feed just feels
slow. To check it after deploying, from a machine with the secret:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "authorization: Bearer $REVALIDATE_SECRET" \
  https://<the deployment>/api/revalidate
# 200 the two match   401 they do not   503 Vercel has no REVALIDATE_SECRET at all
```

Set `FEED_REVALIDATE_URL` on Railway to `https://<the deployment>/api/revalidate` once
the domain exists, and restart the worker.

### The build reads the database, and must fail rather than publish

`/` is statically prerendered, so a visitor never wakes Neon — but the build does, and
Neon may be suspended when it runs. The read wakes the database and retries the whole
read; if it still cannot read, **the build fails**. Publishing placeholder figures on the
one page whose argument is that its numbers are real would be worse than a failed deploy.

The retry budget is sized against Next's clock, not Neon's: `staticPageGenerationTimeout`
is 180s, and a read that can outlast it gets its worker killed and static generation
**restarted**, in a loop — observed against a database that never answered, where the
build never surfaced our own error and would have run until Vercel's build limit. The
budget is therefore a 45s wake (~3x the worst documented Neon cold start) times three
attempts, 150s worst case.

Verified by pointing `DATABASE_URL` at a dead address: the build exits 1 in about two and
a half minutes, with `landing stats: could not read the database — Can't reach database
server`, and no `index.html` is written. A normal build takes ~2m10s with no timeout
warnings.

### What ships to a signed-out visitor

Measured against a production build, not `next dev`:

| | HTML | scripts | of which Privy |
|---|---|---|---|
| `/` | 45KB, fully static | 7 chunks, 434KB | **none** |
| `/feed`, signed out | 7KB | 11 chunks, 2.6MB | 2.2MB |

The signed-out feed contains no ticker, no market cap, no close reason and no field name
from the schema — `/api/feed` verifies a Privy access token server-side and returns 401
without one.

Privy lives in the `(app)` route group rather than the root layout. A client provider in
the root layout is downloaded by **every** route under it, which had the public landing
page pulling a 1.9MB Privy chunk it never uses. Next's "First Load JS" column did not
show this — it reported 98.6KB for `/` while the served HTML referenced 2.6MB — so it has
to be measured from the HTML.

### Order of operations for the first deploy

1. Redeploy the **worker** first. Until it carries the current poller, its flush can
   overwrite a reconstructed peak with a lower in-memory value while leaving
   `peakSource` and `peakIsBackfilled` untouched — a number labelled as something it is
   not. This has happened: `$FLEX` was reconstructed at a $3.58m peak and is currently
   showing $980k with a source string still describing the reconstruction.
2. Re-run `npm run market:peaks` to repair anything it clobbered.
3. Then deploy the web app, so the prerendered landing figures are built on repaired
   rows rather than on clobbered ones.
4. Set `FEED_REVALIDATE_URL` on Railway and restart the worker.
5. Check the revalidate secret with the curl above.
