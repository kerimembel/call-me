import fs from "node:fs";
import path from "node:path";
import type { Vendor } from "./types.js";

export interface VendorConfig {
  /** Model for the decision-maker role (Fable, Astra-class). undefined = vendor default. */
  planner?: string;
  /** Model for implementation work (cheaper tier). undefined = vendor default. */
  worker?: string;
  /** Claude only: permissionMode for query(). */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
  /** Codex only: sandbox mode for threads. */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  enabled?: boolean;
}

export interface HubConfig {
  repoPath: string;
  plannerVendor: Vendor;
  vendors: Partial<Record<Vendor, VendorConfig>>;
  quota: { maxUtilizationPct: number; cooldownMinutes: number };
  maxRevisions: number;
  maxTurnsPerAgent: number;
  /** "telegram": Claude permission prompts go to Telegram. "auto": allow everything the mode allows. */
  approvals: "telegram" | "auto";
  bus: { host: string; port: number };
  telegram: { token?: string; allowedUserIds: number[]; chatId?: number };
  mock: boolean;
  noTelegram: boolean;
  stateDir: string;
}

const DEFAULTS: HubConfig = {
  repoPath: process.cwd(),
  plannerVendor: "claude",
  vendors: {
    claude: { planner: "claude-fable-5-1", worker: "claude-sonnet-5", permissionMode: "acceptEdits", enabled: true },
    codex: { sandboxMode: "workspace-write", enabled: true },
  },
  quota: { maxUtilizationPct: 85, cooldownMinutes: 20 },
  maxRevisions: 1,
  maxTurnsPerAgent: 60,
  approvals: "telegram",
  bus: { host: "127.0.0.1", port: 4777 },
  telegram: { allowedUserIds: [] },
  mock: false,
  noTelegram: false,
  stateDir: ".hub",
};

export function loadConfig(root = process.cwd()): HubConfig {
  const file = process.env.HUB_CONFIG ?? path.join(root, "hub.config.json");
  let fromFile: Partial<HubConfig> = {};
  if (fs.existsSync(file)) {
    fromFile = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const cfg: HubConfig = {
    ...DEFAULTS,
    ...fromFile,
    vendors: { ...DEFAULTS.vendors, ...(fromFile.vendors ?? {}) },
    quota: { ...DEFAULTS.quota, ...(fromFile.quota ?? {}) },
    bus: { ...DEFAULTS.bus, ...(fromFile.bus ?? {}) },
    telegram: { ...DEFAULTS.telegram, ...(fromFile.telegram ?? {}) },
  };

  if (process.env.HUB_REPO) cfg.repoPath = process.env.HUB_REPO;
  if (process.env.HUB_BUS_PORT) cfg.bus.port = Number(process.env.HUB_BUS_PORT);
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegram.token = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_ALLOWED_USER_IDS) {
    cfg.telegram.allowedUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS.split(",").map((s) => Number(s.trim())).filter(Boolean);
  }
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegram.chatId = Number(process.env.TELEGRAM_CHAT_ID);
  if (process.env.HUB_MOCK === "1") cfg.mock = true;
  if (process.env.HUB_NO_TELEGRAM === "1") cfg.noTelegram = true;
  if (process.env.HUB_APPROVALS === "auto") cfg.approvals = "auto";
  if (process.env.HUB_PLANNER_VENDOR) cfg.plannerVendor = process.env.HUB_PLANNER_VENDOR as Vendor;

  cfg.repoPath = path.resolve(cfg.repoPath);
  cfg.stateDir = path.resolve(root, cfg.stateDir);
  if (cfg.mock) {
    cfg.vendors = { mock: { planner: "mock-super", worker: "mock-small", enabled: true }, ...cfg.vendors };
    cfg.plannerVendor = "mock";
    cfg.approvals = "auto";
  }
  return cfg;
}
