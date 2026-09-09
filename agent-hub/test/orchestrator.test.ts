import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { Hub } from "../src/hub.js";
import { startHttp } from "../src/http.js";
import type { HubEvent } from "../src/types.js";

async function boot(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  process.env.HUB_MOCK = "1";
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const cfg = loadConfig();
  cfg.repoPath = repo;
  cfg.bus.port = 0;
  cfg.stateDir = path.join(repo, ".hub");
  const hub = new Hub(cfg);
  const server = await startHttp(hub);
  const addr = server.address();
  if (addr && typeof addr === "object") cfg.bus.port = addr.port;
  hub.registerAdapters();
  const events: HubEvent[] = [];
  hub.store.onEvent((e) => events.push(e));
  const finished = new Promise<void>((resolve) =>
    hub.store.onEvent((e) => {
      if (e.type === "task.status" && ["done", "failed", "stopped"].includes(e.status)) resolve();
    }),
  );
  return { hub, server, repo, events, finished, cleanup: () => { server.close(); for (const k of Object.keys(env)) delete process.env[k]; } };
}

test("plan -> work -> review completes across two vendors with a planner Q&A", async () => {
  const { hub, repo, events, finished, cleanup } = await boot();
  try {
    const task = hub.orchestrator.createTask("demo task", { plannerVendor: "claude" });
    await finished;
    const t = hub.store.tasks.get(task.id)!;
    assert.equal(t.status, "done");
    assert.equal(t.plan?.length, 2);
    assert.equal(t.stepResults.length, 2);
    assert.ok(t.stepResults.every((s) => s.status === "done"));
    // step 1 preferred claude, step 2 preferred codex -> different vendors did the work
    assert.deepEqual(t.stepResults.map((s) => s.vendor), ["claude", "codex"]);
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")));
    assert.ok(fs.existsSync(path.join(repo, "second-file.txt")), "worker followed planner's answer");
    // the codex worker asked the claude planner and got an answer over the bus
    const msgs = events.filter((e) => e.type === "bus.message") as Extract<HubEvent, { type: "bus.message" }>[];
    assert.ok(msgs.some((m) => m.from.startsWith("codex-worker") && m.to.startsWith("claude-planner")));
    assert.ok(msgs.some((m) => m.from.startsWith("claude-planner") && m.to.startsWith("codex-worker") && /kebab-case/.test(m.text)));
    assert.equal(t.review?.at(-1)?.verdict, "approve");
    assert.ok(hub.quota.snapshot().length >= 2);
  } finally {
    cleanup();
  }
});

test("planner can request a revision and the worker applies it", async () => {
  const { hub, repo, finished, cleanup } = await boot({ MOCK_REVISE: "1" });
  try {
    const task = hub.orchestrator.createTask("demo task with revision", { plannerVendor: "claude" });
    await finished;
    const t = hub.store.tasks.get(task.id)!;
    assert.equal(t.status, "done");
    assert.equal(t.review?.length, 2);
    assert.deepEqual(t.review?.map((r) => r.verdict), ["revise", "approve"]);
    assert.ok(fs.readFileSync(path.join(repo, "second-file.txt"), "utf8").endsWith("\n"));
  } finally {
    cleanup();
  }
});

test("a rate-limited vendor is cooled down and the step is rerouted", async () => {
  const { hub, events, finished, cleanup } = await boot({ MOCK_RATE_LIMIT: "claude" });
  try {
    const task = hub.orchestrator.createTask("demo task with rate limit", { plannerVendor: "codex" });
    await finished;
    const t = hub.store.tasks.get(task.id)!;
    assert.equal(t.status, "done");
    // step 1 preferred claude, claude 429'd -> rerouted to codex
    assert.equal(t.stepResults[0].vendor, "codex");
    assert.equal(hub.quota.isHealthy("claude"), false);
    assert.ok(events.some((e) => e.type === "hub.info" && /rate limits/.test(e.text)));
    // step 2 preferred codex and claude is cooling down -> codex again, no reroute
    assert.equal(t.stepResults[1].vendor, "codex");
  } finally {
    cleanup();
  }
});
