/**
 * Standalone MCP server (stdio) that each agent process launches.
 * It has no logic of its own: every tool call is forwarded to the hub over localhost HTTP.
 * Env: HUB_URL, HUB_AGENT_ID, HUB_TOKEN.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HUB_URL = process.env.HUB_URL ?? "http://127.0.0.1:4777";
const AGENT_ID = process.env.HUB_AGENT_ID ?? "unknown";
const TOKEN = process.env.HUB_TOKEN ?? "";

async function call(tool: string, args: Record<string, unknown>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const res = await fetch(`${HUB_URL}/bus/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agentId: AGENT_ID, tool, args }),
    });
    const body = (await res.json()) as { text?: string; error?: string };
    if (!res.ok || body.error) {
      return { content: [{ type: "text", text: `hub error: ${body.error ?? res.statusText}` }], isError: true };
    }
    return { content: [{ type: "text", text: body.text ?? "" }] };
  } catch (err) {
    return { content: [{ type: "text", text: `hub unreachable: ${(err as Error).message}` }], isError: true };
  }
}

const server = new McpServer({ name: "hub", version: "0.1.0" });

server.registerTool("whoami", { description: "Who am I: id, role, vendor, model, task, teammates." }, async () => call("whoami", {}));

server.registerTool(
  "post_message",
  {
    description: "Send a message to another agent on the team (by agent id). Delivery is asynchronous.",
    inputSchema: { to: z.string().describe("target agent id"), text: z.string() },
  },
  async ({ to, text }) => call("post_message", { to, text }),
);

server.registerTool("read_inbox", { description: "Read unread messages other agents left for you." }, async () => call("read_inbox", {}));

server.registerTool("get_quota", { description: "Usage and health of each vendor quota pool." }, async () => call("get_quota", {}));

server.registerTool(
  "ask_planner",
  {
    description: "WORKER: ask the planner a question and wait for the answer. Use when the step is ambiguous or a design decision is needed.",
    inputSchema: { question: z.string() },
  },
  async ({ question }) => call("ask_planner", { question }),
);

server.registerTool(
  "report_status",
  {
    description: "WORKER: report progress. status=done when the step is complete, failed if you cannot finish, progress/blocked otherwise.",
    inputSchema: {
      status: z.enum(["progress", "blocked", "done", "failed"]),
      summary: z.string().describe("what changed, files touched, checks run"),
    },
  },
  async ({ status, summary }) => call("report_status", { status, summary }),
);

server.registerTool(
  "submit_plan",
  {
    description: "PLANNER: submit the implementation plan. Steps run sequentially.",
    inputSchema: {
      steps: z
        .array(
          z.object({
            title: z.string(),
            instructions: z.string(),
            vendor: z.enum(["claude", "codex", "mock"]).optional().describe("preferred worker vendor"),
          }),
        )
        .min(1)
        .max(8),
    },
  },
  async ({ steps }) => call("submit_plan", { steps }),
);

server.registerTool(
  "review_verdict",
  {
    description: "PLANNER: deliver the review verdict for the workers' result.",
    inputSchema: { verdict: z.enum(["approve", "revise"]), notes: z.string() },
  },
  async ({ verdict, notes }) => call("review_verdict", { verdict, notes }),
);

await server.connect(new StdioServerTransport());
