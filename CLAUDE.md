# AlphaDes — instructions for Claude Code

Read this before touching anything. Then read `docs/BUILD_PLAN.md` for the phases
and `docs/DECISIONS.md` for what has already been settled and why.

## What this is

A web app that watches Telegram memecoin call channels, surfaces every call the
moment it lands **with the token's story attached**, tracks what each call actually
did, and lets a trader keep a private journal against it.

**What it is not:** a tracking bot. Both channels already run one — that is what
their "we hit 3x" image cards are. AlphaDes adds the narrative, the journal, the
honest public record, and a web surface. Keep that distinction in mind when
choosing what to build; anything that just re-implements their bot is wasted work.

## Architecture, and the one hard constraint

```
apps/web      Next.js         -> Vercel
apps/worker   long-running    -> Railway or Fly.io   <- CANNOT go on Vercel
packages/db   Prisma schema + client, shared by both
```

**The worker cannot run on Vercel.** It holds a persistent Telegram connection and
must never sleep. Serverless is neither. Two hosts, one database, ~$5/month. Do not
try to make the listener work as a serverless function or a cron — it will look like
it works and then silently miss calls.

## Rules that are not negotiable

1. **Channels are configuration, not code.** They live in the `Channel` table. The
   worker reads them on start and reloads on change. Adding the second channel is an
   INSERT, never a deploy. Never hardcode a channel id or handle anywhere.

2. **First sighting creates a Call. Every later sighting is a CallEvent.** A re-post
   or a milestone card for a token we already track must never create a second Call.
   The `@@unique([tokenId, channelId])` constraint enforces this — respect it rather
   than working around it.

3. **Capture market cap at the moment of ingestion.** `Call.calledAtMarketCapUsd` is
   the one number that cannot be reconstructed later, and every multiple on the site
   derives from it. For backfilled history it is rebuilt from GeckoTerminal OHLCV and
   MUST be flagged `marketCapIsBackfilled = true`. Never silently mix measured and
   reconstructed numbers.

4. **Narratives are generated once and cached forever.** The narrative records what
   was claimed *at call time*. Never regenerate. Always label it as sourced from the
   project's own socials — it is context, not our analysis of a token we vetted.

5. **Dead calls stay visible.** A feed that quietly drops its losers is the pattern
   every scam tool uses. Rugged and faded calls stay on the board with the reason.
   The honest summary row is the credibility of this product.

6. **The journal is private.** Per-user, never public, never aggregated into public
   stats without an explicit decision.

7. **Never commit secrets.** `.env` only. `TG_SESSION` is full access to a personal
   Telegram account — it is the most dangerous string in this repo.

8. **Ambiguity is dropped, not guessed.** If a message's contract address is unclear,
   ignore the message. A missed call costs nothing. A wrong call poisons the record.

## Extraction

Solana CAs are base58, 32–44 chars (`src/lib/solana.ts`). Transaction signatures are
87–88 chars and will not collide. Base58 excludes `0`, `O`, `I`, `l`.

Calls arrive as **text containing a CA**. The image cards are milestone updates on
calls already made. So extraction is regex, not OCR.

## Working agreement

- Small commits, one concern each. Conventional commit messages.
- `npm run typecheck` must pass before you say something is done.
- When a phase is finished, update `docs/STATUS.md` — that file is how the human
  tracks progress without reading diffs.
- If you hit a decision the plan does not cover, write it into `docs/DECISIONS.md`
  with the reasoning, do not just pick silently.
- Do not claim something works because the code looks right. Say what you actually
  ran and what it printed.

## Current state

Day 0 has not been completed. **Nothing in Phase 1 should be written until the
channel dumps exist in `data/dumps/` and the classifier has been written from real
messages rather than guesses.** That is the gate. See `docs/STATUS.md`.
