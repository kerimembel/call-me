import http from "node:http";
import type { Hub } from "./hub.js";
import { handleBusCall } from "./bus/handlers.js";

/** Localhost HTTP surface: the MCP bus processes call POST /bus/call here. */
export function startHttp(hub: Hub): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, agents: hub.agents.size });
      if (req.method === "GET" && req.url === "/state") {
        return send(200, {
          tasks: [...hub.store.tasks.values()],
          agents: [...hub.agents.values()].map((a) => ({ ...a.spec, busy: a.busy, alive: a.alive, sessionId: a.sessionId })),
          quota: hub.quota.snapshot(),
        });
      }
      if (req.method === "POST" && req.url === "/bus/call") {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${hub.token}`) return send(401, { error: "unauthorized" });
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { agentId, tool, args } = JSON.parse(raw || "{}");
        const text = await handleBusCall(hub, String(agentId), String(tool), args ?? {});
        return send(200, { text });
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(hub.cfg.bus.port, hub.cfg.bus.host, () => resolve(server));
  });
}
