/**
 * Keep secrets out of logs.
 *
 * Railway retains logs and shows them to anyone on the project. The worker
 * holds three strings that must never appear there: the Telegram session (full
 * access to a personal account), and the two database URLs (which carry the
 * password). Our own code never prints them — this is for everything else:
 * GramJS's logger, Prisma's error messages, a stack trace that happens to
 * include a config object, a library upgrade that changes what it logs.
 *
 * Every console method is wrapped, and any occurrence of a secret value — or of
 * the password component of a database URL on its own — is replaced before the
 * line leaves the process. Installed first thing in index.ts, before anything
 * that could log.
 */
import { inspect } from "node:util";

const SECRET_ENV = ["TG_SESSION", "TG_API_HASH", "DATABASE_URL", "DIRECT_URL", "DATABASE_URL_UNPOOLED"];

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const name of SECRET_ENV) {
    const v = env[name]?.trim();
    if (!v || v.length < 8) continue;
    out.add(v);
    // A URL's password can surface on its own — URL-decoded, or in an error
    // that quotes the credentials without the rest of the string.
    try {
      const u = new URL(v);
      if (u.password) {
        out.add(u.password);
        out.add(decodeURIComponent(u.password));
      }
    } catch {
      // not a URL
    }
  }
  // Longest first, so a secret containing another is replaced whole.
  return [...out].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("<redacted>");
  }
  return out;
}

let installed = false;

export function installLogRedaction(env: NodeJS.ProcessEnv = process.env): number {
  if (installed) return secretValues(env).length;
  installed = true;
  const secrets = secretValues(env);
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      // Format exactly as console would, then scrub the result as one string.
      const line = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 6 }))).join(" ");
      original(redact(line, secrets));
    };
  }
  return secrets.length;
}
