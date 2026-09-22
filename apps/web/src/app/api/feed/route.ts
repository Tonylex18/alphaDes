/**
 * GET /api/feed — what the browser polls, and the only way feed data leaves
 * the server.
 *
 * Requires a verified Privy token: the live feed is behind sign-in. (The PUBLIC
 * track record is Phase 6 and will need no account — it is a different route.)
 *
 * On a cache hit this touches no database at all, which is the whole point:
 * polling cost is independent of how many people are watching. `dbQueries` is
 * returned so that claim can be checked from outside rather than believed.
 */
import { NextResponse } from "next/server";
import { dbQueryCount } from "@alphades/db";
import { getFeed } from "../../../lib/feed";
import { viewerFrom } from "../../../lib/auth";

export const dynamic = "force-dynamic"; // the CACHE is the tag, not the route

export async function GET(req: Request) {
  const viewer = await viewerFrom(req);
  if (!viewer) {
    return NextResponse.json({ error: "sign in to see the live feed" }, { status: 401 });
  }
  const before = dbQueryCount();
  const calls = await getFeed(100);
  const after = dbQueryCount();
  return NextResponse.json(
    {
      calls,
      servedAt: new Date().toISOString(),
      // 0 on a cache hit. Watch it stay flat while the feed is hammered.
      dbQueries: after - before,
      dbQueriesTotal: after,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
