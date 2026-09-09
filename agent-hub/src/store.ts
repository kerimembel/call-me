import fs from "node:fs";
import path from "node:path";
import type { BusMessage, HubEvent, Task } from "./types.js";

/** Tiny persistence: tasks in state.json, events appended to events.jsonl. Good enough for a POC. */
export class Store {
  tasks = new Map<string, Task>();
  messages: BusMessage[] = [];
  private eventsFile: string;
  private stateFile: string;
  private listeners = new Set<(e: HubEvent) => void>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.eventsFile = path.join(dir, "events.jsonl");
    this.stateFile = path.join(dir, "state.json");
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
        for (const t of raw.tasks ?? []) this.tasks.set(t.id, t);
        this.messages = raw.messages ?? [];
      } catch {
        /* corrupt state: start fresh */
      }
    }
  }

  onEvent(fn: (e: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: HubEvent): void {
    const line = JSON.stringify({ ts: Date.now(), ...event });
    fs.appendFile(this.eventsFile, line + "\n", () => {});
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("[store] listener error", err);
      }
    }
  }

  saveTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.flush();
  }

  addMessage(msg: BusMessage): void {
    this.messages.push(msg);
    if (this.messages.length > 2000) this.messages.splice(0, this.messages.length - 2000);
    this.flush();
  }

  private flush(): void {
    const data = { tasks: [...this.tasks.values()], messages: this.messages };
    fs.writeFile(this.stateFile, JSON.stringify(data, null, 2), () => {});
  }
}

export function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
