/**
 * The public landing page.
 *
 * Statically generated and revalidated once a day, so a visitor never triggers
 * a database read. Every figure is read off the database at build time —
 * nothing is modelled or invented, and a figure whose basis is a subset says
 * how big that subset is. There is no win rate: see lib/landing-stats.ts.
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
      {/* nav ─────────────────────────────────────────────────────────── */}
      <nav className="nav">
        <div className="nav-in">
          <div className="brand">
            alpha<span>des</span>
          </div>
          <div className="nav-links">
            <a href="#card">The card</a>
            <a href="#window">The window</a>
            <a href="#record">The record</a>
          </div>
          <Link className="btn pill" href="/feed">
            See live calls
          </Link>
        </div>
      </nav>

      {/* 1 ── hero, with the product itself as the visual ───────────────── */}
      <section className="hero">
        <div className="glow" aria-hidden />
        <div className="hero-in">
          <div className="eyebrow fig">watching @AlphaDesJurix and one private channel</div>
          <h1>
            Every call.
            <br />
            The story behind it.
            <br />
            <span>And what happened next.</span>
          </h1>
          <p className="lede">
            We record each call the moment it lands — including the ones that went to zero.
          </p>
          <Link className="btn big" href="/feed">
            See live calls
          </Link>
          <p className="under">Public record. No account needed to read it.</p>
        </div>

        {/* The real feed, built from real rows at build time. */}
        <div className="showcase" aria-label="the live feed">
          <p className="showcase-note">
            The most recent calls we hold an entry price for, newest first — not a selection.
          </p>
          <div className="showcase-grid">
            {s.heroCards.map((c) => (
              <article className={`scard${c.dead ? " dead" : ""}`} key={c.symbol + c.entryUsd}>
                <div className="scard-top">
                  <div className="savatar">
                    {c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" /> : c.symbol.slice(0, 2)}
                  </div>
                  <div className="sname">
                    <div className="ticker">${c.symbol}</div>
                    <div className={`sprov ${c.provenance.toLowerCase()}`}>
                      {c.provenance === "MEASURED" ? "measured at the call" : "reconstructed"}
                    </div>
                  </div>
                  {c.dead && <span className="tag dead">DEAD</span>}
                </div>
                <div className="scard-nums">
                  <div>
                    <div className="k">Called at</div>
                    <div className="v fig">{usd(c.entryUsd)}</div>
                  </div>
                  <div>
                    <div className="k">Peak</div>
                    <div className={`v fig ${c.peakMultiple !== null && c.peakMultiple >= 1 ? "up" : "down"}`}>
                      {c.peakMultiple === null ? "—" : `${c.peakMultiple.toFixed(2)}x`}
                    </div>
                  </div>
                  <div>
                    <div className="k">Now</div>
                    <div className={`v fig ${c.nowMultiple !== null && c.nowMultiple >= 1 ? "up" : "down"}`}>
                      {c.nowMultiple === null ? "—" : `${c.nowMultiple.toFixed(2)}x`}
                    </div>
                  </div>
                </div>
                {/* The number the rest of this space does not publish. Absent
                    where we hold no peak whose window starts at the call. */}
                <div className={`speak${c.timeToPeak === null ? " none" : ""}`}>
                  {c.timeToPeak === null
                    ? "no peak we can stand behind"
                    : `${c.timeToPeak} to peak · ${c.peakIsReconstructed ? "reconstructed" : "measured"}`}
                </div>
                {c.story ? (
                  <div className="sstory">
                    <span className="lbl">
                      {c.storyIsCaller ? "the caller’s own words" : "from the project’s own socials"}
                    </span>
                    {c.story.replace(/\s+/g, " ").slice(0, 150)}…
                  </div>
                ) : c.dead && c.closeReason ? (
                  <div className="sstory dead-reason">
                    <span className="lbl">closed</span>
                    {c.closeReason}
                  </div>
                ) : (
                  <div className="sstory empty">
                    <span className="lbl">no story</span>
                    Nothing published on this token’s own pages when it was called.
                  </div>
                )}
              </article>
            ))}
          </div>
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
      <section className="land-wrap sec" id="card">
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
              {s.anatomy.timeToPeak && (
                <div className="speak">
                  {s.anatomy.timeToPeak} to peak · {s.anatomy.peakIsReconstructed ? "reconstructed" : "measured"}
                </div>
              )}
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
                <b>Peak, and how long it took.</b> The highest the token reached after the call, and the window you
                had to act in. Rebuilt from the whole price history between the call and now, or measured by our own
                polling where we watched from the first minute — labelled either way, and left blank where we hold
                neither.
              </li>
              <li>
                <b>Now.</b> Our own polling. Never the channel’s claim about itself.
              </li>
            </ul>
          </div>
        )}
      </section>

      {/* 4 ── time to peak ----------------------------------------------- */}
      <section className="land-wrap sec" id="window">
        <h2>How long did you have to act?</h2>
        <p className="body">
          Every call has a window between landing and peaking. Nobody in this space publishes it, and it is the
          number that decides whether seeing a call twenty minutes late mattered. We record the timestamp of the
          call and poll the price from that minute, so the window is a measurement rather than a memory.
        </p>
        {s.medianTimeToPeak && (
          <div className="bignums window-nums">
            <div>
              <div className="bn amber">{s.medianTimeToPeak}</div>
              <div className="bl">median time to peak</div>
            </div>
            <div>
              <div className="bn">{s.medianPeakMultiple === null ? "—" : `${s.medianPeakMultiple.toFixed(2)}x`}</div>
              <div className="bl">median peak, from the call price</div>
            </div>
          </div>
        )}
        <p className="body muted">
          Across the {s.withPeak} calls where we hold a peak whose window starts at the call — {s.peakReconstructed}{" "}
          rebuilt from the full price history, {s.peakMeasured} watched from the first minute. The multiple is over
          the {s.withPeakAndEntry} of those that also have a call price to divide by. The remaining{" "}
          {s.calls - s.withPeak} calls show no peak at all, each with its reason on the card, because a peak over a
          window we cannot describe is the thing this page exists to avoid.
        </p>
        <p className="body muted small">
          Method: the highest price traded between the call and now, from minute candles where they were retained
          and hourly ones across the rest. An hourly high is a price something really traded at, so it understates
          at worst and can never invent a peak that did not happen. Daily candles are refused — they would date a
          peak to within twenty-four hours, which makes this figure meaningless.
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
      <section className="record" id="record">
        <div className="land-wrap sec">
          <h2>The losers stay on the board.</h2>
          <p className="body">
            A feed that quietly drops its failures is the pattern every scam tool uses. Ours keeps them, with the
            reason each one died and the time it happened.
          </p>

          {/* Printing your own failure rate this large is the argument. */}
          <div className="bignums">
            <div className="bignum">
              <div className="bn fig red">{s.deadPercent}%</div>
              <div className="bl">
                already dead — {s.deadCalls} of {s.calls}, each with a recorded reason
              </div>
            </div>
            <div className="bignum">
              <div className="bn fig">{s.calls}</div>
              <div className="bl">calls tracked since {s.firstCallDate}</div>
            </div>
          </div>

          <dl className="figs">
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
            <b>What we will not show you:</b> a win rate. A win rate needs an exit rule, and we do not have one —
            a peak is what the token did, not what anybody got for it. Nobody sells the top. The journal records
            what a trader actually did, and it is private, so it will never be averaged into a number on this page.
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
