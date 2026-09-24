import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AlphaDes — live calls",
  description: "Every call from the channels we watch, with the token's story and an honest record of what it did.",
};

/**
 * Nothing but the document shell and the stylesheet.
 *
 * No provider belongs here: a client provider in the root layout ships to every
 * route, and the landing page is public, static and has no sign-in. Sign-in
 * lives in the (app) route group.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
