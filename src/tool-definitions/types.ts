import { ZodRawShape } from 'zod';

// Type for the 'capability' part as used in McpServer capabilities
export interface ToolCapabilityInfo {
  description: string;
  parameters: object; // Use z.ZodTypeAny or Record<string, any> if parameters have a known structure
}

// Type for the 'description' part provided to server.tool()
// It can be a simple string or a function that might use configuration (like timeout)
export type ToolRegistrationDescription =
  | string
  | ((timeout: number) => string);

// Define the combined structure for a single tool's definition
export interface ToolDefinition {
  capability: ToolCapabilityInfo;
  description: ToolRegistrationDescription;
  schema: ZodRawShape;
}

// Special structure for intensive chat tools, as they are grouped
export interface IntensiveChatToolDefinitions {
  start: ToolDefinition;
  ask: ToolDefinition;
  stop: ToolDefinition;
}
