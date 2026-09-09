import { Bot, InlineKeyboard } from "grammy";
import type { Hub } from "./hub.js";
import { handleCommand } from "./commands.js";
import { formatNotification } from "./notify.js";
import { summariseInput } from "./adapters/bus-config.js";

const MAX = 3900;

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX) out.push(text.slice(i, i + MAX));
  return out.length ? out : [""];
}

/** Telegram front-end: commands in, notifications + approval buttons out. Long polling, no public URL needed. */
export async function startTelegram(hub: Hub): Promise<Bot> {
  const { token, allowedUserIds } = hub.cfg.telegram;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const bot = new Bot(token);
  let chatId: number | undefined = hub.cfg.telegram.chatId;

  const authorised = (userId?: number) => !allowedUserIds.length || (userId !== undefined && allowedUserIds.includes(userId));

  const notify = async (text: string) => {
    if (!chatId) return;
    for (const c of chunks(text)) {
      try {
        await bot.api.sendMessage(chatId, c);
      } catch (err) {
        console.error("[telegram] send failed", (err as Error).message);
      }
    }
  };

  bot.on("message:text", async (ctx) => {
    if (!authorised(ctx.from?.id)) {
      await ctx.reply(`Yetkisiz. user id: ${ctx.from?.id}`);
      return;
    }
    chatId = ctx.chat.id;
    const reply = await handleCommand(hub, ctx.message.text);
    for (const c of chunks(reply)) await ctx.reply(c);
  });

  bot.on("callback_query:data", async (ctx) => {
    if (!authorised(ctx.from.id)) return ctx.answerCallbackQuery({ text: "yetkisiz" });
    const [kind, id, decision] = ctx.callbackQuery.data.split(":");
    if (kind === "apr") {
      const ok = hub.approvals.decide(id, decision === "allow");
      await ctx.answerCallbackQuery({ text: ok ? (decision === "allow" ? "izin verildi" : "reddedildi") : "zaman aşımı" });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    }
  });

  hub.approvals.onRequest = (p) => {
    if (!chatId) {
      hub.approvals.decide(p.id, false);
      return;
    }
    const kb = new InlineKeyboard().text("✅ İzin ver", `apr:${p.id}:allow`).text("⛔ Reddet", `apr:${p.id}:deny`);
    bot.api
      .sendMessage(chatId, `🔐 ${p.agentId} izin istiyor: ${p.tool}\n${summariseInput(p.input, 600)}`, { reply_markup: kb })
      .catch((err) => console.error("[telegram] approval send failed", (err as Error).message));
  };

  hub.store.onEvent((e) => {
    const text = formatNotification(e);
    if (text) void notify(text);
  });

  bot.catch((err) => console.error("[telegram]", err.message));
  void bot.start({ onStart: (me) => console.log(`[telegram] @${me.username} polling`) });
  return bot;
}
