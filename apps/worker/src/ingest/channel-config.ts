/**
 * Channel configuration, read from the environment.
 *
 * Channels are configuration, not code (CLAUDE.md rule 1). The database is the
 * runtime source of truth; this file is only how the rows get seeded on a fresh
 * environment, so that no Telegram id is ever committed.
 *
 *   CHANNEL_1_ID=-100...
 *   CHANNEL_1_KIND=BARE_CA
 *   CHANNEL_1_NAME=Some channel
 *   CHANNEL_1_USERNAME=          # optional, omit for a private channel
 *   CHANNEL_1_ROLE=TRACK         # optional; OBSERVE = measured, never recorded
 *   CHANNEL_2_ID=...
 *
 * Numbering starts at 1 and stops at the first gap.
 */
import type { ChannelKind } from "./classify.js";

export type ChannelRole = "TRACK" | "OBSERVE";

export type ChannelConfig = {
  telegramId: bigint;
  kind: ChannelKind;
  role: ChannelRole;
  displayName: string;
  username: string | null;
  active: boolean;
};

const KINDS: ChannelKind[] = ["BARE_CA", "NARRATIVE"];
const ROLES: ChannelRole[] = ["TRACK", "OBSERVE"];

export function readChannelConfig(env: NodeJS.ProcessEnv = process.env): ChannelConfig[] {
  const out: ChannelConfig[] = [];

  for (let n = 1; ; n++) {
    const rawId = env[`CHANNEL_${n}_ID`]?.trim();
    if (!rawId) break;

    const kind = env[`CHANNEL_${n}_KIND`]?.trim() as ChannelKind | undefined;
    const displayName = env[`CHANNEL_${n}_NAME`]?.trim();

    if (!/^-?\d+$/.test(rawId)) {
      throw new Error(`CHANNEL_${n}_ID must be a numeric Telegram id, got "${rawId}"`);
    }
    if (!kind || !KINDS.includes(kind)) {
      throw new Error(`CHANNEL_${n}_KIND must be one of ${KINDS.join(" | ")}, got "${kind ?? ""}"`);
    }
    if (!displayName) {
      throw new Error(`CHANNEL_${n}_NAME is required (it is what shows on the feed)`);
    }

    const username = env[`CHANNEL_${n}_USERNAME`]?.trim().replace(/^@/, "") || null;
    const role = (env[`CHANNEL_${n}_ROLE`]?.trim().toUpperCase() || "TRACK") as ChannelRole;
    if (!ROLES.includes(role)) {
      throw new Error(`CHANNEL_${n}_ROLE must be one of ${ROLES.join(" | ")}, got "${role}"`);
    }
    const activeRaw = env[`CHANNEL_${n}_ACTIVE`]?.trim().toLowerCase();

    out.push({
      telegramId: BigInt(rawId),
      kind,
      role,
      displayName,
      username,
      // Present but not "false" means on. Absent means on.
      active: activeRaw !== "false" && activeRaw !== "0",
    });
  }

  const seen = new Set<string>();
  for (const c of out) {
    const key = String(c.telegramId);
    if (seen.has(key)) throw new Error(`channel ${key} is configured twice`);
    seen.add(key);
  }

  return out;
}
