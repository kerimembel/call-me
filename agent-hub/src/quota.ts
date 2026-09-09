import type { HubConfig } from "./config.js";
import type { UsageDelta, Vendor } from "./types.js";

export interface VendorQuota {
  vendor: Vendor;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /** Last utilisation % reported by the vendor (Claude subscription windows), if any. */
  utilizationPct?: number;
  window?: string;
  resetsAt?: number;
  /** Set when the vendor rejected us (429 / plan limit). Routing avoids it until then. */
  cooldownUntil?: number;
  lastError?: string;
}

/**
 * Quota Governor. All agents of one vendor share one pool (same account),
 * so we track per vendor, not per agent. Signals:
 *  - token/cost usage from result events (all vendors)
 *  - rate_limit events with utilisation % (Claude subscription)
 *  - 429 / "rate limit" errors (any vendor) -> cooldown
 */
export class QuotaGovernor {
  private pools = new Map<Vendor, VendorQuota>();

  constructor(private cfg: HubConfig) {}

  pool(vendor: Vendor): VendorQuota {
    let p = this.pools.get(vendor);
    if (!p) {
      p = { vendor, inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 };
      this.pools.set(vendor, p);
    }
    return p;
  }

  recordUsage(vendor: Vendor, usage?: UsageDelta): void {
    const p = this.pool(vendor);
    p.turns += 1;
    if (!usage) return;
    p.inputTokens += usage.inputTokens;
    p.outputTokens += usage.outputTokens;
    p.costUsd += usage.costUsd ?? 0;
  }

  recordRateLimit(vendor: Vendor, info: { status: string; utilization?: number; resetsAt?: number; window?: string }): void {
    const p = this.pool(vendor);
    if (info.utilization !== undefined) p.utilizationPct = info.utilization;
    if (info.window) p.window = info.window;
    if (info.resetsAt) p.resetsAt = info.resetsAt;
    if (info.status === "rejected") this.markRejected(vendor, info.resetsAt);
  }

  markRejected(vendor: Vendor, resetsAt?: number, error?: string): void {
    const p = this.pool(vendor);
    const fallback = Date.now() + this.cfg.quota.cooldownMinutes * 60_000;
    p.cooldownUntil = resetsAt && resetsAt > Date.now() ? resetsAt : fallback;
    if (error) p.lastError = error.slice(0, 200);
  }

  isHealthy(vendor: Vendor): boolean {
    const p = this.pool(vendor);
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) return false;
    if (p.utilizationPct !== undefined && p.utilizationPct >= this.cfg.quota.maxUtilizationPct) return false;
    return true;
  }

  /** Pick a vendor: preferred if healthy, else the first healthy alternative, else preferred anyway. */
  pick(preferred: Vendor, alternatives: Vendor[]): { vendor: Vendor; rerouted: boolean; reason?: string } {
    if (this.isHealthy(preferred)) return { vendor: preferred, rerouted: false };
    for (const alt of alternatives) {
      if (alt !== preferred && this.isHealthy(alt)) {
        return { vendor: alt, rerouted: true, reason: this.describeUnhealthy(preferred) };
      }
    }
    return { vendor: preferred, rerouted: false, reason: `no healthy alternative; ${this.describeUnhealthy(preferred)}` };
  }

  describeUnhealthy(vendor: Vendor): string {
    const p = this.pool(vendor);
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) {
      return `${vendor} cooling down until ${new Date(p.cooldownUntil).toISOString()}`;
    }
    if (p.utilizationPct !== undefined) return `${vendor} at ${p.utilizationPct}% of ${p.window ?? "window"}`;
    return `${vendor} unhealthy`;
  }

  snapshot(): VendorQuota[] {
    return [...this.pools.values()];
  }

  static looksLikeRateLimit(text: string | undefined): boolean {
    if (!text) return false;
    return /rate.?limit|429|usage limit|quota|too many requests|hit your limit|limit reached/i.test(text);
  }
}
