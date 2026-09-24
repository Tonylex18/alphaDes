/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The landing page reads the database at build time and Neon may be asleep:
  // waking it takes 5-15s and the read retries. Next's default 60s static
  // generation timeout kills the worker mid-wake (observed), so allow for it.
  staticPageGenerationTimeout: 180,
  // packages/db is a workspace package of TypeScript source, not build output.
  transpilePackages: ["@alphades/db"],
  experimental: { serverComponentsExternalPackages: ["@prisma/client"] },
  webpack: (config) => {
    // Privy ships optional Farcaster mini-app integrations we do not use, and
    // webpack will not build with them merely unresolved. Stub them rather than
    // install packages the app never calls.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@farcaster/mini-app-solana": false,
      "@farcaster/miniapp-wagmi-connector": false,
      "@farcaster/frame-sdk": false,
    };
    return config;
  },
};
