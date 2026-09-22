/**
 * POST /api/revalidate — the worker telling us something changed.
 *
 * This is what lets the feed be live without polling the database. The worker
 * is the only writer, so it is the only thing that knows when a re-read is
 * worth a query. Browsers never trigger a read; the writer does.
 *
 * Shared-secret authenticated: without it, anyone could force the database
 * awake by curling this in a loop — the exact cost the design avoids.
 */
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { FEED_TAG } from "../../../lib/feed";

export async function POST(req: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "REVALIDATE_SECRET not configured" }, { status: 503 });
  }
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  revalidateTag(FEED_TAG);
  return NextResponse.json({ revalidated: true, at: new Date().toISOString() });
}
