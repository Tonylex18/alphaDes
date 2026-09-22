/**
 * One call, and an honest account of where each of its numbers came from.
 *
 * Three contracts from Phases 2 and 3 meet the screen here, and the card's job
 * is to keep them apart rather than average them into something prettier:
 *
 *  1. A MEASURED entry price and a RECONSTRUCTED one are not the same claim.
 *     They are labelled differently and coloured differently. A call with no
 *     entry price shows no multiple at all — not a zero, not a dash.
 *  2. The caller's own words, our summary of the project's own pages, and
 *     "nothing was published" are three different things with three different
 *     labels. NONE is about half the board and reads as a finding, not a gap.
 *  3. Dead calls stay, with the reason.
 */
import type { FeedCall } from "../lib/feed";

const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}m`
  : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}k`
  : `$${n.toFixed(0)}`;

const mult = (m: number) => (m >= 10 ? `${m.toFixed(0)}x` : `${m.toFixed(2)}x`);

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const PROVENANCE: Record<FeedCall["entry"]["provenance"], { label: string; title: string }> = {
  MEASURED: {
    label: "measured at the call",
    title: "We were listening when this call landed and read the market cap ourselves.",
  },
  RECONSTRUCTED: {
    label: "reconstructed from history",
    title:
      "We were not there. This price was rebuilt afterwards from historical candles, so it is an estimate of the entry, not a measurement of it.",
  },
  MISSING: {
    label: "no entry price",
    title: "We could not establish what this was worth when it was called, so no multiple can be shown.",
  },
};

const NARRATIVE_LABEL = {
  CALLER: "the caller's own words",
  GENERATED: "summarised from the project's own socials",
  NONE: "no story",
  PENDING: "not looked up yet",
} as const;

export function CallCard({ call, fresh }: { call: FeedCall; fresh: boolean }) {
  const dead = call.status === "CLOSED_DEAD";
  const { entry } = call;
  const prov = PROVENANCE[entry.provenance];
  const sym = call.token.symbol ?? call.token.address.slice(0, 6);

  return (
    <article className={`card${dead ? " dead" : ""}${fresh ? " fresh" : ""}`}>
      <div className="card-top">
        <div className="avatar">
          {call.token.imageUrl ? <img src={call.token.imageUrl} alt="" /> : sym.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ticker">${sym}</div>
          <div className="sub">
            {call.channel} · <span className="fig">{ago(call.calledAt)}</span>
          </div>
        </div>
        <span className={`tag ${dead ? "dead" : "live"}`}>{dead ? "DEAD" : "OPEN"}</span>
      </div>

      <div className="nums">
        <div className="num">
          <div className="k">Called at</div>
          {entry.marketCapUsd === null ? (
            <div className="v none">unknown</div>
          ) : (
            <div className="v">{usd(entry.marketCapUsd)}</div>
          )}
        </div>
        <div className="num">
          <div className="k">Now</div>
          {call.latestMarketCapUsd === null ? (
            <div className="v none">—</div>
          ) : (
            <div className="v">{usd(call.latestMarketCapUsd)}</div>
          )}
        </div>
        <div className="num">
          <div className="k">Peak</div>
          {/* A multiple is only shown when there is an entry price to divide by.
              Otherwise the market cap alone, with no implied performance. */}
          {call.peakMultiple === null ? (
            <div className="v none">{call.peakMarketCapUsd === null ? "—" : usd(call.peakMarketCapUsd)}</div>
          ) : (
            <div className={`v ${call.peakMultiple >= 1 ? "up" : "down"}`}>{mult(call.peakMultiple)}</div>
          )}
        </div>
      </div>

      <div className={`prov ${entry.provenance.toLowerCase()}`} title={prov.title}>
        <b>{prov.label}</b>
        {entry.observedLagSeconds !== null && entry.provenance === "MEASURED" && (
          <span>· read {entry.observedLagSeconds}s after the call</span>
        )}
        {call.latestMultiple !== null && (
          <span>
            · now <b>{mult(call.latestMultiple)}</b>
          </span>
        )}
      </div>

      {entry.provenance === "MISSING" && entry.nullReason && (
        <div className="why">
          <span className="reason">why:</span>
          <span>{entry.nullReason}</span>
        </div>
      )}

      {call.statedMarketCapUsd !== null && (
        <div className="why">
          <span>caller said</span>
          <span className="fig">{usd(call.statedMarketCapUsd)}</span>
          <span style={{ color: "var(--faint)" }}>— their claim, not our measurement</span>
        </div>
      )}

      <div className={`narr ${call.narrative.source.toLowerCase()}`}>
        <span className="label">{NARRATIVE_LABEL[call.narrative.source]}</span>
        {call.narrative.summary ? (
          <div className="body">{call.narrative.summary}</div>
        ) : call.narrative.source === "NONE" ? (
          <div className="body">
            {call.narrative.nullReason?.startsWith("no website")
              ? "This token had no website, X or Telegram on its listing when it was called."
              : call.narrative.nullReason ?? "The project published nothing we could read."}
          </div>
        ) : (
          <div className="body">No story yet — nothing has been looked up for this token.</div>
        )}
      </div>

      {dead && call.closeReason && (
        <div className="why">
          <span className="reason">closed:</span>
          <span>{call.closeReason}</span>
        </div>
      )}

      <div className="foot">
        <span>{call.token.dexChainId ?? call.token.chain.toLowerCase()}</span>
        <span>·</span>
        <span>{call.eventCount} event{call.eventCount === 1 ? "" : "s"}</span>
        <span style={{ flex: 1 }} />
        <a href={`https://dexscreener.com/${call.token.dexChainId ?? "solana"}/${call.token.address}`} target="_blank" rel="noreferrer">
          chart
        </a>
      </div>
    </article>
  );
}
