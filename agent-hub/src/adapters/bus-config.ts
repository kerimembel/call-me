import path from "node:path";
import { fileURLToPath } from "node:url";

export const HUB_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_CLI = path.join(HUB_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MCP_BUS = path.join(HUB_ROOT, "src", "bus", "mcp-bus.ts");

export interface BusLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** How an agent process should launch the stdio MCP bus that talks back to the hub. */
export function busLaunch(agentId: string, hubUrl: string, token: string): BusLaunch {
  return {
    command: process.execPath,
    args: [TSX_CLI, MCP_BUS],
    env: { HUB_URL: hubUrl, HUB_AGENT_ID: agentId, HUB_TOKEN: token, PATH: process.env.PATH ?? "" },
  };
}

export const BUS_TOOL_NAMES = [
  "whoami",
  "post_message",
  "read_inbox",
  "get_quota",
  "ask_planner",
  "report_status",
  "submit_plan",
  "review_verdict",
];

export function summariseInput(input: unknown, max = 160): string {
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return "";
  }
}
