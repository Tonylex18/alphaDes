# AlphaDes

Watches Telegram call channels, surfaces every call with the token's story attached,
tracks what each call actually did, and lets you keep a journal against it.

## Layout

```
apps/web      Next.js          -> Vercel
apps/worker   ingestion+prices -> Railway / Fly.io (must never sleep)
packages/db   Prisma schema shared by both
docs/         plan, decisions, status
```

## Setup

```bash
npm install
cp .env.example .env          # then fill it in — see below
npm run db:generate
npm run db:push
npm run seed:channels         # CHANNEL_<n>_* from .env -> Channel rows
npm run dev:worker            # catch up, then listen. Refuses the production branch.
```

The worker serves `GET /health` on `$PORT` (default 8080): 200 while ingestion is
alive, 503 when the heartbeat or any channel's last poll is older than 180s. A
channel that is merely quiet stays healthy — see `docs/DECISIONS.md`.

Fill in `.env` yourself. Every value in it is yours, not shared:

- `TG_API_ID` / `TG_API_HASH` — create your own app at
  https://my.telegram.org/apps. These are tied to a Telegram account and are
  permanent; do not reuse anyone else's.
- `DATABASE_URL` / `DIRECT_URL` — your own Neon branch. Pooled and non-pooled
  hostnames of the same database; migrations need the non-pooled one.
- `TG_SESSION` — printed by `npm run tg:login` below. It is full access to the
  Telegram account that runs it. Treat it as a password. Never run two processes
  on the same session at once; Telegram may revoke it.
- `CHANNEL_<n>_ID` / `_KIND` / `_NAME` / `_USERNAME` — the channels to watch.
  Seeded into the database; the worker reads the table, never these values.

## Day 0 — do this before writing product code

```bash
npm run tg:login              # once; paste the session string into .env
npm run tg:channels           # find both channels, note ids
npm run tg:dump -- @AlphaDesJurix --limit 200
npm run tg:dump -- <private-channel-id> --as private-channel --limit 200
```

Then read `data/dumps/*.json` and write the classifier from what is actually
there. The dumps are gitignored: they are other people's channel content, and at
least one of the watched channels is private. Do not commit them, and do not
paste them anywhere.

`npm test` replays the dumps against the classifier and prints precision and
recall per category. It skips if the dumps are not present. See
`docs/CLASSIFIER.md`.

`docs/STATUS.md` tracks where we are. `CLAUDE.md` is the brief for Claude Code.
