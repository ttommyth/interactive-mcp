#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
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
  .help()
  .alias('help', 'h')
  .parseSync();

const globalTimeoutSeconds = argv.timeout;
const disabledTools = argv['disable-tools']
  .split(',')
  .map((tool) => tool.trim())
  .filter(Boolean);

// Store active intensive chat sessions

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
      const { message, predefinedOptions } = args;

      const options = predefinedOptions ? [...predefinedOptions, 'Other'] : [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO: improve typing
      const requestedSchema: any = {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            title: message, // Use the message as the title for the input field
          },
        },
        required: ['answer'],
      };

      if (options.length > 0) {
        requestedSchema.properties.answer.enum = options;
      }

      const elicitationResult = await server.server.elicitInput({
        message: message, // This message is for the form itself
        requestedSchema: requestedSchema,
      });

      if (
        elicitationResult.action === 'cancel' ||
        elicitationResult.action === 'decline'
      ) {
        return {
          content: [
            { type: 'text', text: 'User cancelled or declined the input.' },
          ],
        };
      } else if (
        elicitationResult.action === 'accept' &&
        elicitationResult.content &&
        elicitationResult.content.answer !== undefined
      ) {
        let answer = elicitationResult.content.answer as string;

        if (answer === 'Other') {
          const otherResult = await server.server.elicitInput({
            message: 'Please specify your "Other" choice:',
            requestedSchema: {
              type: 'object',
              properties: {
                otherAnswer: {
                  type: 'string',
                  title: 'Your custom response',
                },
              },
              required: ['otherAnswer'],
            },
          });

          if (otherResult.action === 'accept' && otherResult.content) {
            answer = otherResult.content.otherAnswer as string;
          } else {
            return {
              content: [
                { type: 'text', text: 'User cancelled or declined the input.' },
              ],
            };
          }
        }

        if (answer === '') {
          return {
            content: [{ type: 'text', text: 'User replied with empty input.' }],
          };
        } else {
          const reply = `User replied: ${answer}`;
          return { content: [{ type: 'text', text: reply }] };
        }
      } else {
        // Fallback for unexpected elicitation response or timeout (though timeout is handled by client)
        return {
          content: [{ type: 'text', text: 'Unexpected elicitation response.' }],
        };
      }
    },
  );
}
// --- End Intensive Chat Tool Registrations ---

// Run the server over stdio
const transport = new StdioServerTransport();
await server.connect(transport);
