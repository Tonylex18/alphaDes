import { PrismaClient, type Prisma } from "@prisma/client";

// Every SQL statement the engine sends is counted. The worker exposes the count
// on /health and in its stats line, which is how "an idle worker makes zero
// database queries" is checked rather than asserted: the number must not move
// while nothing is arriving. Cost is one increment per query.
let queries = 0;
export function dbQueryCount(): number {
  return queries;
}

type Client = PrismaClient<Prisma.PrismaClientOptions, "query">;

function create(): Client {
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  client.$on("query", () => {
    queries++;
  });
  return client;
}

// Reuse one client across hot reloads in dev; serverless funcs get their own.
const g = globalThis as unknown as { prisma?: Client };
export const prisma: Client = g.prisma ?? create();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

export * from "@prisma/client";
