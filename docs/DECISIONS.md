# Decisions

Settled before any code was written. Add to this file rather than re-litigating.

**Two hosts, not one.** The Telegram listener needs a persistent connection and a
process that never sleeps. Vercel gives neither. Web on Vercel, worker on Railway or
Fly. ~$5/month.

**TypeScript everywhere, GramJS not Telethon.** An earlier draft used Python/Telethon
for the exploration scripts. Telethon and GramJS session strings are not compatible —
that would have meant logging in twice and holding two credentials. One stack, one
login, one session string the worker reuses.

**Channels are rows, not constants.** Adding a channel is an insert. This is what lets
the second channel go live the moment its handle or id is known, with no deploy.

**Backfill on channel add.** Without it the public track record is empty for a
fortnight after launch. GeckoTerminal's free OHLCV endpoint reconstructs called-at
market cap and peak from historical candles. Half a day of work; the difference
between proof and a promise. Reconstructed numbers are flagged, never mixed silently
with measured ones.

**Narrative generated once, never regenerated.** It is a record of what was claimed at
call time, not a live description. Regenerating would quietly rewrite history.

**Not in v1:** in-app buying (redirect to GMGN/Axiom; build it browser-signed later,
the app never holds a key), embedded charts, "what people are saying on X" (the usable
API tier is hundreds a month — the token's own socials are free and enough), more than
two channels, payments.

**Neon scales to zero** and a cold start costs 20–30 seconds. The price-polling loop
keeps it warm for free — but a cold branch must never be the reason a call arrives late.

**Repo-root paths are resolved, never assumed.** npm workspaces run scripts with
cwd set to the workspace directory, so `dotenv/config` looked for `apps/worker/.env`
and the dump scripts wrote to `apps/worker/data/dumps/`. Rather than duplicating
`.env` into each workspace, `apps/worker/src/lib/paths.ts` walks up from
`import.meta.url` until it finds the package.json with a `workspaces` key and exports
`REPO_ROOT`, `ENV_PATH` and `dumpsDir()`. One .env, one dumps directory, wherever a
script is started from.

**The Prisma CLI has the same problem, and the same fix.** `npm run db:push` runs
with cwd = `packages/db`, so the Prisma CLI could not see the root .env either — it
failed with "Environment variable not found: DIRECT_URL". The `push` and `studio`
scripts are now prefixed with `dotenv -e ../../.env --` (dotenv-cli, a devDependency
of `@alphades/db`). `generate` needs no env and is left alone.

**`directUrl` on the datasource.** Neon's pooled endpoint (hostname contains
`-pooler`) cannot run migrations or `db push`. `DATABASE_URL` stays pooled for
runtime; `DIRECT_URL` is the same credentials against the non-pooled host and is used
by Prisma for schema changes only.

**Neon CLI yes, `neon config init` / `neon.ts` / `neon deploy` no.** Those are Neon's
flow for deploying an application onto Neon. Our targets are Vercel for the web app
and Railway/Fly for the worker — the Telegram listener needs a process that never
sleeps, which is the whole reason for two hosts. We use Neon as a database only: CLI
for branch management, MCP so the agent can inspect it, `neon link` to pin the
project.

**Two chains, not one; and the chain is recorded.** Solana-only was an incorrect
assumption. The Day 0 dumps contain six EVM addresses — `<private-channel>` posts three of
them bare, i.e. as calls, and AlphaDesJurix calls one on BNB (7520) and one on
HyperEVM (7550). `Token.chain` is `SOLANA` or `EVM` and no finer, because the address
format cannot tell one EVM chain from another. Narrowing that needs a metadata
lookup and belongs in Phase 2. `Token.address` stays globally unique: a Solana
address and an EVM address cannot collide by shape, and the same EVM address on two
chains is a problem we cannot detect today anyway.

**Base58 is decoded, not pattern-matched.** A 32–44 character base58 run is not
necessarily an address; only one that decodes to exactly 32 bytes is. On the 400
dumped messages the decode check rejects nothing the regex accepted, so it buys no
precision today — it is there for the scanner-card text we have not seen yet, and it
costs one BigInt loop per candidate.

