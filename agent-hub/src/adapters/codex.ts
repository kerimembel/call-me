import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import type { Adapter, AgentHandle, AgentSpec, EventSink, TurnResult, UsageDelta } from "../types.js";
import type { VendorConfig } from "../config.js";
import { busLaunch, summariseInput } from "./bus-config.js";
import { QuotaGovernor } from "../quota.js";

export interface CodexAdapterDeps {
  hubUrl: string;
  token: string;
  vendorCfg: VendorConfig;
}

/**
 * Codex via @openai/codex-sdk (wraps the bundled `codex` CLI, JSONL over stdio).
 * The hub MCP bus is injected with --config mcp_servers.hub.* overrides, so no
 * edits to ~/.codex/config.toml are needed.
 */
export class CodexAdapter implements Adapter {
  readonly vendor = "codex" as const;
  constructor(private deps: CodexAdapterDeps) {}

  async create(spec: AgentSpec, sink: EventSink): Promise<AgentHandle> {
    const bus = busLaunch(spec.id, this.deps.hubUrl, this.deps.token);
    const codex = new Codex({
      config: {
        mcp_servers: {
          hub: { command: bus.command, args: bus.args, env: bus.env, tool_timeout_sec: 1200 },
        },
      },
    });
    const threadOptions = {
      workingDirectory: spec.cwd,
      model: spec.model,
      sandboxMode: this.deps.vendorCfg.sandboxMode ?? ("workspace-write" as const),
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
    };
    let thread: Thread | undefined;
    let abort: AbortController | undefined;
    // Codex has no system-prompt option in the SDK; prepend the role prompt to the first turn.
    let primed = false;

    const handle: AgentHandle = {
      spec,
      sessionId: undefined,
      async send(text: string): Promise<TurnResult> {
        if (!thread) {
          thread = handle.sessionId ? codex.resumeThread(handle.sessionId, threadOptions) : codex.startThread(threadOptions);
        }
        const input = primed ? text : `${spec.systemPrompt}\n\n---\n\n${text}`;
        primed = true;
        abort = new AbortController();
        let finalText = "";
        let error: string | undefined;
        let usage: UsageDelta | undefined;
        try {
          const { events } = await thread.runStreamed(input, { signal: abort.signal });
          for await (const ev of events as AsyncGenerator<ThreadEvent>) {
            switch (ev.type) {
              case "thread.started":
                handle.sessionId = ev.thread_id;
                sink({ type: "agent.session", agentId: spec.id, sessionId: ev.thread_id });
                break;
              case "item.completed": {
                const item = ev.item;
                if (item.type === "agent_message") {
                  finalText = item.text;
                  sink({ type: "agent.text", agentId: spec.id, text: item.text });
                } else if (item.type === "command_execution") {
                  sink({ type: "agent.tool", agentId: spec.id, tool: "bash", detail: summariseInput(item.command) });
                } else if (item.type === "mcp_tool_call") {
                  sink({ type: "agent.tool", agentId: spec.id, tool: `${item.server}.${item.tool}`, detail: summariseInput(item.arguments) });
                } else if (item.type === "file_change") {
                  sink({ type: "agent.tool", agentId: spec.id, tool: "edit", detail: item.changes.map((c) => `${c.kind} ${c.path}`).join(", ") });
                } else if (item.type === "error") {
                  sink({ type: "agent.text", agentId: spec.id, text: `[error] ${item.message}` });
                }
                break;
              }
              case "turn.completed":
                usage = { inputTokens: ev.usage.input_tokens, outputTokens: ev.usage.output_tokens };
                break;
              case "turn.failed":
                error = ev.error.message;
                break;
              case "error":
                error = ev.message;
                break;
              default:
                break;
            }
          }
        } catch (err) {
          error = (err as Error).message;
        } finally {
          abort = undefined;
        }
        const rateLimited = QuotaGovernor.looksLikeRateLimit(error);
        sink({ type: "agent.turn_done", agentId: spec.id, usage, error });
        return { text: finalText, usage, error, rateLimited };
      },
      async interrupt() {
        abort?.abort();
      },
    };
    return handle;
  }
}
