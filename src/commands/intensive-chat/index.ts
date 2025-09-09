import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import logger from '../../utils/logger.js';

// Get the directory name of the current module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Interface for active session info
interface SessionInfo {
  id: string;
  process: ChildProcess;
  outputDir: string;
  lastHeartbeatTime: number;
  isActive: boolean;
  title: string;
  timeoutSeconds?: number;
}

// Global object to keep track of active intensive chat sessions
const activeSessions: Record<string, SessionInfo> = {};

// Start heartbeat monitoring for sessions
startSessionMonitoring();

/**
 * Generate a unique temporary directory path for a session
 * @returns Path to a temporary directory
 */
async function createSessionDir(): Promise<string> {
  const tempDir = os.tmpdir();
  const sessionId = crypto.randomBytes(8).toString('hex');
  const sessionDir = path.join(tempDir, `intensive-chat-${sessionId}`);

  // Create the session directory
  await fs.mkdir(sessionDir, { recursive: true });

  return sessionDir;
}

/**
 * Start an intensive chat session
 * @param title Title for the chat session
 * @param timeoutSeconds Optional timeout for each question in seconds
 * @returns Session ID for the created session
 */
export async function startIntensiveChatSession(
  title: string,
  timeoutSeconds?: number,
): Promise<string> {
  // Create a session directory
  const sessionDir = await createSessionDir();

  // Generate a unique session ID
  const sessionId = path.basename(sessionDir).replace('intensive-chat-', '');

  // Path to the UI script - Updated to use the compiled 'ui.js' filename
  const uiScriptPath = path.join(__dirname, 'ui.js');

  // Create options payload for the UI
  const options = {
    sessionId,
    title,
    outputDir: sessionDir,
    timeoutSeconds,
  };

  // Encode options as base64 payload
  const payload = Buffer.from(JSON.stringify(options)).toString('base64');

  // Platform-specific spawning
  const platform = os.platform();
  let childProcess: ChildProcess;

  if (platform === 'darwin') {
    // macOS
    // Escape potential special characters in paths/payload for the shell command
    // For the shell command executed by 'do script', we primarily need to handle spaces
    // or other characters that might break the command if paths aren't quoted.
    // The `${...}` interpolation within backticks handles basic variable insertion.
    // Quoting the paths within nodeCommand handles spaces.
    const escapedScriptPath = uiScriptPath; // Keep original path, rely on quotes below
    const escapedPayload = payload; // Keep original payload, rely on quotes below

    // Construct the command string directly for the shell. Quotes handle paths with spaces.
    const nodeBin = process.execPath;
    const nodeCommand = `exec "${nodeBin}" "${escapedScriptPath}" "${escapedPayload}"; exit 0`;

    // Escape the node command for osascript's AppleScript string:
    // 1. Escape existing backslashes (\ -> \\)
    // 2. Escape double quotes (" -> \")
    const escapedNodeCommand = nodeCommand
      // Escape backslashes first
      .replace(/\\/g, '\\\\') // Using /\\/g instead of /\/g
      // Then escape double quotes
      .replace(/"/g, '\\"');

    // Activate Terminal first, then do script with exec
    const command = `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${escapedNodeCommand}"'`;
    const commandArgs: string[] = []; // No args needed when command is a single string for shell

    // Fallback launcher using .command + open -a Terminal
    const launchViaOpenCommand = async () => {
      try {
        const launcherPath = path.join(
          sessionDir,
          `interactive-mcp-intchat-${sessionId}.command`,
        );
        const scriptContent = `#!/bin/bash\nexec "${process.execPath}" "${escapedScriptPath}" "${escapedPayload}"\n`;
        await fs.writeFile(launcherPath, scriptContent, 'utf8');
        await fs.chmod(launcherPath, 0o755);
        const openProc = spawn('open', ['-a', 'Terminal', launcherPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        });
        openProc.unref();
      } catch (e) {
        logger.error(
          { error: e },
          'Fallback open -a Terminal failed (intensive chat)',
        );
      }
    };

    childProcess = spawn(command, commandArgs, {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
      detached: true,
    });

    childProcess.on('error', () => {
      void launchViaOpenCommand();
    });
    childProcess.on('close', (code: number | null) => {
      if (code !== null && code !== 0) {
        void launchViaOpenCommand();
      }
    });
  } else if (platform === 'win32') {
    // Windows
    childProcess = spawn(process.execPath, [uiScriptPath, payload], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
      detached: true,
      windowsHide: false,
    });
  } else {
    // Linux or other - use original method (might not pop up window)
    childProcess = spawn(process.execPath, [uiScriptPath, payload], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
      detached: true,
    });
  }

  // Unref the process so it can run independently
  childProcess.unref();

  // Store session info
  activeSessions[sessionId] = {
    id: sessionId,
    process: childProcess, // Use the conditionally spawned process
    outputDir: sessionDir,
    lastHeartbeatTime: Date.now(),
    isActive: true,
    title,
    timeoutSeconds,
  };

  // Wait a bit to ensure the UI has started
  await new Promise((resolve) => setTimeout(resolve, 500));

  return sessionId;
}

/**
 * Ask a new question in an existing intensive chat session
 * @param sessionId ID of the session to ask in
 * @param question The question text to ask
 * @param predefinedOptions Optional predefined options for the question
 * @returns The user's response or null if session is not active
 */