**Channel shape is a column, not a branch on channel id.** `Channel.kind` is
`BARE_CA` or `NARRATIVE`. The two channels share no message shape, so one classifier
with one rule set was never going to work; what makes it configuration rather than
hardcoding is that the rule set is selected by that column. A third channel is an
insert. A third *shape* is a new enum value.

**A caller's claim and our measurement never merge.** `Call.statedMarketCapUsd` holds
"Rn at 87k MC" -> 87000. `Call.calledAtMarketCapUsd` holds what we measured at
ingestion. `CallEvent.claimedMultiple` holds "X2"; our multiple is derived from our
own numbers. When a claim and a measurement disagree, both are shown. That
disagreement is the product.

**Scanner cards contribute identity, never numbers.** A third-party card confirms
which token a message is about and anchors a reply chain, but the first "xN" in one
is as likely to be liquidity as price (7481 `Liq: 22.3K [x13]`, 7570 `[x10]`). So
`SCANNER_CARD` reports an address and a ticker and no multiple.

**Phase 3 changes: generate a narrative only when the channel gave us none.** Nine of
AlphaDesJurix's 23 calls carry real prose from the caller, written at call time.
That is better evidence than an LLM summary of a project's website, and it is free.
Those are stored as the `Narrative` with `sourceNote` "The caller's own words at call
time". Generation is reserved for calls that arrived with nothing — which is every
call from `<private-channel>`, whose calls are a bare address. Generated-once-never-regenerated
still holds, and the card must label which of the two sources it is showing.

**A milestone with no identifiable parent attaches to nothing.** Linking is replyTo,
then a known address, then a ticker within the channel, and then it stops. Seven of
the 41 milestones in the dumps resolve to nothing — bare "3x" messages with no reply,
and a boast about a call made on the caller's X account. They stay `UNCLASSIFIED`.
Crediting a 5x to the wrong token is precisely the dishonesty this product exists to
avoid.

## Phase 1 — ingestion

**Commentary on BARE_CA channels is stitched inside a 90-second window, and never
writes a number.** The private channel posts the bare address and then its opinion as
separate messages ("gamble", "Risking this", "Got in 14k"). The window was measured
on the Day 0 dump: across 26 calls, on-topic commentary lands within 77 seconds, and
past ~90 the chatter has moved to other tokens, media and replies to older messages.
90s admits 26 messages; 24 are about the call they follow. The two that are not —
call 1242 +54s "Send is at 600k mc now" and +63s "So maybe a 2nd runner" — are about
a different token, and the first contains a market cap. "Got in 14k" (call 1114,
+72s) and "Send is at 600k mc now" are the same shape and cannot be told apart. So
stitched messages become `COMMENTARY` events with the raw text, shown as chatter that
followed the call, and never set `statedMarketCapUsd` or anything else numeric.
Further guards: no links, nothing over 160 characters, no media-only messages, and an
explicit reply must resolve to *this* call — a reply to anything else is about
something else, however close in time. If two calls land inside one window the
chatter attaches to neither. The closest two calls in the dump are 22 minutes apart,
so this has never fired on real data; it costs nothing to be right about it.

**Every message is recorded in `SeenMessage`, whatever we decide about it.** Reply
chains are the main way a milestone finds its call — 28 of 31 in the public channel —
and they routinely pass through messages we ignore: "3x" (1240) replies to a photo
(1237) that replies to the call (1234). The first version stored only messages it
acted on, the chain dead-ended at the photo, and the milestone attached to nothing.
The integration test caught it. One small row per message is the price.

**An unattributable milestone is kept with `callId = NULL`, not dropped.** It is
recorded as `UNCLASSIFIED` with its raw text. A parent we cannot identify today may
become identifiable — the test "a milestone arriving before its call attaches on the
replay" does exactly that. What we never do is guess one.

**Replaying a call's own message must not demote it.** Found by feeding a batch twice:
the second pass saw that the call already existed and rewrote its `FIRST_CALL` event as
a `REPOST`. The call's own message is now recognised by id and re-asserted as
`FIRST_CALL`. This is the kind of bug that only a replay test finds, which is the
argument for the test.

