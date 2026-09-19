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