export async function askQuestionInSession(
  sessionId: string,
  question: string,
  predefinedOptions?: string[],
): Promise<string | null> {
  const session = activeSessions[sessionId];

  if (!session || !session.isActive) {
    return null; // Session doesn't exist or is not active
  }

  // Generate a unique ID for this question-answer pair
  const questionId = crypto.randomUUID();

  // Create the input data object
  const inputData: { id: string; text: string; options?: string[] } = {
    id: questionId,
    text: question,
  };

  if (predefinedOptions && predefinedOptions.length > 0) {
    inputData.options = predefinedOptions;
  }

  // Write the combined input data to a session-specific JSON file
  const inputFilePath = path.join(session.outputDir, `${sessionId}.json`);
  await fs.writeFile(inputFilePath, JSON.stringify(inputData), 'utf8');

  // Wait for the response file corresponding to the generated ID
  const responseFilePath = path.join(
    session.outputDir,
    `response-${questionId}.txt`,
  );

  // Wait for response with timeout
  const maxWaitTime = (session.timeoutSeconds ?? 60) * 1000; // Use session timeout or default to 60s
  const pollInterval = 100; // 100ms polling interval
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    try {
      // Check if the response file exists
      await fs.access(responseFilePath);

      // Read the response
      const response = await fs.readFile(responseFilePath, 'utf8');

      // Clean up the response file
      await fs.unlink(responseFilePath).catch(() => {});

      return response;
    } catch {
      // Response file doesn't exist yet, check session status
      if (!(await isSessionActive(sessionId))) {
        return null; // Session has ended
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  // Timeout reached
  return 'User closed intensive chat session';
}

/**
 * Stop an active intensive chat session
 * @param sessionId ID of the session to stop
 * @returns True if session was stopped, false otherwise
 */
export async function stopIntensiveChatSession(
  sessionId: string,
): Promise<boolean> {
  const session = activeSessions[sessionId];

  if (!session || !session.isActive) {
    return false; // Session doesn't exist or is already inactive
  }

  // Write close signal file
  const closeFilePath = path.join(session.outputDir, 'close-session.txt');
  await fs.writeFile(closeFilePath, '', 'utf8');

  // Give the process some time to exit gracefully
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    // Force kill the process if it's still running
    if (!session.process.killed) {
      // Kill process group on Unix-like systems, standard kill on Windows
      try {
        if (os.platform() !== 'win32') {
          process.kill(-session.process.pid!, 'SIGTERM');
        } else {
          process.kill(session.process.pid!, 'SIGTERM');
        }
      } catch {
        // console.error("Error killing process:", killError);
        // Fallback or ignore if process already exited or group kill failed
      }
    }
  } catch {
    // Process might have already exited
  }

  // Mark session as inactive
  session.isActive = false;

  // Clean up session directory after a delay
  setTimeout(() => {
    // Use void to mark intentionally unhandled promise
    void (async () => {
      try {
        await fs.rm(session.outputDir, { recursive: true, force: true });
      } catch {
        // Ignore errors during cleanup
      }

      // Remove from active sessions
      delete activeSessions[sessionId];
    })();
  }, 2000);

  return true;
}

/**
 * Check if a session is still active
 * @param sessionId ID of the session to check
 * @returns True if session is active, false otherwise
 */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const session = activeSessions[sessionId];

  if (!session) {
    return false; // Session doesn't exist
  }

  if (!session.isActive) {
    return false; // Session was manually marked as inactive
  }

  try {
    // Check the heartbeat file
    const heartbeatPath = path.join(session.outputDir, 'heartbeat.txt');
    const stats = await fs.stat(heartbeatPath);

    // Check if heartbeat was updated recently (within last 2 seconds)
    const heartbeatAge = Date.now() - stats.mtime.getTime();
    if (heartbeatAge > 2000) {
      // Heartbeat is too old, session is likely dead
      session.isActive = false;
      return false;
    }

    return true;
  } catch (err: unknown) {
    // If error is ENOENT (file not found), assume session is still starting
    // Check if err is an object and has a code property before accessing it
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === 'ENOENT'
    ) {
      // Optional: Could add a check here to see if the session is very new
      // e.g., if (Date.now() - session.startTime < 2000) return true;
      // For now, let's assume ENOENT means it's possibly still starting.
      return true;
    }
    // Handle cases where err is not an object with a code property or other errors
    logger.error(
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      `Error checking heartbeat for session ${sessionId}`,
    );
    session.isActive = false;
    return false;
  }
}

/**
 * Start background monitoring of all active sessions
 */
function startSessionMonitoring() {
  // Remove async from setInterval callback
  setInterval(() => {
    // Use void to mark intentionally unhandled promise
    void (async () => {
      for (const sessionId of Object.keys(activeSessions)) {
        const isActive = await isSessionActive(sessionId);

        if (!isActive && activeSessions[sessionId]) {
          // Clean up inactive session
          try {
            // Kill process if it's somehow still running
            if (!activeSessions[sessionId].process.killed) {
              try {
                if (os.platform() !== 'win32') {
                  process.kill(
                    -activeSessions[sessionId].process.pid!,
                    'SIGTERM',
                  );
                } else {
                  process.kill(
                    activeSessions[sessionId].process.pid!,
                    'SIGTERM',
                  );
                }
              } catch {
                // console.error("Error killing process:", killError);
                // Ignore errors during cleanup
              }
            }
          } catch {
            // Ignore errors during cleanup
          }

          // Clean up session directory
          try {
            await fs.rm(activeSessions[sessionId].outputDir, {
              recursive: true,
              force: true,
            });
          } catch {
            // Ignore errors during cleanup
          }

          // Remove from active sessions
          delete activeSessions[sessionId];
        }
      }
    })();
  }, 5000); // Check every 5 seconds
}
