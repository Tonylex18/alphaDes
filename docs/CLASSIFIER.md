# Classifier

Written from the Day 0 dumps in `data/dumps/` — 200 messages from each channel,
read in full before any of this code existed. Every message id below is real and
can be looked up in the dump.

The dumps are gitignored: they are other people's channel content, and one of the
two channels is private. Re-create them with:

```bash
npm run tg:dump -- @AlphaDesJurix --limit 200
npm run tg:dump -- <private-channel-id> --as private-channel --limit 200
```

The tests skip, loudly, when they are absent.

## Why there are two rule sets

The two channels do not share a message shape. Nothing about the way `<private-channel>`
posts a call would find a single call in AlphaDesJurix, and vice versa.

| | `<private-channel>` | AlphaDesJurix |
|---|---|---|
| Identity | private, no handle | public, `@AlphaDesJurix` |
| `Channel.kind` | `BARE_CA` | `NARRATIVE` |
| Volume in the dump | 200 messages / 10 days | 200 messages / 41 days |
| A call looks like | the contract address, alone | prose wrapped around an address |
| Commentary | separate messages, seconds later | same message |
| Scanner cards | none | 23 of 200 |

The rule set is chosen from `Channel.kind`, a column on the `Channel` table. No
code anywhere branches on a channel id or a handle. Adding a third channel is an
insert; adding a third *shape* is a new enum value plus a branch in
`classify.ts`, and nothing else.

**Channels are referred to here by placeholder.** The real Telegram ids are not
in this repository: they live in `.env` and, once the worker runs, in rows of the
`Channel` table — channels are configuration, not code, per `CLAUDE.md`. One of
the two is a private channel, and its id is not ours to publish. The public one
is named by its handle because that is already public. The local dump for the
private channel is written as `dump_private-channel.json`, via
`npm run tg:dump -- <its-id> --as private-channel`, so that its id does not end
up hardcoded in a committed fixture either.

## Shapes: `<private-channel>` (`BARE_CA`)

**A call is the address and nothing else.** It is the entire first line of the
message. 26 of the 200 messages are calls.

```
1084   8iYPW781jBDu8zkC6PFY8WpvtbHxSVMgBX8aPnNmRY3z
1279   0x8fb94c4a78b487c64ec2eb0f2559415f8e203d45
```

Two calls carry a short trailing thought on later lines. They are still calls,
because the address still owns the first line:

```
1205   Dsupo4V1jzpmG3SFvmZE9c35a4W2UaX5ENw9frQY4rdD
       Saving this here
       Having a tingling
```

**The caller's opinion arrives as its own message, seconds later** — 1243
"gamble", 1281 "Look for entry", 1272 "Should cook". Attaching those to the call
means stitching adjacent messages by timestamp, which is an ingest decision, not
a classifier one. It is why `statedMarketCapUsd` is almost always null for this
channel even though 1115 says "Got in 14k" thirty seconds after call 1114.

**Milestones are a multiple, at the start, in a short message:** 1240 "3x", 1174
"2x 💆🏽‍♂️", 1194 "115x btw 🦅💧", 1220 "2x\n\nMore biko". `<private-channel>` also states
progress as a cap range — 1121 "14k to 53k", 1130 "9k to 500k btw 😘", 1142 "9k
to 2.5m" — and those count too.

The "at the start" requirement is what separates a milestone from chat about
multiples, of which there is plenty: 1213 "Its good to take profit after a 2x",
1214 "should in case it does 100x😂", 1256 "Sendor i need a 10x".

**Everything else is noise, and most of it is:** 164 of 200. X links, GM posts,
airdrop shilling, an NFT watchlist, Google Meet class links, and a great many
media-only messages with no text at all.

### The one that would have hurt

Message 1200 pitches a testnet trading tournament and, six paragraphs in, says
"You can trade my token: 0xb997ce3e5ac629fb65b6517bd286860c299f69d2". Under
"message contains an address" that is a call, and a testnet token would have gone
onto the public board. Requiring the address to own the first line drops it.

## Shapes: AlphaDesJurix (`NARRATIVE`)

**Zero bare addresses.** 23 of the 200 messages are calls, and every one of them
is prose:

