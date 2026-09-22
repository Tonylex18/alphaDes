"use client";

/**
 * The live feed is behind sign-in. The PUBLIC track record is Phase 6 and needs
 * no account — it is deliberately not built here.
 */
import { usePrivy } from "@privy-io/react-auth";
import { Feed } from "./Feed";

export function Gate() {
  const { ready, authenticated, login, logout, user } = usePrivy();

  if (!ready) {
    return (
      <div className="gate">
        <div className="skeleton">loading…</div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="gate">
        <div className="gate-in">
          <h1>
            Every call, with its <span>story</span> attached.
          </h1>
          <p>
            Two Telegram channels, watched continuously. Every call recorded the moment it lands —
            winners and losers both, with an honest note on where each number came from.
          </p>
          <button className="btn" onClick={login}>
            Sign in with email
          </button>
          <div className="note">One field, no password.</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Feed />
      <div className="wrap" style={{ paddingTop: 0 }}>
        <div className="foot" style={{ borderTop: 0 }}>
          <span>{user?.email?.address ?? "signed in"}</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}
