import crypto from "node:crypto";
import type { HubConfig } from "./config.js";
import { Store } from "./store.js";
import { QuotaGovernor } from "./quota.js";
import { Approvals } from "./approvals.js";
import { AgentRuntime } from "./runtime.js";
import { Orchestrator } from "./orchestrator.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { MockAdapter } from "./adapters/mock.js";
import type { Adapter, AgentSpec, HubEvent, Vendor } from "./types.js";
import { formatIncoming } from "./prompts.js";

/** Central object: owns agents, store, quota governor, adapters and the orchestrator. */
export class Hub {
  readonly token = crypto.randomBytes(16).toString("hex");
  readonly store: Store;
  readonly quota: QuotaGovernor;
  readonly approvals: Approvals;
  readonly agents = new Map<string, AgentRuntime>();
  readonly adapters = new Map<Vendor, Adapter>();
  readonly orchestrator: Orchestrator;

  constructor(readonly cfg: HubConfig) {
    this.store = new Store(cfg.stateDir);
    this.quota = new QuotaGovernor(cfg);
    this.approvals = new Approvals(cfg.approvals);
    this.orchestrator = new Orchestrator(this);
    this.registerAdapters();
  }

  get hubUrl(): string {
    return `http://${this.cfg.bus.host}:${this.cfg.bus.port}`;
  }

  /** (Re)build adapters. Call again if the bus port changes after construction (port 0). */
  registerAdapters(): void {
    this.adapters.clear();
    const { cfg } = this;
    if (cfg.mock) {
      const deps = {
        hubUrl: this.hubUrl,
        token: this.token,
        reviseOnce: process.env.MOCK_REVISE === "1",
        rateLimitVendorOnce: process.env.MOCK_RATE_LIMIT as Vendor | undefined,
        delayMs: process.env.MOCK_DELAY_MS ? Number(process.env.MOCK_DELAY_MS) : undefined,
      };
      for (const v of ["claude", "codex", "mock"] as Vendor[]) this.adapters.set(v, new MockAdapter(v, deps));
      return;
    }
    if (cfg.vendors.claude?.enabled !== false) {
      this.adapters.set(
        "claude",
        new ClaudeAdapter({
          hubUrl: this.hubUrl,
          token: this.token,
          vendorCfg: cfg.vendors.claude ?? {},
          maxTurns: cfg.maxTurnsPerAgent,
          approve: (agentId, tool, input) => this.approvals.request(agentId, tool, input),
        }),
      );
    }
    if (cfg.vendors.codex?.enabled !== false) {
      this.adapters.set("codex", new CodexAdapter({ hubUrl: this.hubUrl, token: this.token, vendorCfg: cfg.vendors.codex ?? {} }));
    }
  }

  enabledVendors(): Vendor[] {
    return [...this.adapters.keys()];
  }

  modelFor(vendor: Vendor, role: "planner" | "worker"): string | undefined {
    return this.cfg.vendors[vendor]?.[role] ?? undefined;
  }

  emit(event: HubEvent): void {
    this.store.emit(event);
  }

  /** Event sink given to adapters: logs, keeps transcripts and feeds the quota governor. */
  private sinkFor(spec: AgentSpec) {
    return (event: HubEvent) => {
      const rt = this.agents.get(spec.id);
      if (event.type === "agent.text") rt?.note(event.text);
      if (event.type === "agent.tool") rt?.note(`→ ${event.tool} ${event.detail ?? ""}`);
      if (event.type === "agent.turn_done") {
        this.quota.recordUsage(spec.vendor, event.usage);
        if (QuotaGovernor.looksLikeRateLimit(event.error)) this.quota.markRejected(spec.vendor, undefined, event.error);
      }
      if (event.type === "agent.rate_limit") {
        this.quota.recordRateLimit(event.vendor, { status: event.status, utilization: event.utilization, resetsAt: event.resetsAt, window: event.window });
      }
      this.store.emit(event);
    };
  }

  async spawn(spec: AgentSpec): Promise<AgentRuntime> {
    const adapter = this.adapters.get(spec.vendor);
    if (!adapter) throw new Error(`vendor ${spec.vendor} is not enabled`);
    const handle = await adapter.create(spec, this.sinkFor(spec));
    const rt = new AgentRuntime(handle);
    this.agents.set(spec.id, rt);
    this.emit({ type: "agent.started", agentId: spec.id, taskId: spec.taskId, vendor: spec.vendor, role: spec.role, model: spec.model });
    return rt;
  }

  /** Deliver a bus message to an agent as its next turn (after whatever it is doing). */
  deliver(target: AgentRuntime, from: string, text: string): void {
    if (!target.alive) return;
    void target.send(formatIncoming(from, text)).catch(() => {});
  }

  async stopTaskAgents(taskId: string): Promise<void> {
    for (const rt of this.agents.values()) {
      if (rt.spec.taskId === taskId) await rt.stop();
    }
  }
}
