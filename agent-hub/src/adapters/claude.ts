import { query, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Adapter, AgentHandle, AgentSpec, EventSink, TurnResult, UsageDelta } from "../types.js";
import type { VendorConfig } from "../config.js";
import { BUS_TOOL_NAMES, busLaunch, summariseInput } from "./bus-config.js";

export interface ClaudeAdapterDeps {
  hubUrl: string;
  token: string;
  vendorCfg: VendorConfig;
  maxTurns: number;
  /** Permission prompt handler (Telegram or auto). */
  approve: (agentId: string, tool: string, input: Record<string, unknown>) => Promise<boolean>;
}

/**
 * Claude Code via the Agent SDK. One query() per turn; the session id from the
 * first turn is passed as `resume` on later turns so the agent keeps its context.
 */
export class ClaudeAdapter implements Adapter {
  readonly vendor = "claude" as const;
  constructor(private deps: ClaudeAdapterDeps) {}

  async create(spec: AgentSpec, sink: EventSink): Promise<AgentHandle> {
    const deps = this.deps;
    const bus = busLaunch(spec.id, deps.hubUrl, deps.token);
    let current: ReturnType<typeof query> | undefined;

    const handle: AgentHandle = {
      spec,
      sessionId: undefined,
      async send(text: string): Promise<TurnResult> {
        const permissionMode = deps.vendorCfg.permissionMode ?? "acceptEdits";
        const options: Options = {
          cwd: spec.cwd,
          model: spec.model,
          resume: handle.sessionId,
          systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemPrompt },
          mcpServers: {
            hub: { type: "stdio", command: bus.command, args: bus.args, env: bus.env, timeout: 20 * 60_000, alwaysLoad: true },
          },
          allowedTools: BUS_TOOL_NAMES.map((t) => `mcp__hub__${t}`),
          permissionMode,
          allowDangerouslySkipPermissions: permissionMode === "bypassPermissions" ? true : undefined,
          maxTurns: deps.maxTurns,
          settingSources: ["project"],
          canUseTool: async (toolName, input): Promise<PermissionResult> => {
            const ok = await deps.approve(spec.id, toolName, input);
            sink({ type: "agent.approval", agentId: spec.id, tool: toolName, allowed: ok });
            return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "denied by operator via hub" };
          },
          stderr: (data) => {
            if (/error/i.test(data)) sink({ type: "agent.text", agentId: spec.id, text: `[stderr] ${data.trim().slice(0, 300)}` });
          },
        };

        const q = query({ prompt: text, options });
        current = q;
        let finalText = "";
        let error: string | undefined;
        let usage: UsageDelta | undefined;
        let rateLimited = false;

        try {
          for await (const m of q as AsyncIterable<SDKMessage>) {
            switch (m.type) {
              case "system":
                if (m.subtype === "init") {
                  handle.sessionId = m.session_id;
                  sink({ type: "agent.session", agentId: spec.id, sessionId: m.session_id });
                }
                break;
              case "assistant": {
                if (m.error === "rate_limit") rateLimited = true;
                for (const block of m.message.content) {
                  if (block.type === "text" && block.text.trim()) {
                    sink({ type: "agent.text", agentId: spec.id, text: block.text });
                  } else if (block.type === "tool_use") {
                    sink({ type: "agent.tool", agentId: spec.id, tool: block.name, detail: summariseInput(block.input) });
                  }
                }
                break;
              }
              case "rate_limit_event": {
                const info = m.rate_limit_info;
                if (info.status === "rejected") rateLimited = true;
                sink({
                  type: "agent.rate_limit",
                  agentId: spec.id,
                  vendor: "claude",
                  status: info.status,
                  utilization: info.utilization,
                  resetsAt: info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : undefined,
                  window: info.rateLimitType,
                });
                break;
              }
              case "result": {
                usage = {
                  inputTokens: Number(m.usage?.input_tokens ?? 0),
                  outputTokens: Number(m.usage?.output_tokens ?? 0),
                  costUsd: m.total_cost_usd,
                };
                if (m.subtype === "success") {
                  finalText = m.result;
                  if (m.is_error) {
                    error = m.result;
                    if (m.api_error_status === 429) rateLimited = true;
                  }
                } else {
                  error = `${m.subtype}: ${m.errors.join("; ")}`;
                }
                handle.sessionId = m.session_id;
                break;
              }
              default:
                break;
            }
          }
        } catch (err) {
          error = (err as Error).message;
        } finally {
          current = undefined;
        }
        sink({ type: "agent.turn_done", agentId: spec.id, usage, error });
        return { text: finalText, usage, error, rateLimited };
      },
      async interrupt() {
        await current?.interrupt();
      },
    };
    return handle;
  }
}