**The ingest path is built around round trips, because they were the bottleneck.**
Measured from a laptop against the dev branch: a round trip is ~245ms and a Prisma
`upsert` ~2.5s, because it runs a transaction. The first version did an upsert and
several point reads per message, and backfilled at 0.31 messages per second — over
ten minutes for 200 messages, and a catch-up after an hour's outage would have kept
the listener deaf for half an hour. Now each channel's state is read once into memory
(three queries), `SeenMessage` is inserted for a whole batch in one `createMany` with
`skipDuplicates`, and a row is written only when something changes. Re-processing an
unchanged message writes nothing. No interactive transactions anywhere on this path:
their 5s default timeout is shorter than a Neon cold start.

**Neon's wake-up is survived, not assumed away.** After an idle spell the first
connection takes ~5s and succeeds; new connections opened in the next few seconds fail
with P1001, because Prisma's connect timeout is 5s. So "is the database up?" is
answered by four parallel `select 1`s, not one — the ingest path fans out to three.
And connection-level errors on the ingest path are retried with backoff. That is only
safe because processing is idempotent and the in-memory state is updated *after* each
write succeeds, never before. Non-transient errors — constraint violations, bad
queries — are not retried: retrying a bug only hides it.

**Health watches the polling clock, not the message clock.** A channel can be silent
for a day; that is `lastSeenAt` and it is allowed to be old. A dead socket is
`lastPolledAt` and the worker heartbeat going stale, and those must not be. `/health`
returns 503 past 180 seconds (six missed beats — long enough to ride out a cold start
plus a reconnect). A check that watched `lastSeenAt` would page on a quiet Sunday and
stay silent on a dead listener, which is exactly backwards.

*Corrected when deploying:* this entry originally said Railway restarts a container
whose health check fails. It does not. Railway's docs are explicit that it checks
`/health` only during a deploy, to decide whether the deploy succeeded, and "does not
monitor the healthcheck endpoint after the deployment has gone live." The ongoing guard
is now a watchdog inside the worker — see the Phase 7 entries below.

**A polling loop runs under the live socket.** Every 60s the worker re-reads the
channel list and catches up each channel from its cursor. It is redundant when the
socket works. It is the whole point when the socket silently stops delivering —
which is the failure this phase is about, and which the socket itself cannot report.

**The cursor advances only after the rows land.** A crash between processing and
advancing replays the message, which is harmless. A crash the other way round would
lose it. A live message that throws is recorded on the heartbeat and does *not*
advance the cursor, so the next poll picks it up.

**Backfilled calls are `source = BACKFILL`, with `calledAtMarketCapUsd` null and
`marketCapIsBackfilled` true.** We were not there when they were called. Phase 2
reconstructs the number from OHLCV; until then it is honestly absent.

**The worker refuses to start against the production branch.** It checks
`NEON_BRANCH` and exits. Test rows and half-finished backfills do not belong in the
public record, and the public record is the product.

## Phase 7 (worker only) — brought forward

**The worker is deployed to Railway now, ahead of Phase 7, because the live-path
question needs days of uptime and a laptop cannot provide it.** Measured on the laptop
over 14 minutes: three real messages arrived, all three were delivered by the 60s poll
and none by the live handler, and GramJS lost its Telegram connection repeatedly (three
update-loop `TIMEOUT`s, and a keep-alive warning every ~20 seconds). That cannot tell a
broken live handler from a broken network. A server can. The web app stays local;
only the worker moves.

**Liveness lives in process memory; the database is touched only when a message
arrives.** The first version wrote a heartbeat row every 30s and `lastPolledAt` every
60s, which keeps Neon's compute from ever reaching its idle threshold and spends the
free tier's compute hours proving the worker is alive. Both are gone from the schema.
Measured afterwards, locally: `dbQueries` held at exactly 20 for seven minutes of
polling three channels, and Neon's dev compute went from active to idle and stayed idle
while the worker kept polling Telegram. The open Prisma connection does not keep Neon
awake; only queries do. `/health` reports `dbQueries` so this stays checkable.

