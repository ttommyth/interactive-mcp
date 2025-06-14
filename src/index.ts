#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import notifier from 'node-notifier';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import TelegramBot from 'node-telegram-bot-api';
import { getCmdWindowInput } from './commands/input/index.js';
import {
  getTelegramInput,
  sendTelegramNotification,
  cleanupTelegram,
  startTelegramIntensiveChat,
  askTelegramIntensiveChat,
  stopTelegramIntensiveChat,
  createTelegramInteraction,
} from './commands/telegram/index.js';
import {
  startIntensiveChatSession,
  askQuestionInSession,
  stopIntensiveChatSession,
} from './commands/intensive-chat/index.js';
import { USER_INPUT_TIMEOUT_SECONDS } from './constants.js';
import { randomUUID } from 'crypto';

// Import tool definitions using the new structure
import { requestUserInputTool } from './tool-definitions/request-user-input.js';
import { messageCompleteNotificationTool } from './tool-definitions/message-complete-notification.js';
import { intensiveChatTools } from './tool-definitions/intensive-chat.js';
// Import the types for better type checking
import { ToolCapabilityInfo } from './tool-definitions/types.js';

// --- Define Type for Tool Capabilities --- (Adjusted to use ToolCapabilityInfo)
type ToolCapabilitiesStructure = Record<string, ToolCapabilityInfo>;
// --- End Define Type ---

// --- Define Full Tool Capabilities from Imports --- (Simplified construction)
const allToolCapabilities = {
  request_user_input: requestUserInputTool.capability,
  message_complete_notification: messageCompleteNotificationTool.capability,
  start_intensive_chat: intensiveChatTools.start.capability,
  ask_intensive_chat: intensiveChatTools.ask.capability,
  stop_intensive_chat: intensiveChatTools.stop.capability,
} satisfies ToolCapabilitiesStructure;
// --- End Define Full Tool Capabilities from Imports ---

// Parse command-line arguments for global timeout
const argv = yargs(hideBin(process.argv))
  .option('timeout', {
    alias: 't',
    type: 'number',
    description: 'Default timeout for user input prompts in seconds',
    default: USER_INPUT_TIMEOUT_SECONDS,
  })
  .option('disable-tools', {
    alias: 'd',
    type: 'string',
    description:
      'Comma-separated list of tool names to disable. Available options: request_user_input, message_complete_notification, intensive_chat (disables all intensive chat tools).',
    default: '',
  })
  .option('use-telegram', {
    type: 'boolean',
    description:
      'Use Telegram bot for user interaction instead of terminal windows',
    default: false,
  })
  .option('telegram-bot-token', {
    type: 'string',
    description:
      'Telegram bot token (can also be set via TELEGRAM_BOT_TOKEN environment variable)',
    default: '',
  })
  .option('telegram-chat-ids', {
    type: 'string',
    description:
      'Comma-separated list of allowed Telegram chat IDs (required when using --use-telegram)',
    default: '',
  })
  .option('telegram-timeout', {
    type: 'number',
    description:
      'Timeout for Telegram mode (in seconds). If not specified, uses --timeout value',
  })
  .help()
  .alias('help', 'h')
  .parseSync();

const globalTimeoutSeconds = argv.timeout;
const disabledTools = argv['disable-tools']
  .split(',')
  .map((tool) => tool.trim())
  .filter(Boolean);
const useTelegram = argv['use-telegram'];
const telegramBotToken =
  argv['telegram-bot-token'] || process.env.TELEGRAM_BOT_TOKEN || '';
const telegramTimeoutSeconds = argv['telegram-timeout'] || globalTimeoutSeconds;
const telegramChatIds = argv['telegram-chat-ids']
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => parseInt(id, 10))
  .filter((id) => !isNaN(id));

// Validate Telegram configuration
if (useTelegram && telegramChatIds.length === 0) {
  console.error(
    'Error: --telegram-chat-ids is required when using --use-telegram',
  );
  process.exit(1);
}

if (useTelegram && !telegramBotToken) {
  console.error(
    'Error: --telegram-bot-token or TELEGRAM_BOT_TOKEN environment variable is required when using --use-telegram',
  );
  process.exit(1);
}

// Initialize Telegram bot if needed
let telegramBot: TelegramBot | null = null;
let telegramInteraction: ReturnType<typeof createTelegramInteraction> | null =
  null;

