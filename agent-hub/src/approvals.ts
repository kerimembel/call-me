import { shortId } from "./store.js";

export interface PendingApproval {
  id: string;
  agentId: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (ok: boolean) => void;
  createdAt: number;
}

/**
 * Routes tool-permission prompts (Claude canUseTool) to a human. In "auto" mode
 * everything is allowed; otherwise a UI (Telegram) must call decide().
 */
export class Approvals {
  pending = new Map<string, PendingApproval>();
  /** Set by the UI layer; called when a new prompt needs a human. */
  onRequest?: (p: PendingApproval) => void;

  constructor(private mode: "telegram" | "auto", private timeoutMs = 15 * 60_000) {}

  request(agentId: string, tool: string, input: Record<string, unknown>): Promise<boolean> {
    if (this.mode === "auto" || !this.onRequest) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const id = shortId("apr");
      const p: PendingApproval = { id, agentId, tool, input, resolve, createdAt: Date.now() };
      this.pending.set(id, p);
      const timer = setTimeout(() => this.decide(id, false), this.timeoutMs);
      p.resolve = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.onRequest?.(p);
    });
  }

  decide(id: string, ok: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(ok);
    return true;
  }
}