**The channel list is read at startup, not polled.** Re-reading it every minute was a
query every minute. Adding or pausing a channel is still configuration, not code — an
insert (or `seed:channels`) — but it now takes effect on the next restart rather than
within a minute. That is the price of letting the database sleep.

**Every message records which path delivered it, and how late.** `SeenMessage.ingestPath`
is LIVE, POLL, CATCHUP or BACKFILL; `receivedAt` is when it reached our code, and
`processedAt` when it was written. So receivedLag (Telegram → us) and writeLag (Telegram
→ row, including any Neon cold start) are separate numbers. A POLL row is a message the
live path missed or delivered late. The poll stays at 60s deliberately: a fast poll
would do the live path's job and hide a dead handler, which is what is being measured.

**The poll re-reads 50 message ids below its cursor.** Found while moving liveness into
memory: the cursor is "highest id processed", so if the live path missed 1302 but
delivered 1303, the cursor jumped past 1302 and the poll — which only asked for newer
messages — would never fetch it. A message silently lost, exactly the failure this
product cannot afford, and one the old design could not even have counted. Channel
message ids are sequential, so a fixed id window recovers any gap the live path leaves
between polls. Live and poll share a per-channel lock and a seen-set, so a message is
processed exactly once and credited to whichever path got there first.

**Observation channels write nothing to the database.** @MemesDontLies is added as
`role = OBSERVE`: measured for live-vs-poll and latency, never stored. Its calls cannot
reach the track record because they never reach the database — by construction, not
by a filter Phase 6 has to remember. This goes slightly beyond "stored but excluded",
for a measured reason: it is a bot channel posting ~430 messages a day, one every ~3.4
minutes, which is inside Neon's idle window — persisting its messages would keep the
database awake around the clock and undo the change above. Its measurements live in
memory and in the worker's periodic `[stats]` log line. It also does not backfill.
Worth noting for later: under the existing classifier both of its message shapes read
as scanner cards, so as a TRACK channel it would produce zero calls; tracking it would
need a third `ChannelKind`.

**Railway watches `/health` only during a deploy, so the worker watches itself.** If any
channel's poll has not succeeded for 10 minutes, or the event loop stops ticking, the
process logs why and exits; Railway's `restartPolicyType: ALWAYS` restarts it. `ALWAYS`
rather than `ON_FAILURE`, whose retry cap would leave the worker dead after a long
enough Telegram outage. `/health` itself reads memory only — a check that queried Neon
would keep it awake and report "unhealthy" whenever it slept, which is its normal state.

**A deploy cannot be failed by a backfill, and cannot double-run the Telegram
session.** `/health` returns 200 while the process is connecting and catching up; poll
freshness only counts once it is live, and the health-check timeout is 600s. On a
redeploy Railway starts the new container before stopping the old one — and two
processes on one Telegram session is how a session gets revoked. So the new process
answers `/health` immediately (letting Railway stop the old one, with
`overlapSeconds: 0`), then waits `STARTUP_DELAY_MS` (20s on Railway) before connecting to
Telegram. The same rule binds people: **never run `tg:login`, `tg:channels`, `tg:dump` or
a local worker while the Railway worker is up.**

**Secrets are redacted from every log line, and that was tested, not assumed.** Every
console method is wrapped to scrub `TG_SESSION`, `TG_API_HASH`, both database URLs, and a
database password on its own; uncaught exceptions are routed through it too, since Node
prints those around `console`. Tested by running the real worker down two error paths
with canary secrets (a wrong database password; a garbage Telegram session): no canary
and no real secret appeared in the output. Found on the way: Neon reports a wrong
password exactly as it reports a network failure — "Can't reach database server", no
error code — so the startup error now names both possibilities instead of claiming an
outage.

**Railway region is us-east4, beside the database.** Neon is in us-east-2 (Ohio). The
Telegram account's home data centre is DC4 (Amsterdam), so each push crosses the
Atlantic — tens of milliseconds, against lags measured in seconds. A message costs
several database round trips and one Telegram delivery, so the database wins.

## Phase 2 — market data