if (useTelegram) {
  try {
    telegramBot = new TelegramBot(telegramBotToken, { polling: true });
    telegramInteraction = createTelegramInteraction(
      telegramBot,
      telegramChatIds,
    );
    console.log(
      `Telegram bot initialized with ${telegramChatIds.length} allowed chat(s)`,
    );
  } catch (error) {
    console.error('Failed to initialize Telegram bot:', error);
    process.exit(1);
  }
}

// Store active intensive chat sessions
const activeChatSessions = new Map<string, string>();

// --- Filter Capabilities Based on Args ---
// Helper function to check if a tool is effectively disabled (directly or via group)
const isToolDisabled = (toolName: string): boolean => {
  if (disabledTools.includes(toolName)) {
    return true;
  }
  if (
    [
      // Check if tool belongs to the intensive_chat group and the group is disabled
      'start_intensive_chat',
      'ask_intensive_chat',
      'stop_intensive_chat',
    ].includes(toolName) &&
    disabledTools.includes('intensive_chat')
  ) {
    return true;
  }
  return false;
};

// Helper function to check if a tool is enabled (inverse of isToolDisabled)
const isToolEnabled = (toolName: string): boolean => !isToolDisabled(toolName);

// Filter capabilities to only include enabled tools
const enabledToolCapabilities = Object.fromEntries(
  Object.entries(allToolCapabilities).filter(([toolName]) =>
    isToolEnabled(toolName),
  ),
) as ToolCapabilitiesStructure;

// Initialize MCP server with FILTERED capabilities
const server = new McpServer({
  name: 'Interactive MCP',
  version: '1.0.0',
  capabilities: {
    tools: enabledToolCapabilities, // Use the filtered capabilities
  },
});

// Conditionally register tools based on command-line arguments

if (isToolEnabled('request_user_input')) {
  // Use properties from the imported tool object
  server.tool(
    'request_user_input',
    // Need to handle description potentially being a function
    typeof requestUserInputTool.description === 'function'
      ? requestUserInputTool.description(globalTimeoutSeconds)
      : requestUserInputTool.description,
    requestUserInputTool.schema, // Use schema property
    async (args) => {
      // Use inferred args type
      const { projectName, message, predefinedOptions } = args;

      let answer: string;

      if (useTelegram && telegramInteraction) {
        // Use Telegram bot for input
        answer = await telegramInteraction.sendInput(
          projectName,
          message,
          telegramTimeoutSeconds,
          predefinedOptions,
        );
      } else {
        // Use terminal window for input
        const promptMessage = `${projectName}: ${message}`;
        answer = await getCmdWindowInput(
          projectName,
          promptMessage,
          globalTimeoutSeconds,
          true,
          predefinedOptions,
        );
      }

      // Check for the specific timeout indicator
      if (answer === '__TIMEOUT__') {
        return {
          content: [
            { type: 'text', text: 'User did not reply: Timeout occurred.' },
          ],
        };
      }
      // Empty string means user submitted empty input, non-empty is actual reply
      else if (answer === '') {
        return {
          content: [{ type: 'text', text: 'User replied with empty input.' }],
        };
      } else {
        const reply = `User replied: ${answer}`;
        return { content: [{ type: 'text', text: reply }] };
      }
    },
  );
}

if (isToolEnabled('message_complete_notification')) {
  server.tool(
    'message_complete_notification',
    typeof messageCompleteNotificationTool.description === 'function'
      ? messageCompleteNotificationTool.description(globalTimeoutSeconds)
      : messageCompleteNotificationTool.description,
    messageCompleteNotificationTool.schema,
    async (args) => {
      const { projectName, message } = args;

      if (useTelegram && telegramInteraction) {
        // Send notification via Telegram
        await telegramInteraction.sendNotification(projectName, message);
      } else {
        // Send desktop notification
        notifier.notify({
          title: projectName,
          message: message,
          timeout: 5,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: `Notification sent: ${projectName} - ${message}`,
          },
        ],
      };
    },
  );
}

