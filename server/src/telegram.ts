import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';

interface TelegramConfig {
  botToken: string;
  chatId?: string; // Optional default chat ID
}

export class TelegramManager {
  private bot: Telegraf;
  private pendingRequests = new Map<string, { resolve: (value: string) => void; reject: (reason?: any) => void }>();
  private activeChatId: string | null = null;

  constructor(config: TelegramConfig) {
    if (!config.botToken) {
      throw new Error('Telegram Bot Token is required');
    }
    this.bot = new Telegraf(config.botToken);
    this.activeChatId = config.chatId || null;

    this.setupBot();
  }

  private setupBot() {
    // Start command to capture chat ID
    this.bot.command('start', (ctx) => {
      this.activeChatId = ctx.chat.id.toString();
      ctx.reply('CallMe Bot is ready! I will send you messages from Claude here.');
      console.error(`[Telegram] Captured Chat ID: ${this.activeChatId}`);
    });

    // Handle text messages
    this.bot.on(message('text'), (ctx) => {
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;

      console.error(`[Telegram] Received message from ${chatId}: ${text}`);

      // Check if there is a pending request for this chat
      // For simplicity, we assume one pending request at a time globally or per chat.
      // Since we are targeting a single user scenario, global is fine, but let's try to be safe.

      // We'll iterate over pending requests and see if we can fulfill one.
      // In a more complex app, we'd need conversation tracking.
      // Here we assume the user replies to the last question.

      if (this.pendingRequests.size > 0) {
        // Resolve the oldest pending request
        const [key, promise] = this.pendingRequests.entries().next().value;
        promise.resolve(text);
        this.pendingRequests.delete(key);
      } else {
        ctx.reply("I received your message, but I wasn't waiting for one properly. Try asking me something via Claude first.");
      }
    });

    // Launch the bot (webhook or polling)
    // For simplicity in this tool, we'll use polling.
    // In a serverless environment, webhook would be better.
    this.bot.launch().catch(err => {
        console.error("Failed to launch Telegram bot", err);
    });

    // Enable graceful stop
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  public async sendMessage(text: string, chatId?: string): Promise<void> {
    const targetChatId = chatId || this.activeChatId;
    if (!targetChatId) {
      throw new Error('No Chat ID available. Send /start to the bot first.');
    }
    await this.bot.telegram.sendMessage(targetChatId, text);
  }

  public async askQuestion(text: string, chatId?: string, timeoutMs: number = 60000 * 5): Promise<string> {
    const targetChatId = chatId || this.activeChatId;
    if (!targetChatId) {
      throw new Error('No Chat ID available. Send /start to the bot first.');
    }

    await this.bot.telegram.sendMessage(targetChatId, text);

    return new Promise((resolve, reject) => {
      const requestId = Date.now().toString();
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Timeout waiting for Telegram reply'));
        }
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (val) => {
          clearTimeout(timeout);
          resolve(val);
        },
        reject: (err) => {
            clearTimeout(timeout);
            reject(err);
        }
      });
    });
  }

  public stop() {
    this.bot.stop();
  }
}