```
7676   Aped $ROMANSTORM. Rn at 87k MC.
       Roman Storm is the CoFounder of tornado cash, the privacy protocol, and
       was arrested on August 23, 2023
       ...
       FkZL1HP8EqZStvyx5myGw7SW2SiCyWbWQVhMNrhjAh8E
```

The call verbs vary — "Aped" (15), "Entry", "In this", "Keep an eye on this",
"I aped smol", "took a bet" — and two calls name no ticker at all (7469 "Aped.
62k entry.", 7562 "…this is the OG sitting at 10k MC."). What every one of them
has is either a first-person intent verb or the risk boilerplate the caller
attaches to their own calls ("NFA, DYOR!"). That conjunction is the test. An
address alone is not enough, because addresses also appear in follow-ups, quotes
and links.

**Scanner cards are a third party's bot, and there are 23 of them.** They are not
one format. The dump contains at least six:

```
7677   💊 Roman Storm Coin [147K/274%] $ROMANSTORM | 🌐 Solana @ Pump | 💎 FDV: 147K …
7645   ☄️ BABY EMBER [56.9K/38%] $BABYEMBER/MET | 💎 FDV: 56.9K ⇨ 66.2K [2m] …
7642   ⚡️ BABYEMBER — #MIGRATED!  ├ 41.4K • Age: 20h, 11m  └ <scanner-user-1> @ 23.2K
7565   🔥 moonkey [5.3x]  ├ <scanner-user-1>  └ 10K → 52.4K (5h)
7626   🆕 | DEGS BUY! | by @MajorBuyBot … 📈 MCap: $1,615,531
7498   🕊 $WW New ATH! | 💰 $810.8K | Trench Track ™️
```

Detection does not key on the leading emoji, which changes. It keys on
signatures no human in either channel types — `#MIGRATED`, `#DEXPAID`, `FDV:`,
`MCap:`, `Trench Track`, `BuyBot` — on box-drawing tree characters (`├` `└`),
or on three or more of the card's field labels appearing together.

**A card's address and ticker are trusted. Its numbers are not.** The first
`xN` in a card is as likely to be liquidity as price: 7481 says `Liq: 22.3K
[x13]` and 7570 says `[x10]`. So `SCANNER_CARD` never reports a claimed
multiple. Its value is that it confirms a token's identity and, in a reply
chain, anchors a milestone to the right call.

**Milestones reference the ticker, not the address:** 7631 "X2 smashed on
$BOXCAT. ✅", 7657 "18x on $biketyson.", 7663 "$SPOONAI is up 2x from call.✅",
7604 "4x done.✅ 11k. New ATH." A multiple at the start of the message is enough;
a multiple anywhere else needs a cue word — `smashed`, `done`, `so far`,
`from call`, `✅`, `now!`, `ATH`. Without that cue, 7467 "$TOAD pumping crazy.
200x within few hrs. Missed." and 7578 "If this goes as planned, 10-15x+ from
here" would both be milestones, and neither is.

A message claiming a new ATH with a figure attached is also a milestone —
7630 "370k ATH. Send it!!", 7476 "62% profit on this. Hit 100k ATH."

## Addresses

Two chains, because Solana-only was wrong. The dumps contain six EVM addresses
and the original base58 regex saw none of them.

- **Solana**: base58, and **decoded**, not pattern-matched. The 32–44 character
  window is necessary but not sufficient — `1111111111111111111111111111111`
  decodes to 31 bytes and a 44-character run of `z` decodes to 33. Only a string
  that decodes to exactly 32 bytes is an address. (On these 400 messages the
  decode check rejects nothing the regex accepted: 60 matches, 60 valid. It is
  there for the messages we have not seen yet.)
- **EVM**: `0x` + 40 hex. Which EVM chain is not knowable from the address —
  7520 is BNB and 7550 is HyperEVM, and they look identical. `Token.chain` is
  therefore `SOLANA` or `EVM`, and narrowing it needs a metadata lookup in
  Phase 2. Comparison is case-insensitive, since the mixed case is an EIP-55
  checksum.
- **URLs are blanked before scanning.** 7667 links
  `coinboom.net/solana/A7762oSx…` as a follow-up to a call made an hour earlier
  at 7666. Counting the address in that link would have produced a duplicate.

## Stated market cap is a claim, not a measurement

"Rn at 87k MC" parses to `87000` and is stored on `Call.statedMarketCapUsd`. It
never touches `calledAtMarketCapUsd`, which is ours and measured at ingestion.
The two are not averaged, reconciled or merged. When they disagree, both are
shown — that disagreement is information.

The parse is ordered, because a call routinely quotes two figures:

- 7640 "EMBER currently at 11m. So, $BABYEMBER is a good beta. Entry 22k MC." →
  **22000**, not 11m. A figure glued to "MC" outranks one after a preposition.
- 7562 "The PvP Moonkey at 1.2M. But this is the OG sitting at 10k MC." →
  **10000**.
- 7614 "ATH was 600k and still under the radar." → **null**. A bare "at
  `<amount>`" is deliberately not a cue; a level the token already left is not an
  entry.

15 of the 23 calls state a cap. The other 8 give none, and null is the right
answer for them.

## The caller's own words become the narrative

When a `NARRATIVE` call carries prose, it is saved as the `Narrative` with
`sourceNote` "The caller's own words at call time". 9 of the 23 calls do: 7480,
7486, 7562, 7577, 7614, 7634, 7647, 7660, 7676. The address lines and the "NFA,
DYOR!" boilerplate are stripped; what is left must be at least 80 characters,
because "Aped $JAS. A utility project on Sol." is a sentence, not a story.

This changes Phase 3. The plan was to generate every narrative from the token's
socials. Instead: **generate only where the channel gave us nothing.** What the
caller actually wrote at call time is better evidence than a summary of a
website, and it is free. The existing rule still holds — generated once, never
regenerated — and the `sourceNote` on the card must say which of the two it is.

## Linking a milestone to its call

In priority order, and it stops rather than guessing:

1. **`replyTo`**, walking the chain up to 8 hops. A reply often points at
   another milestone rather than at the call: 1240 → 1237 → the call at 1234;
   1121 → 1119 → the call at 1114. Scanner cards anchor the chain too, so a
   "X2 done" replying to a card still reaches the call.
2. **An address we have already seen** in this channel.
3. **A ticker** seen in this channel. If two live calls share a ticker it
   resolves to nothing rather than to a coin flip.

If none of the three resolve, the event is `UNCLASSIFIED` and attaches to
nothing. Replayed over the dumps:

```
<private-channel>      26 calls, 10 milestones -> reply 5,  ticker 0,  unattached 5
AlphaDesJurix   22 calls, 31 milestones -> reply 28, ticker 1,  unattached 2
```

The five unattached in `<private-channel>` are bare "3x" / "5x" / "9k to 2.5m" messages
posted with no reply, no address and no ticker. There is genuinely nothing in
them that identifies a token. The two in AlphaDesJurix are 7657 (a boast about
`$biketyson`, which was called on the caller's X account and never in this
channel) and 7678 "X2. Who's in?", which follows a `$ROMANSTORM` card but says
so only by adjacency. Attaching either would be a guess.

Note the call counts: AlphaDesJurix has 23 call-shaped messages but 22 calls.
7598 re-posts the `$CAOPAN` address first called at 7577. The classifier is
stateless and says `NEW_CALL` for both; `@@unique([tokenId, channelId])` makes
the second one an event. First sighting is a database question and it stays in
the ingest layer.

## Measured, not asserted

`npm test` replays both dumps and prints precision and recall per category
against `src/ingest/fixtures/labels.ts` — 113 hand-checked labels across 400
messages. Anything not labelled is expected to be `NOISE`, which makes the same
file a precision test and a recall test.

The known gaps are listed in that file as `knownMisses` and asserted to stay
`NOISE`, so that a change in behaviour shows up as a failing test rather than as
a surprise. They are: 1136 "800k +", 1115 "Got in 14k", 1244 "Send is at 600k mc
now", 7475 "$KADU reversing nicely from 33k dip. 85k now!", 7499 "ATH." with no
figure, 7644 "50k!.", and 7655, a retrospective boast about a call made
off-channel.

A missed call costs nothing. A wrong call poisons the record.
