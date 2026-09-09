/**
 * End-to-end demo in mock mode: no vendor credentials, no Telegram.
 * Creates a temp git repo, runs one task through plan -> work -> review and prints the notifications.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { startHttp } from "./http.js";
import { formatNotification } from "./notify.js";

process.env.HUB_MOCK = "1";
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-demo-"));
execFileSync("git", ["init", "-q"], { cwd: repo });
const cfg = loadConfig();
cfg.repoPath = repo;
cfg.bus.port = 0; // random free port
cfg.stateDir = path.join(repo, ".hub");
const hub = new Hub(cfg);
const server = await startHttp(hub);
const addr = server.address();
if (addr && typeof addr === "object") cfg.bus.port = addr.port;
// adapters captured hubUrl at construction; rebuild now that the port is known
hub.registerAdapters();

hub.store.onEvent((e) => {
  const t = formatNotification(e);
  if (t) console.log(t);
});

const done = new Promise<void>((resolve) => {
  hub.store.onEvent((e) => {
    if (e.type === "task.status" && ["done", "failed", "stopped"].includes(e.status)) resolve();
  });
});
const task = hub.orchestrator.createTask("Create two greeting files (demo)", { plannerVendor: "claude" });
console.log(`task ${task.id} started in ${repo}`);
await done;
console.log("\nfiles:", fs.readdirSync(repo).filter((f) => !f.startsWith(".")).join(", "));
console.log("quota:", hub.quota.snapshot().map((p) => `${p.vendor}=${p.turns}t/$${p.costUsd.toFixed(2)}`).join(" "));
server.close();
process.exit(0);
