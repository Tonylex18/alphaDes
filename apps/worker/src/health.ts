/**
 * The health endpoint. Plain node:http — two routes do not need a framework.
 *
 *   GET /health   200 while ingestion is alive, 503 when it is not.
 *   GET /         the same.
 *
 * Reads process memory only — never the database. A health check that queried
 * Neon would keep it awake, and would report "unhealthy" whenever Neon was
 * asleep, which is its normal state.
 *
 * On Railway this is consulted ONLY during a deploy (to decide the deploy
 * succeeded). Railway does not watch it afterwards. The ongoing guard is the
 * watchdog in index.ts, which exits the process so the restart policy acts.
 */
import { createServer, type Server } from "node:http";
import { health } from "./runtime.js";

export function startHealthServer(port = Number(process.env.PORT ?? 8080)): Server {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || !["/health", "/"].includes((req.url ?? "").split("?")[0]!)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const report = health();
    res.writeHead(report.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(report, null, 2));
  });
  server.listen(port, () => console.log(`[health] listening on :${port}/health`));
  return server;
}
