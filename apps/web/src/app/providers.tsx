"use client";

/**
 * Privy: one field, an email address, no password.
 *
 * An embedded wallet is provisioned in the background for every user. Nothing
 * in v1 touches it — it exists so that buying, later, can be browser-signed and
 * the app never has to hold a key.
 */
import { PrivyProvider } from "@privy-io/react-auth";

export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) {
    return (
      <div className="gate">
        <div className="gate-in">
          <h1>Not configured</h1>
          <p>NEXT_PUBLIC_PRIVY_APP_ID is not set, so sign-in cannot load.</p>
        </div>
      </div>
    );
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        appearance: { theme: "dark", accentColor: "#b8f24d", showWalletLoginFirst: false },
        // Privy 3.x provisions per chain. Calls span Solana and EVM, so both
        // are created now — v1 never touches them, but later browser-signed
        // buying should not need a second onboarding.
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
