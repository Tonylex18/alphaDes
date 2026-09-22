/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
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
