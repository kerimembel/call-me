import fs from "node:fs";
import path from "node:path";
import type { Adapter, AgentHandle, AgentSpec, EventSink, TurnResult, Vendor } from "../types.js";

export interface MockDeps {
  hubUrl: string;
  token: string;
  /** Make the planner ask for one revision on the first review. */
  reviseOnce?: boolean;
  /** Fail the first worker turn of this vendor with a rate-limit error (tests re-routing). */
  rateLimitVendorOnce?: Vendor;
  delayMs?: number;
}

/**
 * Scripted stand-in for a real agent. It talks to the hub through the SAME HTTP
 * bus endpoint the MCP server uses, so the orchestration path is exercised
 * end-to-end without any vendor credentials.
 */
export class MockAdapter implements Adapter {
  private reviewed = new Set<string>();
  private rateLimitedOnce = false;
  constructor(readonly vendor: Vendor, private deps: MockDeps) {}

  private async bus(agentId: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await fetch(`${this.deps.hubUrl}/bus/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.deps.token}` },
      body: JSON.stringify({ agentId, tool, args }),
    });
    const body = (await res.json()) as { text?: string; error?: string };
    if (body.error) throw new Error(body.error);
    return body.text ?? "";
  }

  async create(spec: AgentSpec, sink: EventSink): Promise<AgentHandle> {
    const self = this;
    const delay = () => new Promise((r) => setTimeout(r, self.deps.delayMs ?? 20));
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      sink({ type: "agent.tool", agentId: spec.id, tool: `hub.${name}`, detail: JSON.stringify(args).slice(0, 120) });
      await delay();
      return self.bus(spec.id, name, args);
    };
    const say = (text: string) => sink({ type: "agent.text", agentId: spec.id, text });
    const usage = () => ({ inputTokens: 800 + Math.floor(Math.random() * 400), outputTokens: 150 + Math.floor(Math.random() * 100), costUsd: 0.01 });
    let stepCounter = 0;

    const handle: AgentHandle = {
      spec,
      sessionId: `mock-${spec.id}`,
      async send(text: string): Promise<TurnResult> {
        await delay();
        let out = "";
        if (spec.role === "planner") {
          if (text.startsWith("TASK from the user")) {
            say("Reading the repository and drafting a plan.");
            await tool("whoami");
            await tool("submit_plan", {
              steps: [
                { title: "Create greeting module", instructions: "Add hello.txt containing a greeting line.", vendor: "claude" },
                { title: "Add second file", instructions: "Add a second text file; ask the planner about the naming convention first.", vendor: "codex" },
              ],
            });
            out = "Plan submitted.";
          } else if (text.startsWith("[question from worker")) {
            out = "Use kebab-case: name it second-file.txt and put one line of text in it.";
            say(out);
          } else if (text.startsWith("The workers finished")) {
            const revise = self.deps.reviseOnce && !self.reviewed.has(spec.taskId);
            self.reviewed.add(spec.taskId);
            if (revise) {
              await tool("review_verdict", { verdict: "revise", notes: "Append a trailing newline to second-file.txt." });
              out = "Requested a revision.";
            } else {
              await tool("review_verdict", { verdict: "approve", notes: "Both files present, matches the plan." });
              out = "Approved.";
            }
          } else {
            out = "Noted.";
          }
        } else {
          // worker
          if (self.deps.rateLimitVendorOnce === spec.vendor && !self.rateLimitedOnce) {
            self.rateLimitedOnce = true;
            const error = "429 rate limit reached for this account";
            sink({ type: "agent.turn_done", agentId: spec.id, error });
            return { text: "", error, rateLimited: true };
          }
          if (text.startsWith("The planner reviewed your work")) {
            const f = path.join(spec.cwd, "second-file.txt");
            if (fs.existsSync(f)) fs.appendFileSync(f, "\n");
            await tool("report_status", { status: "done", summary: "Appended trailing newline to second-file.txt." });
            out = "Revision applied.";
          } else {
            stepCounter += 1;
            await tool("whoami");
            const isSecond = /YOUR STEP \(2\//.test(text);
            if (isSecond) {
              const answer = await tool("ask_planner", { question: "Which filename convention should I use for the second file?" });
              say(`Planner said: ${answer}`);
              const name = /second-file\.txt/.test(answer) ? "second-file.txt" : "second.txt";
              fs.writeFileSync(path.join(spec.cwd, name), "second line");
              await tool("report_status", { status: "done", summary: `Created ${name} as instructed by planner.` });
            } else {
              await tool("report_status", { status: "progress", summary: "Writing hello.txt" });
              fs.writeFileSync(path.join(spec.cwd, "hello.txt"), "hello from " + spec.vendor + "\n");
              await tool("report_status", { status: "done", summary: "Created hello.txt with a greeting." });
            }
            out = `Step ${stepCounter} implemented.`;
          }
        }
        const u = usage();
        sink({ type: "agent.turn_done", agentId: spec.id, usage: u });
        return { text: out, usage: u };
      },
      async interrupt() {},
    };
    return handle;
  }
}
