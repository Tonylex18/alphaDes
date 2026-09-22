"use client";

/**
 * The live feed.
 *
 * Polls /api/feed every POLL_MS. That route serves a tag-cached payload and
 * touches the database only when the worker has pushed a change, so this poll
 * costs nothing in Neon compute however many people have the page open. See
 * lib/feed.ts.
 *
 * Cards are laid out in three columns, newest first, and a call that appeared
 * since the last poll is briefly outlined so you can see it land.
 */
import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";
import type { FeedCall } from "../lib/feed";
import { CallCard } from "./CallCard";

const POLL_MS = 10_000;

type Payload = { calls: FeedCall[]; servedAt: string; dbQueries: number };

export function Feed() {
  const [calls, setCalls] = useState<FeedCall[] | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [lastOk, setLastOk] = useState<number>(Date.now());
  // First load is not an "arrival" — only later ones are worth highlighting.
  const loaded = useRef(false);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        // The feed is served only against a verified Privy token.
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/feed", {
          cache: "no-store",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data: Payload = await res.json();
        if (!alive) return;
        const arrived = loaded.current
          ? data.calls.filter((c) => !seen.current.has(c.id)).map((c) => c.id)
          : [];
        for (const c of data.calls) seen.current.add(c.id);
        loaded.current = true;
        setCalls(data.calls);
        setLastOk(Date.now());
        if (arrived.length) {
          setFreshIds(new Set(arrived));
          setTimeout(() => { if (alive) setFreshIds(new Set()); }, 6000);
        }
      } catch {
        // A failed poll is not worth showing; the indicator goes stale on its own.
      }
    };
    void tick(); // first load
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (calls === null) {
    return (
      <div className="gate">
        <div className="skeleton">loading the feed…</div>
      </div>
    );
  }

  const open = calls.filter((c) => c.status !== "CLOSED_DEAD").length;
  const dead = calls.length - open;
  const measured = calls.filter((c) => c.entry.provenance === "MEASURED").length;
  const reconstructed = calls.filter((c) => c.entry.provenance === "RECONSTRUCTED").length;
  const noEntry = calls.filter((c) => c.entry.provenance === "MISSING").length;
  const stale = Date.now() - lastOk > POLL_MS * 3;

  const columns: FeedCall[][] = [[], [], []];
  calls.forEach((c, i) => columns[i % 3]!.push(c));

  return (
    <>
      <div className="top">
        <div className="brand">
          alpha<span>des</span>
        </div>
        <div className="spacer" />
        <div className="live">
          <span className={`dot ${stale ? "stale" : "beat"}`} />
          {stale ? "reconnecting" : "live"}
        </div>
      </div>

      <div className="wrap">
        <dl className="summary">
          <div>
            <dt>Calls</dt>
            <dd className="fig">{calls.length}</dd>
          </div>
          <div>
            <dt>Open</dt>
            <dd className="fig" style={{ color: "var(--lime)" }}>{open}</dd>
          </div>
          <div>
            <dt>Dead</dt>
            <dd className="fig" style={{ color: "var(--red)" }}>{dead}</dd>
          </div>
          <div>
            <dt>Entry measured</dt>
            <dd className="fig">{measured}</dd>
          </div>
          <div>
            <dt>Entry reconstructed</dt>
            <dd className="fig" style={{ color: "var(--amber)" }}>{reconstructed}</dd>
          </div>
          <div>
            <dt>No entry price</dt>
            <dd className="fig" style={{ color: "var(--faint)" }}>{noEntry}</dd>
          </div>
        </dl>

        <div className="cols">
          {columns.map((col, i) => (
            <div className="col" key={i}>
              {col.map((c) => (
                <CallCard key={c.id} call={c} fresh={freshIds.has(c.id)} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
