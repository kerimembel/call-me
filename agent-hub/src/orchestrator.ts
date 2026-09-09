import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Hub } from "./hub.js";
import type { AgentRuntime } from "./runtime.js";
import { shortId } from "./store.js";
import type { PlanStep, Task, TaskStatus, Vendor } from "./types.js";
import { planPrompt, plannerSystemPrompt, reviewPrompt, revisionPrompt, workPrompt, workerSystemPrompt } from "./prompts.js";

const execFileP = promisify(execFile);

interface Waiter<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  value?: T;
  done: boolean;
}

function waiter<T>(): Waiter<T> {
  const w = { done: false } as Waiter<T>;
  w.promise = new Promise<T>((resolve) => {
    w.resolve = (v) => {
      if (w.done) return;
      w.done = true;
      w.value = v;
      resolve(v);
    };
  });
  return w;
}

type Report = { status: "done" | "failed"; summary: string };
type Verdict = { verdict: "approve" | "revise"; notes: string };

/**
 * Task lifecycle: plan (planner, top-tier model) -> work (workers, cheaper models,
 * one step at a time, vendor chosen by the quota governor) -> review (planner) ->
 * optional revision -> done.
 */
export class Orchestrator {
  private planWaiters = new Map<string, Waiter<PlanStep[]>>();
  private reportWaiters = new Map<string, Waiter<Report>>();
  private reviewWaiters = new Map<string, Waiter<Verdict>>();
  private stopped = new Set<string>();

  constructor(private hub: Hub) {}

  createTask(description: string, opts: { repoPath?: string; plannerVendor?: Vendor } = {}): Task {
    const task: Task = {
      id: shortId("task"),
      createdAt: Date.now(),
      description,
      repoPath: opts.repoPath ?? this.hub.cfg.repoPath,
      plannerVendor: opts.plannerVendor ?? this.hub.cfg.plannerVendor,
      status: "queued",
      stepResults: [],
    };
    this.hub.store.saveTask(task);
    void this.run(task);
    return task;
  }

  async stop(taskId: string): Promise<void> {
    this.stopped.add(taskId);
    await this.hub.stopTaskAgents(taskId);
    const task = this.hub.store.tasks.get(taskId);
    if (task && !["done", "failed"].includes(task.status)) this.setStatus(task, "stopped", "stopped by operator");
    this.reportWaiters.forEach((w) => w.resolve({ status: "failed", summary: "stopped" }));
    this.planWaiters.get(taskId)?.resolve([]);
    this.reviewWaiters.get(taskId)?.resolve({ verdict: "approve", notes: "stopped" });
  }

  // ---- bus callbacks -------------------------------------------------------

  onPlanSubmitted(taskId: string, steps: PlanStep[]): void {
    this.planWaiters.get(taskId)?.resolve(steps);
  }

  onWorkerReport(agentId: string, status: "progress" | "blocked" | "done" | "failed", summary: string): void {
    const rt = this.hub.agents.get(agentId);
    if (!rt) return;
    const task = this.hub.store.tasks.get(rt.spec.taskId);
    if (status === "done" || status === "failed") {
      this.reportWaiters.get(agentId)?.resolve({ status, summary });
    } else if (task) {
      this.hub.emit({ type: "task.status", taskId: task.id, status: task.status, detail: `${agentId} ${status}: ${summary}` });
    }
  }

  onReviewVerdict(taskId: string, verdict: "approve" | "revise", notes: string): void {
    this.reviewWaiters.get(taskId)?.resolve({ verdict, notes });
  }

  // ---- lifecycle -----------------------------------------------------------

  private setStatus(task: Task, status: TaskStatus, detail?: string): void {
    task.status = status;
    this.hub.store.saveTask(task);
    this.hub.emit({ type: "task.status", taskId: task.id, status, detail });
  }

