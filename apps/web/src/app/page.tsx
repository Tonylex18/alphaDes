/**
 * The public landing page.
 *
 * Statically generated and revalidated once a day, so a visitor never triggers
 * a database read. Every figure is a count of rows read at build time — nothing
 * is modelled or invented. See lib/landing-stats.ts for why there is no win
 * rate, median peak or time-to-peak figure yet.
 *
 * The copy sells the record, not returns. By our own data a third of these
 * calls are already dead; a page implying otherwise would make the honest
 * record underneath read as marketing.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { getLandingStats } from "../lib/landing-stats";

export const metadata: Metadata = {
  title: "AlphaDes — every call, kept honestly",
  description:
    "We record every call two Telegram channels make, the moment it lands: what the token is, what it was worth, and what happened next. Including the ones that went to zero.",
};

export const revalidate = 86400; // once a day, not once a visitor

const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K` : `$${n.toFixed(0)}`;

export default async function Landing() {
  const s = await getLandingStats();

  return (
    <main className="land">
      {/* 1 ── hero ------------------------------------------------------- */}
      <section className="hero">
        <div className="land-wrap">
          <div className="eyebrow fig">watching @AlphaDesJurix and one private channel</div>
          <h1>
            Every call these channels make, <span>kept honestly</span>.
          </h1>
          <p className="lede">
            We record each call the moment it lands — what the token is, what it was worth at that moment, and
            what happened to it afterwards. Including the ones that went to zero.
          </p>
          <Link className="btn big" href="/feed">
            See live calls
          </Link>
          <p className="under">The record below is public. No account needed to read it.</p>
        </div>
      </section>

      {/* 2 ── the problem ------------------------------------------------ */}
      <section className="land-wrap sec">
        <h2>A call arrives as 43 characters.</h2>
        <div className="addr fig">7jFfW1Au7UvS8YxmAHphjNZrtUEbdcvKUugFw2BwQALL</div>
        <p className="body">
          That is the whole message. No name, no idea what the project is or where the joke came from, and no
          record of what happened next. Scroll back a week and the calls are still there — but what they were
          worth when they were called, and what they did afterwards, is gone.
        </p>
        <p className="body muted">
          Both channels already run a bot that posts “we hit 3x” cards. A card is not a record: it appears when
          the news is good and never when it isn’t.
        </p>
      </section>

      {/* 3 ── the card --------------------------------------------------- */}
      <section className="land-wrap sec">
        <h2>So we keep the rest.</h2>
        <p className="body">
          One card per call, built the moment it lands. This is a real one from the feed, not a mock-up.
        </p>
        {s.anatomy && (
          <div className="anat">
            <div className="anat-card">
              <div className="anat-head">
                <span className="ticker">${s.anatomy.symbol}</span>
                <span className={`tag ${s.anatomy.provenance === "MEASURED" ? "live" : ""}`}>
                  {s.anatomy.provenance === "MEASURED" ? "measured at the call" : "reconstructed"}
                </span>
              </div>
              <div className="anat-nums">
                <div>
                  <div className="k">Called at</div>
                  <div className="v fig">{s.anatomy.calledAtUsd === null ? "unknown" : usd(s.anatomy.calledAtUsd)}</div>
                </div>
                <div>
                  <div className="k">Now</div>
                  <div className="v fig">{s.anatomy.latestUsd === null ? "—" : usd(s.anatomy.latestUsd)}</div>
                </div>
                <div>
                  <div className="k">Peak</div>
                  <div className="v fig">
                    {s.anatomy.peakMultiple === null ? "—" : `${s.anatomy.peakMultiple.toFixed(2)}x`}
                  </div>
                </div>
              </div>
              {s.anatomy.narrative && (
                <div className="anat-story">
                  <span className="lbl">
                    {s.anatomy.narrativeIsCaller
                      ? "the caller’s own words"
                      : "summarised from the project’s own socials"}
                  </span>
                  {s.anatomy.narrative.slice(0, 220)}
                </div>
              )}
            </div>
            <ul className="anat-notes">
              <li>
                <b>The story.</b> What the token is and where the joke came from — the caller’s own words where they
                wrote any, otherwise a summary of the project’s own pages. Labelled either way, because they are not
                the same claim.
              </li>
              <li>
                <b>Called at.</b> The market cap at the moment of the call, and whether we measured it ourselves or
                rebuilt it from history afterwards.
              </li>
              <li>
                <b>Peak and now.</b> Measured by our own polling, never taken from the channel’s claim about itself.
              </li>
            </ul>
          </div>
        )}
      </section>

      {/* 4 ── time to peak ----------------------------------------------- */}
      <section className="land-wrap sec">
        <h2>How long did you have to act?</h2>
        <p className="body">
          Every call has a window between landing and peaking. Nobody in this space publishes it, and it is the
          number that decides whether seeing a call twenty minutes late mattered. We record the timestamp of the
          call and poll the price from that minute, so the window is a measurement rather than a memory.
        </p>
        <p className="body muted">
          There is no figure here yet, and there will not be one until it is honest. We began measuring prices on
          21 September; most calls on the board were made before that, so any window we printed today would be
          the time since <em>we started watching</em>, not the time since the call. It appears here when it is real.
        </p>
      </section>

      {/* 5 ── the journal ------------------------------------------------ */}
      <section className="land-wrap sec">
        <h2>You entered at 2.2x the call.</h2>
        <p className="body">
          A channel’s record and a trader’s record are different things, and the gap between them is entry
          timing. Log a play against a call and the journal works out what you actually paid relative to the
          call price — the number that explains why a channel’s 10x was your 1.4x.
        </p>
        <p className="body muted">Private to you. Never public, never counted into anything on this page.</p>
      </section>

      {/* 6 ── the honest record ------------------------------------------ */}
      <section className="record">
        <div className="land-wrap sec">
          <h2>The losers stay on the board.</h2>
          <p className="body">
            A feed that quietly drops its failures is the pattern every scam tool uses. Ours keeps them, with the
            reason each one died and the time it happened.
          </p>

          <dl className="figs">
            <div>
              <dt>Calls tracked</dt>
              <dd className="fig">{s.calls}</dd>
              <small>since {s.firstCallDate}</small>
            </div>
            <div>
              <dt>Already dead</dt>
              <dd className="fig red">{s.deadPercent}%</dd>
              <small>
                {s.deadCalls} of {s.calls}, each with a reason
              </small>
            </div>
            <div>
              <dt>Entry price measured</dt>
              <dd className="fig lime">{s.entryMeasured}</dd>
              <small>read at the moment of the call</small>
            </div>
            <div>
              <dt>Entry reconstructed</dt>
              <dd className="fig amber">{s.entryReconstructed}</dd>
              <small>rebuilt from history, labelled</small>
            </div>
            <div>
              <dt>No entry price</dt>
              <dd className="fig faint">{s.entryMissing}</dd>
              <small>we say why, rather than guess</small>
            </div>
          </dl>

          {s.deadExamples.length > 0 && (
            <ul className="deadlist">
              {s.deadExamples.map((d) => (
                <li key={d.symbol + d.calledAt}>
                  <span className="ticker">${d.symbol}</span>
                  <span className="fig when">called {d.calledAt}</span>
                  <span className="reason">{d.reason}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="body muted small deadnote">
            “No pair on DexScreener” means there is no longer a tradeable market for the token. We check twice,
            on separate polls, before closing a call — one bad reading is an outage, not a rug.
          </p>

          <p className="body caveat">
            <b>What we will not show you yet:</b> a win rate, a median peak, or a time to peak. Price polling began
            on 21 September and most of these calls were made before it, so any peak we printed would be the
            highest price since we started watching — not the highest price after the call. Those numbers appear
            here once we have measured a call from its first minute to its peak, and not before.
          </p>
          <p className="asof fig">figures as of {s.asOf}, read from the database</p>
        </div>
      </section>

      {/* 7 ── CTA + risk -------------------------------------------------- */}
      <section className="land-wrap sec cta">
        <h2>See what the channels are calling.</h2>
        <Link className="btn big" href="/feed">
          See live calls
        </Link>
        <div className="risk">
          Memecoins are high risk. Most tokens go to zero. Nothing here is financial advice.
        </div>
        <p className="body muted small">
          AlphaDes records what two Telegram channels post. It does not endorse them, is not affiliated with them,
          and does not tell you what to buy.
        </p>
      </section>
    </main>
  );
}
