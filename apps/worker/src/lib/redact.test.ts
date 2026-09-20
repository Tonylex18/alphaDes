import test from "node:test";
import assert from "node:assert/strict";
import { redact, secretValues } from "./redact.js";

const env = {
  TG_SESSION: "1ApWapzMBu" + "x".repeat(300),
  TG_API_HASH: "0123456789abcdef0123456789abcdef",
  DATABASE_URL: "postgresql://neondb_owner:npg_S3cr3tPw@ep-x-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require",
  DIRECT_URL: "postgresql://neondb_owner:npg_S3cr3tPw@ep-x.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require",
} as NodeJS.ProcessEnv;

test("every secret, and a database password on its own, is scrubbed", () => {
  const secrets = secretValues(env);
  const line = [
    `session ${env.TG_SESSION}`,
    `hash ${env.TG_API_HASH}`,
    `url ${env.DATABASE_URL}`,
    `direct ${env.DIRECT_URL}`,
    `Authentication failed, password npg_S3cr3tPw rejected`,
    "Can't reach database server at `ep-x-pooler.c-6.us-east-2.aws.neon.tech:5432`",
  ].join(" | ");
  const out = redact(line, secrets);
  for (const s of [env.TG_SESSION!, env.TG_API_HASH!, env.DATABASE_URL!, env.DIRECT_URL!, "npg_S3cr3tPw"]) {
    assert.ok(!out.includes(s), `leaked: ${s.slice(0, 12)}…`);
  }
  // A host on its own — as Prisma prints it — is not a secret, and it is what
  // makes the error useful. Inside a full URL it goes with the URL.
  assert.match(out, /database server at `ep-x-pooler\.c-6\.us-east-2\.aws\.neon\.tech:5432`/);
});

test("nothing configured, nothing redacted", () => {
  assert.equal(redact("plain line", secretValues({})), "plain line");
});
