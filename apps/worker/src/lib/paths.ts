/**
 * npm workspaces run scripts with cwd = the workspace directory (apps/worker),
 * not the repo root. So `dotenv/config` looked for apps/worker/.env and never
 * found the real one, and every "data/dumps/..." write landed in the wrong
 * place. Everything that touches a repo-level path resolves it through here.
 *
 * The root is found by walking up from this module until a package.json with a
 * "workspaces" key appears — that is the one thing only the root has.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg && typeof pkg === "object" && "workspaces" in pkg) return dir;
    } catch {
      // No package.json here, or it is not valid JSON. Keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the repo root: walked up from ${startDir} to the ` +
          `filesystem root without finding a package.json containing "workspaces".`,
      );
    }
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/// The one .env, at the repo root. Both apps read it from here.
export const ENV_PATH = resolve(REPO_ROOT, ".env");

/// REPO_ROOT/data/dumps, created if it does not exist yet.
export function dumpsDir(): string {
  const dir = resolve(REPO_ROOT, "data", "dumps");
  mkdirSync(dir, { recursive: true });
  return dir;
}
