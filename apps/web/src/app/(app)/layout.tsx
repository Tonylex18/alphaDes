import { Providers } from "../providers";

/**
 * Everything behind sign-in.
 *
 * Privy lives here rather than in the root layout, because a provider in the
 * root layout is downloaded by every route under it — including the public
 * landing page, which has no sign-in on it and is the one page strangers hit.
 * Measured before this split: `/` pulled 12 chunks and 2.6MB of JavaScript, of
 * which a single 1.9MB chunk was Privy. Next's "First Load JS" column does not
 * show this, so the build output looked fine while the served HTML was not.
 *
 * The route group parentheses keep the URL as /feed.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
