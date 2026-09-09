import type { HubEvent } from "./types.js";

/** Turn hub events into short human-readable notifications. Returns undefined for noise. */
export function formatNotification(e: HubEvent): string | undefined {
  switch (e.type) {
    case "task.status":
      return `📋 ${e.taskId}: ${e.status}${e.detail ? `\n${e.detail.slice(0, 1500)}` : ""}`;
    case "task.plan":
      return `🧠 ${e.taskId} plan (${e.steps.length} adım):\n` + e.steps.map((s, i) => `${i + 1}. ${s.title}${s.vendor ? ` [${s.vendor}]` : ""}`).join("\n");
    case "task.step":
      if (e.status === "started") return `▶️ adım ${e.stepIndex + 1} başladı → ${e.agentId}`;
      if (e.status === "revising") return `🔁 revizyon → ${e.agentId}`;
      return `${e.status === "done" ? "✅" : "❌"} adım ${e.stepIndex + 1} ${e.status} (${e.agentId})${e.summary ? `\n${e.summary.slice(0, 800)}` : ""}`;
    case "task.review":
      return `${e.verdict === "approve" ? "👍" : "✍️"} review: ${e.verdict}\n${e.notes.slice(0, 800)}`;
    case "bus.message":
      return `💬 ${e.from} → ${e.to}:\n${e.text.slice(0, 600)}`;
    case "agent.started":
      return `🤖 ${e.agentId} başladı (${e.vendor}/${e.role}${e.model ? `, ${e.model}` : ""})`;
    case "agent.rate_limit":
      if (e.status === "allowed" && (e.utilization ?? 0) < 70) return undefined;
      return `⚠️ ${e.vendor} limit: ${e.status}${e.utilization !== undefined ? ` ${e.utilization}%` : ""}${e.window ? ` (${e.window})` : ""}${e.resetsAt ? ` reset ${new Date(e.resetsAt).toLocaleTimeString()}` : ""}`;
    case "agent.turn_done":
      return e.error ? `❗ ${e.agentId}: ${e.error.slice(0, 400)}` : undefined;
    case "agent.approval":
      return `${e.allowed ? "🔓" : "🔒"} ${e.agentId} ${e.tool} ${e.allowed ? "izin verildi" : "reddedildi"}`;
    case "hub.info":
      return `ℹ️ ${e.text.slice(0, 1500)}`;
    default:
      return undefined;
  }
}
