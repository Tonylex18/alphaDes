/**
 * Loads the repo-root .env, exactly once, as a side effect of importing.
 *
 * It is its own module so that anything needing the environment can guarantee
 * it is loaded BEFORE the Prisma client is constructed: ESM evaluates imports
 * in order, so `import "../lib/env.js"` above `import { prisma }` is the whole
 * mechanism. A function call could not do this — imports hoist above statements.
 */
import { config as loadEnv } from "dotenv";
import { ENV_PATH } from "./paths.js";

loadEnv({ path: ENV_PATH });

export { ENV_PATH };
