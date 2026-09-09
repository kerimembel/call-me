import type { AgentHandle, AgentSpec, TurnResult } from "./types.js";

/**
 * Wraps a vendor handle: serialises turns (one at a time per agent) and keeps a
 * short transcript so Telegram can tail an agent.
 */
export class AgentRuntime {
  readonly spec: AgentSpec;
  private chain: Promise<unknown> = Promise.resolve();
  busy = false;
  alive = true;
  transcript: string[] = [];
  lastTurnAt = 0;

  constructor(private handle: AgentHandle) {
    this.spec = handle.spec;
  }

  get sessionId(): string | undefined {
    return this.handle.sessionId;
  }

  send(text: string): Promise<TurnResult> {
    const run = async (): Promise<TurnResult> => {
      if (!this.alive) return { text: "", error: "agent stopped" };
      this.busy = true;
      try {
        const res = await this.handle.send(text);
        this.lastTurnAt = Date.now();
        return res;
      } catch (err) {
        return { text: "", error: (err as Error).message };
      } finally {
        this.busy = false;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  note(line: string): void {
    this.transcript.push(line);
    if (this.transcript.length > 40) this.transcript.shift();
  }

  async stop(): Promise<void> {
    this.alive = false;
    try {
      await this.handle.interrupt();
    } catch {
      /* ignore */
    }
  }
}
