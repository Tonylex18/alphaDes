# Status

Update this whenever a phase completes. It is how progress is tracked without
reading diffs.

| Phase | What | State |
|---|---|---|
| 0 | Read both channels, write classifier from real messages | **DONE** |
| 1 | Ingestion — listener, channels table, call/event model, backfill | **BUILT — live capture not yet observed** |
| 2 | Market data — DexScreener polling, mcap capture, dead detection | Not started |
| 3 | Narrative — socials -> 2-3 sentences, generated once | Not started |
| 4 | Auth + feed — Privy email login, live feed | Not started |
| 5 | Journal — log a play, entry-vs-call multiple | Not started |
| 6 | Public track record + landing page | Not started |
| 7 | Deploy and harden | **Worker deploy brought forward** — see below. Web deploy not started. |

## Phase 7, worker only — brought forward

Deployed ahead of schedule because **the live-path question needs days of uptime and a
laptop cannot provide it**: on the laptop, all three real messages arrived by poll and
none live, while the Telegram connection dropped repeatedly — the network and the handler
could not be told apart. The web app stays local.

Before deploying:
- [x] Liveness moved out of the database. Measured: `dbQueries` flat for 7 minutes of
      polling; Neon dev compute went idle and stayed idle.
- [x] Secrets redacted from all logs; tested with canary secrets on two error paths.
- [x] Every message records its path (LIVE / POLL / CATCHUP / BACKFILL) and lag.
- [x] Poll re-reads 50 ids below the cursor — a message missed live is no longer lost
      when a later one arrives live.
- [x] @MemesDontLies added as OBSERVE: measured, never written to the database.
- [ ] Railway deploy — pending account token
- [ ] 24-hour report: messages by path, median/worst lag per path, update-loop
      timeouts under real traffic, Neon compute hours consumed

## Phase 1 — what was actually observed

Built and run against the dev branch with both real channels. Being precise about
which parts were *seen* working and which were not:

**Observed**
- Backfill: 200 messages from each channel. 26 calls from the private channel
  and 22 from the public one, all `source = BACKFILL`, called-at market cap null.
  Every count matches the Day 0 predictions exactly: 26 + 22 calls, one re-post
  recorded as an event rather than a second call, 5 + 2 milestones left
  unattached rather than guessed, 26 commentary messages stitched.
- Kill and restart loses nothing — twice. An early run was killed at message 143
  of 200; the restart reused every row it had made and finished with zero
  duplicates. Then a deliberate `kill -9` mid-backfill, part-way through a
  chunk: the restart logged `resumed after #7517`, processed only the remaining
  150 messages, and the final state was identical to the pre-crash baseline row
  for row (22 calls, 69 events, 200 seen, 0 duplicate events, all BACKFILL).
- `/health` caught a real bug on its first outing — a false 503 during startup,
  which on Railway/Fly would have restarted the worker mid-backfill, forever.
  Fixed; now 200 with both channels polled every ~60s, while their newest
  messages are 6h and 26h old. Quiet is not dead, and the check knows it.
- Neon cold starts (7-15s) survived on every start.
- 22/22 tests pass, including feeding the same batch twice.

**Not yet observed**
- **A live message arriving.** Neither channel posted while the worker ran. The
  live handler shares its entire processing path with the backfill, which is
  heavily exercised; what is untested is the event wiring — `chatId` routing was
  checked against the GramJS source, not against a real message. Leave the worker
  running through a posting window and watch for a `[live]` line.
- A Telegram disconnect and reconnect. The 60s poll re-catches-up regardless,
  which is the safety net; `reconnects` on the heartbeat is still 0.

## Scaffold (not a phase — plumbing only)

- [x] Repo-root `.env` and `data/dumps/` resolved through `apps/worker/src/lib/paths.ts`,
      so npm workspaces' cwd no longer breaks env loading or dump writes.
- [x] `datasource db` has `directUrl`; `packages/db` scripts read the root .env via
      dotenv-cli. `npm run db:push` works.
- [x] Schema pushed to Neon: 8 tables + 3 enums, on both `production` and `dev`.
- [x] Neon CLI linked to project `plain-snow-12281755`, local context on branch `dev`.
- [ ] Neon MCP: installed, but the stored API key is rejected (401). Needs a fresh key.
- [ ] `neon skills`: blocked, needs Node >= 22.20.0 (this machine has 22.14.0).

## Day 0 checklist — complete

- [x] `npm run tg:login` — session string in `.env`
- [x] `npm run tg:channels` — @AlphaDesJurix is `<public-channel>`,
      "`<private-channel>`" is private, `<private-channel>`
- [x] `npm run tg:dump` — 200 messages from each channel in `data/dumps/`
- [x] Read both dumps. Shapes written up in `docs/CLASSIFIER.md` with real
      message ids.
- [x] Classifier written from those examples: NEW_CALL / MILESTONE /
      SCANNER_CARD / NOISE, in `apps/worker/src/ingest/`. 100% precision and
      recall against 113 hand-checked labels over 400 messages; `npm test`
      prints the table.
- [ ] Answered: what does AlphaDes do that the channels' existing bot doesn't?
      Partly. The dumps sharpened it: the bot posts cards, it does not keep a
      record. Neither channel can tell you what its own hit rate was last month,
      and `<private-channel>`' own claim ("still maintains a 30% hit rate", msg 1274) is
      unverifiable. Still open as a positioning question.

## Open questions

1. ~~"`<private-channel>`" — numeric id or @handle?~~ Private channel, numeric id
   `<private-channel>`, no handle.
2. Does the channel owner know this is being built? Changes whether this is a
   product you sell to them or one you run yourself. **Still open.**
3. ~~Solana only, or will calls span chains?~~ They span chains. Six EVM calls
   in 400 messages, across at least BNB and HyperEVM. `Token.chain` added.
4. ~~Stitching the private channel's separate commentary messages~~ Decided: a
   90-second window, measured from the dump, never writing a number. See
   DECISIONS.md.
