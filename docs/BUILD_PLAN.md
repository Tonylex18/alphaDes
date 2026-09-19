# AlphaDes — build plan

**Product:** a web app that watches two Telegram call channels, surfaces every call the moment it lands with the token's story attached, tracks what each call actually did, and lets a trader keep a journal against it.

**Channels tracked at launch**
- `@AlphaDesJurix`
- "`<private-channel>`" — 327 subscribers — **@handle still needed** (More → username, or forward a message and read the source)

**Start:** 17 September 2026

---

## Day 0 — read the channels before writing product code

Calls arrive as **text containing a contract address**; the generated image cards are milestone updates on calls already made ("we hit 2x", "we hit 3x"). So extraction is a regex, not OCR — the main risk is gone.

Two hours of groundwork, still worth doing:

1. **Read both channels programmatically.** A Telegram *user* client (Telethon or GramJS with your own account) can read any channel you can see. A *bot* cannot, unless it's added as an admin. Assume the user-client route.
2. **Dump 50 recent messages from each channel** and write down the shapes you see — how a call is phrased, how a milestone post is phrased, what else gets posted (chatter, announcements, replies).
3. **Write the classifier from real examples, not from guesses.** Three outcomes per message:
   - **New call** — a CA never seen before
   - **Update** — a CA already tracked; attach as an event to that call
   - **Ignore** — everything else

Base58, 32–44 characters, is the Solana CA shape; transaction signatures are 87–88 and won't collide. Anything ambiguous is better dropped than wrongly promoted to a call.

**One question worth answering the same day:** those milestone cards mean the channels already run a tracking bot. So AlphaDes isn't adding tracking — it's adding *the story, the journal, and a web surface*. Worth being clear about that before you spend three weeks, because it changes the pitch and it changes who the customer is.

---

## Phase 1 — Ingestion · 2.5 days (17–19 Sep)

- Long-running Telegram listener
- **Channels are configuration, not code**: a `channels` table with handle, display name, active flag. The worker reads the list on start and reloads on change. Adding the second channel is then an insert, not a deploy — paste the handle and it's live. Same mechanism lets you pause a channel or add a third later.
- Extract CA → normalise → **first sighting creates a call; every later sighting attaches to it as an event.** That gives you the channel's own milestone claims for free, next to your measured numbers.
- Store the raw message, timestamp, channel and extracted CA on every event
- Reconnect and catch up on drop — a listener that silently dies is the worst failure this product has

**Backfill on channel add.** When a channel is switched on, read its recent history, extract past calls, and reconstruct called-at market cap and peak from **GeckoTerminal's free OHLCV** endpoint (historical candles by pool). Without this the public track record is empty for a fortnight after launch; with it you launch with a record. Half a day, and it's the difference between proof and a promise.

**Done when:** a call posted in either channel appears as a row within seconds, a milestone post attaches to the existing call rather than creating a new one, and adding a channel by handle backfills its history.

## Phase 2 — Market data · 1.5 days (18–19 Sep)

- DexScreener for token metadata, market cap, price, liquidity (free, no key)
- **Capture the market cap at the moment of ingestion.** This is the one number that cannot be reconstructed later, and every multiple on the site is derived from it.
- Polling loop per tracked token: current mcap, all-time high since call, **highest X**, **latest X**, **time to peak**
- Poll fast while young (every 30s for the first hour), back off with age
- Dead detection: liquidity pulled, volume at zero, price below a floor → mark closed with a reason

**Done when:** a call's card shows correct highest/latest X against the chart, and a rugged token flips to closed by itself.

## Phase 3 — The story · 1 day (20 Sep)

- Read the token's own socials (X handle, website, Telegram) from DexScreener metadata
- Summarise into 2–3 sentences with an LLM — what it is, where the joke came from
- **Generate once, cache forever.** Never regenerate; the narrative is a record of what was claimed at call time.
- Label it on the card as sourced from the project's own socials

**Done when:** a new call has a readable story within a minute of landing, and it never silently changes afterwards.

## Phase 4 — Auth and the feed · 2.5 days (21–23 Sep)

- Privy email login — one field, no password; provisions the embedded wallet in the background for later
- Feed page: the three-column layout, cards live-updating
- Gate the live feed behind login

**Done when:** you can sign in on a phone and watch a real call arrive.

## Phase 5 — Journal · 1.5 days (23–24 Sep)

- Log a play against a call: entry mcap, size, notes
- Auto-compute **entry vs call** ("you entered at 2.2x the call")
- Open/closed, result, post-mortem note
- Per-user, private

**Done when:** you can log a real trade and the entry-vs-call number is right.

## Phase 6 — Public track record and landing page · 1.5 days (25–26 Sep)

- Public board: every call, winners and losers, with the honest summary row
- Landing page — seven sections, per the layout we settled
- One primary CTA: *See live calls*

**Done when:** a stranger can judge the channels without signing up.

## Phase 7 — Deploy and harden · 1 day (27 Sep)

See hosting below. Plus: error handling on the listener, a health endpoint, and a way to know when ingestion has stopped.

---

## Hosting — the one architectural gotcha

**The Telegram listener cannot run on Vercel.** It needs a persistent connection and a process that never sleeps; serverless functions are neither. You need two hosts:

| Piece | Where | Cost |
|---|---|---|
| Web app (Next.js) | Vercel | Free (Hobby) |
| **Ingestion + price worker** | **Railway or Fly.io** — a always-on container | ~$5/month |
| Database | Neon Postgres | Free tier |
| Auth | Privy | Free tier |
| Market data | DexScreener API | Free |
| Story generation | LLM API | Pennies at this volume |
| Domain | Namecheap | ~$10/year |

**Running cost: roughly $5–10 a month.**

The worker writes to Neon; the web app reads from it. They share the schema and nothing else. Keep the worker in the same repo, deployed separately.

One Neon caution you already know from Arcway: the free tier scales to zero, and a cold start costs 20–30 seconds. A worker polling every 30 seconds keeps it warm for free — but don't let a cold branch be the reason a call arrives late.

---

## Timeline

**11.5 working days · 17–28 September.**

Adjust honestly for what else is on:
- X-Agent reviewers are live 20 Sep – 1 Oct, so expect interruptions
- micro1 tasks are 9 hours each — every task you take is a day this slips

**Realistic landing: first full week of October.** Calling it 27 September only works if AlphaDes is the only thing you're doing, and it isn't.

---

## Explicitly not in v1

- **In-app buying.** Redirect to GMGN or Axiom. Build it after the feed proves people want it, and build it browser-signed — the app never holds a key.
- **Charts in the app.** Redirect for charts. Embedding is a week you don't have.
- **"What people are saying on X."** The X API's usable tier is a few hundred dollars a month. The token's own socials are free and enough to start.
- **More than two channels.** Prove it with these two.
- **Payments.** Free while you find out whether anyone comes back twice.

---

## Open questions

1. What's the second channel's @handle? (Not blocking — channels are configuration, so it's an insert whenever you have it.)
2. Does the channel owner know you're building this, and does that matter to you? It changes whether this is a product you sell to them or one you run yourself.
3. Both channels already run a tracking bot. What's your answer when someone asks what AlphaDes does that the bot doesn't?
4. Solana only, or will calls span chains?
