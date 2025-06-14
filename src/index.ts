#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import notifier from 'node-notifier';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getCmdWindowInput } from './commands/input/index.js';
import {
  getTelegramInput,
  sendTelegramNotification,
  cleanupTelegram,
  startTelegramIntensiveChat,
  askTelegramIntensiveChat,
  stopTelegramIntensiveChat,
} from './commands/telegram/index.js';
import {
  startIntensiveChatSession,
  askQuestionInSession,
  stopIntensiveChatSession,
} from './commands/intensive-chat/index.js';
import { USER_INPUT_TIMEOUT_SECONDS } from './constants.js';

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

if (useTelegram && !process.env.TELEGRAM_BOT_TOKEN) {
  console.error(
    'Error: TELEGRAM_BOT_TOKEN environment variable is required when using --use-telegram',
  );
  process.exit(1);
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

// Create a new object with only the enabled tool capabilities
const enabledToolCapabilities = Object.fromEntries(
  Object.entries(allToolCapabilities).filter(([toolName]) => {
    return !isToolDisabled(toolName);
  }),
) as ToolCapabilitiesStructure; // Assert type after filtering

// --- End Filter Capabilities Based on Args ---

// Helper function to check if a tool should be registered (used later)
const isToolEnabled = (toolName: string): boolean => {
  // A tool is enabled if it's present in the filtered capabilities
  return toolName in enabledToolCapabilities;
};

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

      if (useTelegram) {
        // Use Telegram bot for input
        answer = await getTelegramInput(
          projectName,
          message,
          telegramTimeoutSeconds,
          telegramChatIds,
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
  // Use properties from the imported tool object
  server.tool(
    'message_complete_notification',
    // Description is a string here, but handle consistently
    typeof messageCompleteNotificationTool.description === 'function'
      ? messageCompleteNotificationTool.description(globalTimeoutSeconds) // Should not happen based on definition, but safe
      : messageCompleteNotificationTool.description,
    messageCompleteNotificationTool.schema, // Use schema property
    async (args) => {
      // Use inferred args type
      const { projectName, message } = args;

      if (useTelegram) {
        // Send Telegram notification
        await sendTelegramNotification(projectName, message, telegramChatIds);
      } else {
        // Send desktop notification
        notifier.notify({ title: projectName, message });
      }

      return {
        content: [
          {
            type: 'text',
            text: 'Notification sent. You can now wait for user input.',
          },
        ],
      };
    },
  );
}

// --- Intensive Chat Tool Registrations ---
// Each tool must be checked individually based on filtered capabilities
if (isToolEnabled('start_intensive_chat')) {
  // Use properties from the imported intensiveChatTools object
  server.tool(
    'start_intensive_chat',
    // Description is a function here
    typeof intensiveChatTools.start.description === 'function'
      ? intensiveChatTools.start.description(globalTimeoutSeconds)
      : intensiveChatTools.start.description,
    intensiveChatTools.start.schema, // Use schema property
    async (args) => {
      // Use inferred args type
      const { sessionTitle } = args;
      try {
        let sessionId: string;

        if (useTelegram) {
          // Use Telegram for intensive chat
          sessionId = `telegram-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const success = await startTelegramIntensiveChat(
            sessionId,
            'Interactive MCP',
            sessionTitle,
            telegramChatIds,
          );

          if (!success) {
            throw new Error('Failed to start Telegram intensive chat session');
          }
        } else {
          // Use terminal for intensive chat
          sessionId = await startIntensiveChatSession(
            sessionTitle,
            globalTimeoutSeconds,
          );
        }

        // Track this session for the client
        activeChatSessions.set(sessionId, sessionTitle);

        return {
          content: [
            {
              type: 'text',
              text: `Intensive chat session started successfully. Session ID: ${sessionId}`,
            },
          ],
        };
      } catch (error: unknown) {
        let errorMessage = 'Failed to start intensive chat session.';
        if (error instanceof Error) {
          errorMessage = `Failed to start intensive chat session: ${error.message}`;
        } else if (typeof error === 'string') {
          errorMessage = `Failed to start intensive chat session: ${error}`;
        }
        return {
          content: [
            {
              type: 'text',
              text: errorMessage,
            },
          ],
        };
      }
    },
  );
}

if (isToolEnabled('ask_intensive_chat')) {
  // Use properties from the imported intensiveChatTools object
  server.tool(
    'ask_intensive_chat',
    // Description is a string here
    typeof intensiveChatTools.ask.description === 'function'
      ? intensiveChatTools.ask.description(globalTimeoutSeconds) // Should not happen, but safe
      : intensiveChatTools.ask.description,
    intensiveChatTools.ask.schema, // Use schema property
    async (args) => {
      // Use inferred args type
      const { sessionId, question, predefinedOptions } = args;
      // Check if session exists
      if (!activeChatSessions.has(sessionId)) {
        return {
          content: [
            { type: 'text', text: 'Error: Invalid or expired session ID.' },
          ],
        };
      }

      try {
        let answer: string | null;

        if (useTelegram && sessionId.startsWith('telegram-')) {
          // Use Telegram for intensive chat
          answer = await askTelegramIntensiveChat(
            sessionId,
            question,
            predefinedOptions,
            telegramTimeoutSeconds,
          );
        } else {
          // Use terminal for intensive chat
          answer = await askQuestionInSession(
            sessionId,
            question,
            predefinedOptions,
          );
        }

        // Handle null response (session not found)
        if (answer === null) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: Session not found or inactive.',
              },
            ],
          };
        }

        // Check for the specific timeout indicator
        if (answer === '__TIMEOUT__') {
          return {
            content: [
              {
                type: 'text',
                text: 'User did not reply to question in intensive chat: Timeout occurred.',
              },
            ],
          };
        }
        // Empty string means user submitted empty input, non-empty is actual reply
        else if (answer === '') {
          return {
            content: [
              {
                type: 'text',
                text: 'User replied with empty input in intensive chat.',
              },
            ],
          };
        } else {
          return {
            content: [{ type: 'text', text: `User replied: ${answer}` }],
          };
        }
      } catch (error: unknown) {
        let errorMessage = 'Failed to ask question in session.';
        if (error instanceof Error) {
          errorMessage = `Failed to ask question in session: ${error.message}`;
        } else if (typeof error === 'string') {
          errorMessage = `Failed to ask question in session: ${error}`;
        }
        return {
          content: [
            {
              type: 'text',
              text: errorMessage,
            },
          ],
        };
      }
    },
  );
}

if (isToolEnabled('stop_intensive_chat')) {
  // Use properties from the imported intensiveChatTools object
  server.tool(
    'stop_intensive_chat',
    // Description is a string here
    typeof intensiveChatTools.stop.description === 'function'
      ? intensiveChatTools.stop.description(globalTimeoutSeconds) // Should not happen, but safe
      : intensiveChatTools.stop.description,
    intensiveChatTools.stop.schema, // Use schema property
    async (args) => {
      // Use inferred args type
      const { sessionId } = args;
      // Check if session exists
      if (!activeChatSessions.has(sessionId)) {
        return {
          content: [
            { type: 'text', text: 'Error: Invalid or expired session ID.' },
          ],
        };
      }

      try {
        let success: boolean;

        if (useTelegram && sessionId.startsWith('telegram-')) {
          // Use Telegram for intensive chat
          success = await stopTelegramIntensiveChat(sessionId);
        } else {
          // Use terminal for intensive chat
          success = await stopIntensiveChatSession(sessionId);
        }

        // Remove session from map if successful
        if (success) {
          activeChatSessions.delete(sessionId);
        }
        const message = success
          ? 'Session stopped successfully.'
          : 'Session not found or already stopped.';
        return { content: [{ type: 'text', text: message }] };
      } catch (error: unknown) {
        let errorMessage = 'Failed to stop intensive chat session.';
        if (error instanceof Error) {
          errorMessage = `Failed to stop intensive chat session: ${error.message}`;
        } else if (typeof error === 'string') {
          errorMessage = `Failed to stop intensive chat session: ${error}`;
        }
        return { content: [{ type: 'text', text: errorMessage }] };
      }
    },
  );
}
// --- End Intensive Chat Tool Registrations ---

// Add cleanup handler for Telegram bot
if (useTelegram) {
  process.on('SIGINT', () => {
    cleanupTelegram();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanupTelegram();
    process.exit(0);
  });
}

// Run the server over stdio
const transport = new StdioServerTransport();
await server.connect(transport);