  private async run(task: Task): Promise<void> {
    try {
      const planner = await this.plan(task);
      if (this.stopped.has(task.id) || !task.plan?.length) return;

      this.setStatus(task, "working");
      const summaries: string[] = [];
      let lastWorker: AgentRuntime | undefined;
      for (let i = 0; i < task.plan.length; i++) {
        if (this.stopped.has(task.id)) return;
        const step = task.plan[i];
        const outcome = await this.runStep(task, step, i, summaries);
        lastWorker = outcome.worker;
        if (outcome.report.status === "failed") {
          task.error = `step ${i + 1} failed: ${outcome.report.summary}`;
          this.setStatus(task, "failed", task.error);
          return;
        }
        summaries.push(`${step.title}: ${outcome.report.summary}`);
      }

      // Review loop
      let revisions = 0;
      task.review = [];
      while (!this.stopped.has(task.id)) {
        this.setStatus(task, "reviewing");
        const verdict = await this.review(task, planner, summaries);
        task.review.push(verdict);
        this.hub.store.saveTask(task);
        this.hub.emit({ type: "task.review", taskId: task.id, verdict: verdict.verdict, notes: verdict.notes });
        if (verdict.verdict === "approve" || revisions >= this.hub.cfg.maxRevisions || !lastWorker) break;
        revisions += 1;
        this.setStatus(task, "working", `revision ${revisions}`);
        this.hub.emit({ type: "task.step", taskId: task.id, stepIndex: task.plan.length - 1, status: "revising", agentId: lastWorker.spec.id });
        const report = await this.workerTurn(lastWorker, revisionPrompt(verdict.notes));
        summaries.push(`revision ${revisions}: ${report.summary}`);
        if (report.status === "failed") break;
      }

      const diffStat = await this.git(task.repoPath, ["diff", "--stat"]);
      task.finalSummary = [...summaries, `review: ${task.review.at(-1)?.verdict} - ${task.review.at(-1)?.notes}`, diffStat ? `\n${diffStat}` : ""].join("\n");
      this.setStatus(task, "done", task.finalSummary);
    } catch (err) {
      task.error = (err as Error).message;
      this.setStatus(task, "failed", task.error);
    }
  }

  private async plan(task: Task): Promise<AgentRuntime> {
    this.setStatus(task, "planning");
    const vendor = task.plannerVendor;
    const planner = await this.hub.spawn({
      id: shortId(`${vendor}-planner`),
      taskId: task.id,
      vendor,
      role: "planner",
      model: this.hub.modelFor(vendor, "planner"),
      cwd: task.repoPath,
      systemPrompt: plannerSystemPrompt(vendor),
    });
    task.plannerAgentId = planner.spec.id;
    this.hub.store.saveTask(task);

    const w = waiter<PlanStep[]>();
    this.planWaiters.set(task.id, w);
    const turn = await planner.send(planPrompt(task, this.hub.enabledVendors()));
    if (!w.done) {
      if (turn.error) throw new Error(`planner failed: ${turn.error}`);
      // Model answered in prose without calling the tool: nudge once.
      await planner.send("You did not call submit_plan. Call submit_plan now with the steps you described.");
    }
    if (!w.done) throw new Error("planner never submitted a plan");
    const steps = w.value ?? [];
    this.planWaiters.delete(task.id);
    task.plan = steps;
    this.hub.store.saveTask(task);
    if (steps.length) this.hub.emit({ type: "task.plan", taskId: task.id, steps });
    return planner;
  }