**The called-at market cap is captured on the ingest path, not on a sweep.** The
listener hands every newly created Call to a capture queue the moment the row exists.
The first attempt is immediate; retries run off the ingest path, because a token that
is not indexed yet can take minutes and the channel lock must not be held for minutes.

**`marketCapObservedAt` is stored beside it, always.** Ingest is fast — 0.64s median on
the live path — but a price lookup is not, and DexScreener may serve a cached figure.
The record therefore states when the observation behind the number was taken. An entry
price with no timestamp cannot be checked by anyone, which makes it worthless as
evidence. `marketCapSource` says exactly how it was obtained, in prose, because a
boolean cannot express "the open of the 1-minute candle 5 seconds before the call".

**The number can only be written once, and the database enforces it.** Every write is
`updateMany({ where: { id, calledAtMarketCapUsd: null } })`. A second attempt updates
zero rows rather than relying on everyone remembering rule 3. Tested.

**A call we did not witness is never "captured".** Anything older than 10 minutes when
we first see it — backfilled history, or a catch-up after downtime — goes to
reconstruction instead, flagged. A current price is not a called-at price.

**A null market cap is a recorded outcome, not an absence.** After a bounded retry
window (~8.5 minutes) the call keeps a null and gains a `marketCapNullReason`. A guess
would be worse than a null, and an unexplained null invites someone to fill it in later.

**The specific chain is resolved and stored separately from the address format.**
`Token.chain` (SOLANA | EVM) is what the address string proves. `Token.dexChainId` is
what a metadata lookup found: our five EVM tokens live on three different chains —
`bsc`, `hyperevm` and `robinhood` — and no amount of staring at the address reveals
which. Keeping both means never confusing a fact with a third party's claim.

**Polling happens in memory; the database is written on a slow cadence.** Cadence by
age: 30s for the first hour, then 2min, 10min, hourly, 6-hourly. A snapshot per token
per poll would be ten times the write rate of the heartbeat we deliberately removed —
any write keeps Neon awake at least five minutes. So observations are held in memory
and flushed every 15 minutes, and only for tokens where something happened: a new peak
above 1%, or a death. One flush is one round trip for every pending token.

**DexScreener's batch endpoint is what makes that affordable.** Measured: 30 addresses
in one request, one pair returned per token. Every token we track costs two or three
HTTP requests per poll, not fifty.

**The DexScreener rate limit used here is chosen, not quoted.** Their docs publish
"60 requests per minute" for the profile and trending endpoints, but the limits for the
price endpoints are rendered client-side and could not be read from the page; the
responses carry no rate-limit headers either (checked). So the client serialises to one
request every 2 seconds — below the lowest number they publish for anything.
GeckoTerminal does publish its free limit, 10 calls per minute, and its client is
spaced to 7 seconds accordingly.

**A timeout is not a verdict.** The first reconstruction run recorded four of five
calls as permanently null — "chain unknown", "no pool" — and every one of those was a
10-second network timeout on this laptop, not a fact about the token. With retries all
five reconstructed. Both HTTP clients now retry transient failures, and the
reconstruction script distinguishes "the lookup failed, retry" from "there is no such
pool", because the second is written into the record and the first must not be.

**Reconstruction uses the candle OPEN, and says which resolution it used.**
GeckoTerminal keeps minute candles only for recent history, so older calls fall back to
hour and then day candles. Open rather than close: it is the price at the start of the
minute the call landed in, so it cannot include a pump the call itself caused. Market
cap is not in the OHLCV feed, so supply is implied from a current observation as
fdv / price and multiplied by the historical price — sound for a memecoin whose supply
is fixed after launch, but an assumption, and one written into `marketCapSource` rather
than left for someone to rediscover.

**Dead needs two strikes.** Liquidity under $500, market cap under $1,000, or no volume
in 24 hours once the token is over an hour old. A rug and an API blip look identical
once; they stop looking identical when the same verdict repeats on the next poll.
Missing liquidity is NOT pulled liquidity — DexScreener returns null liquidity for some
healthy pairs, measured on one of our own tokens, and treating that as a rug would close
live calls. A closed call stops being polled but stays in the database and on the board,
per rule 5.
