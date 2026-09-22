/**
 * Server-side verification of a Privy session.
 *
 * The gate has to be here, not in the component tree. Rendering the feed only
 * when `authenticated` is true looks like a gate but is not one: Next
 * serialises server props into the page payload, so the first version of this
 * shipped every call in the signed-out HTML — `curl` read the whole feed
 * without an account. The data now leaves the server only in response to a
 * request carrying a verified token.
 */
import { PrivyClient } from "@privy-io/server-auth";

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;

let client: PrivyClient | null = null;
function privy(): PrivyClient | null {
  if (!appId || !appSecret) return null;
  client ??= new PrivyClient(appId, appSecret);
  return client;
}

export type Viewer = { userId: string };

/// The Privy user behind this request, or null. Null always means "do not
/// serve the feed" — including when Privy is not configured, because a
/// misconfiguration must fail closed rather than open the feed to everyone.
export async function viewerFrom(req: Request): Promise<Viewer | null> {
  const p = privy();
  if (!p) return null;
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const claims = await p.verifyAuthToken(token);
    return { userId: claims.userId };
  } catch {
    // Expired, forged, or for another app.
    return null;
  }
}
