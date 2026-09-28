import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { startHttp } from "./http.js";
import { startTelegram } from "./telegram.js";
import { startConsole } from "./console.js";

const cfg = loadConfig();
const hub = new Hub(cfg);
await startHttp(hub);
console.log(`[hub] bus at ${hub.hubUrl}  repo=${cfg.repoPath}  vendors=${hub.enabledVendors().join(",")}  planner=${cfg.plannerVendor}${cfg.mock ? "  (MOCK MODE)" : ""}`);
for (const v of hub.enabledVendors()) {
  console.log(`[hub] ${v}: planner=${hub.modelFor(v, "planner") ?? "vendor default"} worker=${hub.modelFor(v, "worker") ?? "vendor default"}`);
}

if (!cfg.noTelegram && cfg.telegram.token) {
  await startTelegram(hub);
  if (process.stdin.isTTY) startConsole(hub);
} else {
  if (!cfg.noTelegram) console.log("[hub] TELEGRAM_BOT_TOKEN yok, konsol modu");
  startConsole(hub);
}
