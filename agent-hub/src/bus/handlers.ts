import type { Hub } from "../hub.js";
import type { PlanStep, Vendor } from "../types.js";
import { shortId } from "../store.js";

export type BusArgs = Record<string, unknown>;

/**
 * Server-side implementation of the bus tools. Called from the HTTP endpoint,
 * which is called from the per-agent MCP stdio process.
 */
export async function handleBusCall(hub: Hub, agentId: string, tool: string, args: BusArgs): Promise<string> {
  const rt = hub.agents.get(agentId);
  if (!rt) throw new Error(`unknown agent ${agentId}`);
  const task = hub.store.tasks.get(rt.spec.taskId);

  switch (tool) {
    case "whoami": {
      const teammates = [...hub.agents.values()]
        .filter((a) => a.spec.taskId === rt.spec.taskId && a.spec.id !== agentId)
        .map((a) => `${a.spec.id} (${a.spec.vendor}/${a.spec.role}${a.spec.model ? `, ${a.spec.model}` : ""})`);
      return [
        `id: ${agentId}`,
        `role: ${rt.spec.role}`,
        `vendor: ${rt.spec.vendor}`,
        `model: ${rt.spec.model ?? "vendor default"}`,
        `task: ${rt.spec.taskId} - ${task?.description ?? ""}`,
        `teammates: ${teammates.length ? teammates.join("; ") : "none yet"}`,
      ].join("\n");
    }

    case "post_message": {
      const to = String(args.to ?? "");
      const text = String(args.text ?? "");
      const target = hub.agents.get(to);
      if (!target) return `no such agent: ${to}. Use whoami to list teammates.`;
      hub.store.addMessage({ id: shortId("msg"), ts: Date.now(), from: agentId, to, text, read: false });
      hub.store.emit({ type: "bus.message", from: agentId, to, text });
      hub.deliver(target, agentId, text);
      return `queued for ${to}`;
    }

    case "read_inbox": {
      const unread = hub.store.messages.filter((m) => m.to === agentId && !m.read);
      unread.forEach((m) => (m.read = true));
      if (!unread.length) return "inbox empty";
      return unread.map((m) => `[${new Date(m.ts).toISOString()}] from ${m.from}: ${m.text}`).join("\n\n");
    }

    case "get_quota": {
      const snap = hub.quota.snapshot();
      if (!snap.length) return "no usage recorded yet";
      return snap
        .map(
          (p) =>
            `${p.vendor}: turns=${p.turns} in=${p.inputTokens} out=${p.outputTokens} cost=$${p.costUsd.toFixed(3)}` +
            (p.utilizationPct !== undefined ? ` util=${p.utilizationPct}% (${p.window ?? "window"})` : "") +
            (hub.quota.isHealthy(p.vendor) ? " healthy" : ` UNHEALTHY: ${hub.quota.describeUnhealthy(p.vendor)}`),
        )
        .join("\n");
    }

    case "ask_planner": {
      if (!task?.plannerAgentId) return "no planner attached to this task";
      const planner = hub.agents.get(task.plannerAgentId);
      if (!planner) return "planner is gone";
      const question = String(args.question ?? "");
      hub.store.addMessage({ id: shortId("msg"), ts: Date.now(), from: agentId, to: planner.spec.id, text: question, read: true });
      hub.store.emit({ type: "bus.message", from: agentId, to: planner.spec.id, text: question });
      const answer = await planner.send(
        `[question from worker ${agentId} (${rt.spec.vendor})]\n${question}\n\nAnswer directly and concisely; your reply is returned to the worker as-is.`,
      );
      const text = answer.error ? `planner error: ${answer.error}` : answer.text;
      hub.store.addMessage({ id: shortId("msg"), ts: Date.now(), from: planner.spec.id, to: agentId, text, read: true });
      hub.store.emit({ type: "bus.message", from: planner.spec.id, to: agentId, text });
      return text;
    }

    case "report_status": {
      const status = String(args.status ?? "progress") as "progress" | "blocked" | "done" | "failed";
      const summary = String(args.summary ?? "");
      hub.orchestrator.onWorkerReport(agentId, status, summary);
      return status === "done" || status === "failed" ? "recorded; you may stop now." : "recorded";
    }

    case "submit_plan": {
      if (rt.spec.role !== "planner") return "only the planner can submit a plan";
      const raw = Array.isArray(args.steps) ? (args.steps as Record<string, unknown>[]) : [];
      const steps: PlanStep[] = raw
        .map((s) => ({
          title: String(s.title ?? "").trim(),
          instructions: String(s.instructions ?? "").trim(),
          vendor: s.vendor ? (String(s.vendor) as Vendor) : undefined,
        }))
        .filter((s) => s.title && s.instructions);
      if (!steps.length) return "plan rejected: no valid steps";
      hub.orchestrator.onPlanSubmitted(rt.spec.taskId, steps);
      return `plan accepted with ${steps.length} step(s). You may stop now; you will be called again for questions and review.`;
    }

    case "review_verdict": {
      if (rt.spec.role !== "planner") return "only the planner can review";
      const verdict = String(args.verdict) === "revise" ? "revise" : "approve";
      const notes = String(args.notes ?? "");
      hub.orchestrator.onReviewVerdict(rt.spec.taskId, verdict, notes);
      return "verdict recorded";
    }

    default:
      throw new Error(`unknown tool ${tool}`);
  }
}
