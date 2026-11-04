import { createServer, type Server } from "node:http";

/**
 * Cold boot only. No app/router/auth/storage/queue/database import is permitted here.
 * This does not stop another replica, an old deployment, or a native database writer.
 */
export async function startMaintenanceServer(port: number, host = "0.0.0.0"): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Connection", "close");
    if (req.method === "GET" && path === "/api/healthz") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", mode: "maintenance" }));
      return;
    }
    res.setHeader("Retry-After", "60");
    res.writeHead(503);
    res.end(JSON.stringify({ status: "maintenance", code: "maintenance_unavailable" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
