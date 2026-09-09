import readline from "node:readline";
import type { Hub } from "./hub.js";
import { handleCommand, HELP } from "./commands.js";
import { formatNotification } from "./notify.js";

/** Stdin fallback when Telegram is disabled: same commands, printed notifications. */
export function startConsole(hub: Hub): void {
  hub.store.onEvent((e) => {
    const text = formatNotification(e);
    if (text) console.log(text);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "hub> " });
  console.log(HELP);
  rl.prompt();
  rl.on("line", async (line) => {
    if (line.trim()) console.log(await handleCommand(hub, line));
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}