if (isToolEnabled('start_intensive_chat')) {
  server.tool(
    'start_intensive_chat',
    typeof intensiveChatTools.start.description === 'function'
      ? intensiveChatTools.start.description(globalTimeoutSeconds)
      : intensiveChatTools.start.description,
    intensiveChatTools.start.schema,
    async (args) => {
      const { sessionTitle } = args;

      if (useTelegram && telegramInteraction) {
        // Use Telegram intensive chat
        const sessionId = randomUUID();
        const success = await telegramInteraction.startIntensiveChat(
          sessionId,
          'Interactive MCP',
          sessionTitle,
        );

        if (success) {
          activeChatSessions.set(sessionId, 'telegram');
          return {
            content: [
              {
                type: 'text',
                text: `Telegram intensive chat session started successfully.\nSession ID: ${sessionId}\nTitle: ${sessionTitle}\n\nUse this session ID with ask_intensive_chat to continue the conversation.`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to start Telegram intensive chat session.',
              },
            ],
          };
        }
      } else {
        // Use terminal intensive chat
        const sessionId = await startIntensiveChatSession(
          sessionTitle,
          globalTimeoutSeconds,
        );
        activeChatSessions.set(sessionId, 'terminal');

        return {
          content: [
            {
              type: 'text',
              text: `Intensive chat session started successfully.\nSession ID: ${sessionId}\nTitle: ${sessionTitle}\n\nUse this session ID with ask_intensive_chat to continue the conversation.`,
            },
          ],
        };
      }
    },
  );
}

if (isToolEnabled('ask_intensive_chat')) {
  server.tool(
    'ask_intensive_chat',
    typeof intensiveChatTools.ask.description === 'function'
      ? intensiveChatTools.ask.description(globalTimeoutSeconds)
      : intensiveChatTools.ask.description,
    intensiveChatTools.ask.schema,
    async (args) => {
      const { sessionId, question, predefinedOptions } = args;

      const sessionType = activeChatSessions.get(sessionId);
      if (!sessionType) {
        return {
          content: [
            {
              type: 'text',
              text: `Session ${sessionId} not found. Please start a session first using start_intensive_chat.`,
            },
          ],
        };
      }

      let answer: string | null;

      if (sessionType === 'telegram' && telegramInteraction) {
        // Use Telegram intensive chat
        answer = await telegramInteraction.askInIntensiveChat(
          sessionId,
          question,
          predefinedOptions,
          telegramTimeoutSeconds,
        );
      } else {
        // Use terminal intensive chat
        answer = await askQuestionInSession(
          sessionId,
          question,
          predefinedOptions,
        );
      }

      if (answer === null) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to ask question in session ${sessionId}. Session may have been closed or is invalid.`,
            },
          ],
        };
      } else if (answer === '__TIMEOUT__') {
        return {
          content: [
            { type: 'text', text: 'User did not reply: Timeout occurred.' },
          ],
        };
      } else if (answer === '') {
        return {
          content: [{ type: 'text', text: 'User replied with empty input.' }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `User replied: ${answer}` }],
        };
      }
    },
  );
}

if (isToolEnabled('stop_intensive_chat')) {
  server.tool(
    'stop_intensive_chat',
    typeof intensiveChatTools.stop.description === 'function'
      ? intensiveChatTools.stop.description(globalTimeoutSeconds)
      : intensiveChatTools.stop.description,
    intensiveChatTools.stop.schema,
    async (args) => {
      const { sessionId } = args;

      const sessionType = activeChatSessions.get(sessionId);
      if (!sessionType) {
        return {
          content: [
            {
              type: 'text',
              text: `Session ${sessionId} not found or already closed.`,
            },
          ],
        };
      }

      let success: boolean;

      if (sessionType === 'telegram' && telegramInteraction) {
        // Stop Telegram intensive chat
        success = await telegramInteraction.stopIntensiveChat(sessionId);
      } else {
        // Stop terminal intensive chat
        success = await stopIntensiveChatSession(sessionId);
      }

      // Remove from active sessions regardless of success
      activeChatSessions.delete(sessionId);

      if (success) {
        return {
          content: [
            {
              type: 'text',
              text: `Intensive chat session ${sessionId} stopped successfully.`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to stop session ${sessionId}, but it has been removed from active sessions.`,
            },
          ],
        };
      }
    },
  );
}

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');

  // Cleanup Telegram bot
  if (telegramBot) {
    telegramBot.stopPolling();
  }

  if (telegramInteraction) {
    telegramInteraction.cleanup();
  }

  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');

  // Cleanup Telegram bot
  if (telegramBot) {
    telegramBot.stopPolling();
  }

  if (telegramInteraction) {
    telegramInteraction.cleanup();
  }

  process.exit(0);
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport);
