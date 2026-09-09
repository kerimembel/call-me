// Shared types for the hub. Everything vendor-specific is normalised into these.

export type Vendor = "claude" | "codex" | "mock";
export type Role = "planner" | "worker";

export interface AgentSpec {
  id: string;
  taskId: string;
  vendor: Vendor;
  role: Role;
  /** Model id passed to the vendor. undefined = vendor default. */
  model?: string;
  cwd: string;
  systemPrompt: string;
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface TurnResult {
  text: string;
  usage?: UsageDelta;
  error?: string;
  rateLimited?: boolean;
}

/** Normalised event stream. Telegram and the log only ever see these. */
export type HubEvent =
  | { type: "agent.started"; agentId: string; taskId: string; vendor: Vendor; role: Role; model?: string }
  | { type: "agent.session"; agentId: string; sessionId: string }
  | { type: "agent.text"; agentId: string; text: string }
  | { type: "agent.tool"; agentId: string; tool: string; detail?: string }
  | { type: "agent.turn_done"; agentId: string; usage?: UsageDelta; error?: string }
  | { type: "agent.rate_limit"; agentId: string; vendor: Vendor; status: string; utilization?: number; resetsAt?: number; window?: string }
  | { type: "agent.approval"; agentId: string; tool: string; allowed: boolean }
  | { type: "bus.message"; from: string; to: string; text: string }
  | { type: "task.status"; taskId: string; status: TaskStatus; detail?: string }
  | { type: "task.plan"; taskId: string; steps: PlanStep[] }
  | { type: "task.step"; taskId: string; stepIndex: number; status: "started" | "done" | "failed" | "revising"; agentId?: string; summary?: string }
  | { type: "task.review"; taskId: string; verdict: "approve" | "revise"; notes: string }
  | { type: "hub.info"; text: string };

export type EventSink = (event: HubEvent) => void;

export interface AgentHandle {
  readonly spec: AgentSpec;
  /** Vendor session/thread id once known (for resume). */
  sessionId?: string;
  /** Run one turn. The adapter must serialise calls itself or the runtime does. */
  send(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
}

export interface Adapter {
  readonly vendor: Vendor;
  create(spec: AgentSpec, sink: EventSink): Promise<AgentHandle>;
}

export type TaskStatus = "queued" | "planning" | "working" | "reviewing" | "done" | "failed" | "stopped";

export interface PlanStep {
  title: string;
  instructions: string;
  /** Preferred vendor for the worker. Hub may override on quota grounds. */
  vendor?: Vendor;
  /** Which model tier the planner thinks this needs. */
  tier?: "worker" | "planner";
}

export interface Task {
  id: string;
  createdAt: number;
  description: string;
  repoPath: string;
  plannerVendor: Vendor;
  status: TaskStatus;
  plannerAgentId?: string;
  plan?: PlanStep[];
  stepResults: { stepIndex: number; agentId: string; vendor: Vendor; summary: string; status: "done" | "failed" }[];
  review?: { verdict: "approve" | "revise"; notes: string }[];
  finalSummary?: string;
  error?: string;
}

export interface BusMessage {
  id: string;
  ts: number;
  from: string;
  to: string;
  text: string;
  read: boolean;
}
