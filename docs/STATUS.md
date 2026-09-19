# Status

Update this whenever a phase completes. It is how progress is tracked without
reading diffs.

| Phase | What | State |
|---|---|---|
| 0 | Read both channels, write classifier from real messages | **DONE** |
| 1 | Ingestion — listener, channels table, call/event model, backfill | Not started |
| 2 | Market data — DexScreener polling, mcap capture, dead detection | Not started |
| 3 | Narrative — socials -> 2-3 sentences, generated once | Not started |
| 4 | Auth + feed — Privy email login, live feed | Not started |
| 5 | Journal — log a play, entry-vs-call multiple | Not started |
| 6 | Public track record + landing page | Not started |
| 7 | Deploy and harden | Not started |

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
4. **New.** `<private-channel>` posts the caller's opinion as a separate message seconds
   after the bare address ("gamble", "Got in 14k", "Look for entry"). Stitching
   those onto the call is a Phase 1 ingest decision — what time window, and what
   happens when two calls land a minute apart.
