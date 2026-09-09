import type { Hub } from "./hub.js";
import type { Vendor } from "./types.js";

export const HELP = `Komutlar:
/task <açıklama> [--planner claude|codex] [--repo /path]  yeni görev başlat
/status            görevler ve durumları
/agents            çalışan agent'lar
/tail <agentId>    agent'ın son çıktıları
/say <agentId> <mesaj>   bir agent'a doğrudan mesaj gönder
/quota             vendor kota havuzları
/stop <taskId>     görevi durdur
/repo <path>       varsayılan repo yolunu değiştir
/help`;

/** Shared command parser used by Telegram and the stdin console. */
export async function handleCommand(hub: Hub, raw: string): Promise<string> {
  const text = raw.trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.replace(/@\w+$/, "").toLowerCase();
  const arg = text.slice(cmdRaw.length).trim();

  switch (cmd) {
    case "/start":
    case "/help":
      return HELP;

    case "/task": {
      if (!arg) return "Kullanım: /task <açıklama> [--planner claude|codex] [--repo /path]";
      let description = arg;
      let plannerVendor: Vendor | undefined;
      let repoPath: string | undefined;
      const planner = description.match(/--planner[= ](\w+)/);
      if (planner) {
        plannerVendor = planner[1] as Vendor;
        description = description.replace(planner[0], "");
      }
      const repo = description.match(/--repo[= ](\S+)/);
      if (repo) {
        repoPath = repo[1];
        description = description.replace(repo[0], "");
      }
      description = description.trim();
      if (plannerVendor && !hub.adapters.has(plannerVendor)) return `vendor ${plannerVendor} etkin değil. Etkin: ${hub.enabledVendors().join(", ")}`;
      const task = hub.orchestrator.createTask(description, { plannerVendor, repoPath });
      return `Görev ${task.id} başladı.\nPlanner: ${task.plannerVendor} (${hub.modelFor(task.plannerVendor, "planner") ?? "varsayılan model"})\nRepo: ${task.repoPath}`;
    }

    case "/status": {
      const tasks = [...hub.store.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
      if (!tasks.length) return "Görev yok.";
      return tasks
        .map((t) => {
          const steps = t.plan ? ` ${t.stepResults.filter((s) => s.status === "done").length}/${t.plan.length} adım` : "";
          return `${t.id} [${t.status}]${steps} - ${t.description.slice(0, 80)}${t.error ? `\n  ⚠ ${t.error.slice(0, 200)}` : ""}`;
        })
        .join("\n");
    }

    case "/agents": {
      const agents = [...hub.agents.values()];
      if (!agents.length) return "Agent yok.";
      return agents
        .map((a) => `${a.spec.id} ${a.spec.vendor}/${a.spec.role} ${a.spec.model ?? ""} ${a.busy ? "⏳ çalışıyor" : a.alive ? "idle" : "durdu"} task=${a.spec.taskId}`)
        .join("\n");
    }

    case "/tail": {
      const rt = hub.agents.get(rest[0] ?? "");
      if (!rt) return "agent bulunamadı";
      return rt.transcript.slice(-10).join("\n---\n").slice(-3500) || "(boş)";
    }

    case "/say": {
      const [agentId, ...words] = rest;
      const rt = hub.agents.get(agentId ?? "");
      if (!rt) return "agent bulunamadı";
      const msg = words.join(" ");
      if (!msg) return "mesaj boş";
      void rt.send(`[message from operator]\n${msg}`).then((r) => {
        hub.emit({ type: "hub.info", text: `${agentId} → operator: ${(r.error ?? r.text).slice(0, 1500)}` });
      });
      return `${agentId} kuyruğuna eklendi`;
    }

    case "/quota": {
      const snap = hub.quota.snapshot();
      const vendors = hub.enabledVendors();
      const lines = vendors.map((v) => {
        const p = snap.find((s) => s.vendor === v);
        const health = hub.quota.isHealthy(v) ? "✅" : `⛔ ${hub.quota.describeUnhealthy(v)}`;
        if (!p) return `${v}: kullanım yok ${health}`;
        return `${v}: ${p.turns} tur, in ${p.inputTokens} / out ${p.outputTokens} tok, ~$${p.costUsd.toFixed(3)}${p.utilizationPct !== undefined ? `, ${p.utilizationPct}% (${p.window})` : ""} ${health}`;
      });
      return lines.join("\n");
    }

    case "/stop": {
      const id = rest[0];
      if (!id || !hub.store.tasks.has(id)) return "task bulunamadı";
      await hub.orchestrator.stop(id);
      return `${id} durduruldu`;
    }

    case "/repo": {
      if (!arg) return `Repo: ${hub.cfg.repoPath}`;
      hub.cfg.repoPath = arg;
      return `Repo: ${arg}`;
    }

    default:
      return text.startsWith("/") ? `bilinmeyen komut. ${HELP}` : `Komut için / ile başla. ${HELP}`;
  }
}
