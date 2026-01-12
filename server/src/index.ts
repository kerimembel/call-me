#!/usr/bin/env bun

/**
 * CallMe MCP Server
 *
 * A stdio-based MCP server that lets Claude call you on the phone.
 * Automatically starts ngrok to expose webhooks for phone providers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import { TelegramManager } from './telegram.js';

async function main() {
  // Get port for HTTP server
  const port = parseInt(process.env.CALLME_PORT || '3333', 10);

  let publicUrl: string;

  if (process.env.PUBLIC_URL) {
    publicUrl = process.env.PUBLIC_URL;
    console.error(`Using configured PUBLIC_URL: ${publicUrl}`);
  } else {
    // Start ngrok tunnel to get public URL
    console.error('Starting ngrok tunnel...');
    try {
      publicUrl = await startNgrok(port);
      console.error(`ngrok tunnel: ${publicUrl}`);
    } catch (error) {
      console.error('Failed to start ngrok:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // Load server config with the public URL
  let serverConfig;
  try {
    serverConfig = loadServerConfig(publicUrl);
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    if (!process.env.PUBLIC_URL) await stopNgrok();
    process.exit(1);
  }

  // Initialize Telegram Manager if configured
  let telegramManager: TelegramManager | null = null;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      telegramManager = new TelegramManager({
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
      });
      console.error('Telegram bot initialized');
    } catch (error) {
      console.error('Failed to initialize Telegram bot:', error);
    }
  }

  // Create call manager and start HTTP server for webhooks
  const callManager = new CallManager(serverConfig);

  // Add API Handler for External Access
  callManager.setApiHandler(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Helper to read JSON body
    const readBody = async () => {
      return new Promise<any>((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch (e) {
            reject(e);
          }
        });
      });
    };

    if (req.method === 'POST') {
      try {
        if (url.pathname === '/api/call') {
          const body = await readBody();
          const { message } = body;
          if (!message) throw new Error('Message required');

          // Initiate call in background/promise (this might be long running if we wait for response)
          // For API, we might want to wait for response.
          const result = await callManager.initiateCall(message);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return true;
        }

        if (url.pathname === '/api/telegram/ask') {
           if (!telegramManager) throw new Error('Telegram not configured');
           const body = await readBody();
           const { message, chatId } = body;
           if (!message) throw new Error('Message required');

           const response = await telegramManager.askQuestion(message, chatId);
           res.writeHead(200, { 'Content-Type': 'application/json' });
           res.end(JSON.stringify({ response }));
           return true;
        }

        if (url.pathname === '/api/telegram/send') {
           if (!telegramManager) throw new Error('Telegram not configured');
           const body = await readBody();
           const { message, chatId } = body;
           if (!message) throw new Error('Message required');

           await telegramManager.sendMessage(message, chatId);
           res.writeHead(200, { 'Content-Type': 'application/json' });
           res.end(JSON.stringify({ status: 'ok' }));
           return true;
        }
      } catch (error) {
        console.error('API Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }));
        return true;
      }
    }

    return false;
  });

  callManager.startServer();

  // Create stdio MCP server
  const mcpServer = new Server(
    { name: 'callme', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'initiate_call',
          description: 'Start a phone call with the user. Use when you need voice input, want to report completed work, or need real-time discussion.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'What you want to say to the user. Be natural and conversational.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'continue_call',
          description: 'Continue an active call with a follow-up message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your follow-up message' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'speak_to_user',
          description: 'Speak a message on an active call without waiting for a response. Use this to acknowledge requests or provide status updates before starting time-consuming operations.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'What to say to the user' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'end_call',
          description: 'End an active call with a closing message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your closing message (say goodbye!)' },
            },
            required: ['call_id', 'message'],
          },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'initiate_call') {
        const { message } = request.params.arguments as { message: string };
        const result = await callManager.initiateCall(message);

        return {
          content: [{
            type: 'text',
            text: `Call initiated successfully.\n\nCall ID: ${result.callId}\n\nUser's response:\n${result.response}\n\nUse continue_call to ask follow-ups or end_call to hang up.`,
          }],
        };
      }

      if (request.params.name === 'continue_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const response = await callManager.continueCall(call_id, message);

        return {
          content: [{ type: 'text', text: `User's response:\n${response}` }],
        };
      }

      if (request.params.name === 'speak_to_user') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        await callManager.speakOnly(call_id, message);

        return {
          content: [{ type: 'text', text: `Message spoken: "${message}"` }],
        };
      }

      if (request.params.name === 'end_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const { durationSeconds } = await callManager.endCall(call_id, message);

        return {
          content: [{ type: 'text', text: `Call ended. Duration: ${durationSeconds}s` }],
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('');
  console.error('CallMe MCP server ready');
  console.error(`Phone: ${serverConfig.phoneNumber} -> ${serverConfig.userPhoneNumber}`);
  console.error(`Providers: phone=${serverConfig.providers.phone.name}, tts=${serverConfig.providers.tts.name}, stt=${serverConfig.providers.stt.name}`);
  console.error('');

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    callManager.shutdown();
    await stopNgrok();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