  private async runStep(task: Task, step: PlanStep, index: number, summaries: string[]): Promise<{ worker: AgentRuntime; report: Report }> {
    const vendors = this.hub.enabledVendors();
    const preferred = step.vendor && vendors.includes(step.vendor) ? step.vendor : vendors.find((v) => v !== task.plannerVendor) ?? vendors[0];
    let attempt = 0;
    let lastReport: Report = { status: "failed", summary: "no attempt" };
    let worker: AgentRuntime | undefined;
    let excluded: Vendor[] = [];
    while (attempt < 2) {
      attempt += 1;
      const pick = this.hub.quota.pick(preferred, vendors.filter((v) => !excluded.includes(v)));
      if (pick.rerouted) this.hub.emit({ type: "hub.info", text: `step ${index + 1} rerouted ${preferred} → ${pick.vendor}: ${pick.reason}` });
      worker = await this.hub.spawn({
        id: shortId(`${pick.vendor}-worker`),
        taskId: task.id,
        vendor: pick.vendor,
        role: "worker",
        model: this.hub.modelFor(pick.vendor, "worker"),
        cwd: task.repoPath,
        systemPrompt: workerSystemPrompt(pick.vendor),
      });
      this.hub.emit({ type: "task.step", taskId: task.id, stepIndex: index, status: "started", agentId: worker.spec.id });
      const prompt = attempt === 1 ? workPrompt(task, step, index, summaries) : `${workPrompt(task, step, index, summaries)}\n\nNote: a previous worker on another vendor was stopped by rate limits before finishing; check the working tree for partial work.`;
      const { report, rateLimited } = await this.workerTurnDetailed(worker, prompt);
      lastReport = report;
      if (rateLimited && attempt < 2) {
        excluded = [pick.vendor];
        this.hub.emit({ type: "hub.info", text: `${worker.spec.id} hit rate limits on ${pick.vendor}; retrying step ${index + 1} on another vendor` });
        await worker.stop();
        continue;
      }
      break;
    }
    task.stepResults.push({ stepIndex: index, agentId: worker!.spec.id, vendor: worker!.spec.vendor, summary: lastReport.summary, status: lastReport.status });
    this.hub.store.saveTask(task);
    this.hub.emit({ type: "task.step", taskId: task.id, stepIndex: index, status: lastReport.status, agentId: worker!.spec.id, summary: lastReport.summary });
    return { worker: worker!, report: lastReport };
  }

  private async workerTurn(worker: AgentRuntime, prompt: string): Promise<Report> {
    return (await this.workerTurnDetailed(worker, prompt)).report;
  }

  /** Send a prompt to a worker and wait for report_status(done|failed) or the turn end. */
  private async workerTurnDetailed(worker: AgentRuntime, prompt: string): Promise<{ report: Report; rateLimited: boolean }> {
    const w = waiter<Report>();
    this.reportWaiters.set(worker.spec.id, w);
    const turn = await worker.send(prompt);
    // Give a report that raced with the turn end a moment to land.
    if (!w.done) await Promise.race([w.promise, new Promise((r) => setTimeout(r, 1500))]);
    this.reportWaiters.delete(worker.spec.id);
    if (w.done && w.value) return { report: w.value, rateLimited: Boolean(turn.rateLimited) };
    if (turn.error) return { report: { status: "failed", summary: turn.error }, rateLimited: Boolean(turn.rateLimited) };
    return { report: { status: "done", summary: turn.text.slice(0, 1500) || "(no summary)" }, rateLimited: false };
  }

  private async review(task: Task, planner: AgentRuntime, summaries: string[]): Promise<Verdict> {
    const diffStat = await this.git(task.repoPath, ["diff", "--stat"]);
    const diff = await this.git(task.repoPath, ["diff"]);
    const untracked = await this.git(task.repoPath, ["ls-files", "--others", "--exclude-standard"]);
    const w = waiter<Verdict>();
    this.reviewWaiters.set(task.id, w);
    const turn = await planner.send(reviewPrompt(task, diffStat + (untracked ? `\nuntracked:\n${untracked}` : ""), diff, summaries));
    if (!w.done) await Promise.race([w.promise, new Promise((r) => setTimeout(r, 1500))]);
    this.reviewWaiters.delete(task.id);
    if (w.done && w.value) return w.value;
    if (turn.error) return { verdict: "approve", notes: `review failed (${turn.error}); auto-approved` };
    const revise = /\brevise\b|changes requested|not approved/i.test(turn.text) && !/\bapprove[d]?\b/i.test(turn.text);
    return { verdict: revise ? "revise" : "approve", notes: turn.text.slice(0, 1500) };
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return "";
    }
  }
}
