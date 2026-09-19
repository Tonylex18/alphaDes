import { config as loadEnv } from "dotenv";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { ENV_PATH } from "./paths.js";

// Explicit path: npm workspaces set cwd to apps/worker, so the default lookup
// would miss the repo-root .env entirely.
loadEnv({ path: ENV_PATH });

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Looked in ${ENV_PATH}. ` +
        `Copy .env.example to .env at the repo root and fill it in.`,
    );
  }
  return v;
}

/// A client built from the saved session string. Used by every script and by
/// the long-running listener, so we log in exactly once, ever.
export function createClient(session = process.env.TG_SESSION ?? "") {
  return new TelegramClient(
    new StringSession(session),
    Number(requireEnv("TG_API_ID")),
    requireEnv("TG_API_HASH"),
    { connectionRetries: 10, retryDelay: 2000 },
  );
}
