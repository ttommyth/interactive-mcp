import React, { FC, useState, useEffect } from 'react';
import { render, Box, Text, useApp } from 'ink';
import { ProgressBar } from '@inkjs/ui';
import fs from 'fs/promises';
import path from 'path'; // Import path module
import os from 'os'; // Import os module for tmpdir
import logger from '../../utils/logger.js';
import { InteractiveInput } from '../../components/InteractiveInput.js'; // Import shared component

interface CmdOptions {
  projectName?: string;
  prompt: string;
  timeout: number;
  showCountdown: boolean;
  sessionId: string; // Should always be present now
  outputFile: string; // Should always be present now
  heartbeatFile: string; // Should always be present now
  predefinedOptions?: string[];
}

// Define defaults separately
const defaultOptions = {
  prompt: 'Enter your response:',
  timeout: 30,
  showCountdown: false,
  projectName: undefined,
  predefinedOptions: undefined,
};

// Function to read options from the file specified by sessionId
const readOptionsFromFile = async (): Promise<CmdOptions> => {
  const args = process.argv.slice(2);
  const sessionId = args[0];

  if (!sessionId) {
    logger.error('No sessionId provided. Exiting.');
    throw new Error('No sessionId provided'); // Throw error to prevent proceeding
  }

  let tempDir = args[1];
  if (!tempDir) {
    tempDir = os.tmpdir();
  }

  const optionsFilePath = path.join(
    tempDir,
    `cmd-ui-options-${sessionId}.json`,
  );

  try {
    const optionsData = await fs.readFile(optionsFilePath, 'utf8');
    const parsedOptions = JSON.parse(optionsData) as Partial<CmdOptions>; // Parse as partial

    // Validate required fields after parsing
    if (
      !parsedOptions.sessionId ||
      !parsedOptions.outputFile ||
      !parsedOptions.heartbeatFile
    ) {
      throw new Error('Required options missing in options file.');
    }

    // Merge defaults with parsed options, ensuring required fields are fully typed
    return {
      ...defaultOptions,
      ...parsedOptions,
      sessionId: parsedOptions.sessionId, // Ensure these are strings
      outputFile: parsedOptions.outputFile,
      heartbeatFile: parsedOptions.heartbeatFile,
    } as CmdOptions;
  } catch (error) {
    logger.error(
      `Failed to read or parse options file ${optionsFilePath}:`,
      error instanceof Error ? error.message : error,
    );
    // Re-throw to ensure the calling code knows initialization failed
    throw error;
  }
};

// Function to write response to output file if provided
const writeResponseToFile = async (outputFile: string, response: string) => {
  if (!outputFile) return;
  // write file in UTF-8 format, errors propagate to caller
  await fs.writeFile(outputFile, response, 'utf8');
};

// Global state for options and exit handler setup
let options: CmdOptions | null = null;
let exitHandlerAttached = false;

// Async function to initialize options and setup exit handlers
async function initialize() {
  try {
    options = await readOptionsFromFile();
    // Setup exit handlers only once after options are successfully read
    if (!exitHandlerAttached) {
      const handleExit = () => {
        if (options && options.outputFile) {
          // Write empty string to indicate abnormal exit (e.g., Ctrl+C)
          writeResponseToFile(options.outputFile, '')
            .catch((error) => {
              logger.error('Failed to write exit file:', error);
            })
            .finally(() => process.exit(0)); // Exit gracefully after attempting write
        } else {
          process.exit(0);
        }
      };

      process.on('SIGINT', handleExit);
      process.on('SIGTERM', handleExit);
      process.on('beforeExit', handleExit); // Catches graceful exits too
      exitHandlerAttached = true;
    }
  } catch (error) {
    logger.error('Initialization failed:', error);
    process.exit(1); // Exit if initialization fails
  }
}

interface AppProps {
  options: CmdOptions;
}

const App: FC<AppProps> = ({ options: appOptions }) => {
  const { exit } = useApp();
  const {
    projectName,
    prompt,
    timeout,
    showCountdown,
    outputFile,
    heartbeatFile,
    predefinedOptions,
  } = appOptions;

  const [timeLeft, setTimeLeft] = useState(timeout);

  // Clear console only once on mount
  useEffect(() => {
    console.clear();
  }, []);

  // Handle countdown and auto-exit on timeout
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          writeResponseToFile(outputFile, '__TIMEOUT__') // Use outputFile from props
            .catch((err) => logger.error('Failed to write timeout file:', err))
            .finally(() => exit()); // Use Ink's exit for timeout
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Add heartbeat interval
    let heartbeatInterval: NodeJS.Timeout | undefined;
    if (heartbeatFile) {
      heartbeatInterval = setInterval(async () => {
        try {
          // Touch the file (create if not exists, update mtime if exists)
          const now = new Date();
          await fs.utimes(heartbeatFile, now, now);
        } catch (err: unknown) {
          // If file doesn't exist, try to create it
          if (
            err &&
            typeof err === 'object' &&
            'code' in err &&
            (err as { code: string }).code === 'ENOENT'
          ) {
            try {
              await fs.writeFile(heartbeatFile, '', 'utf8');
            } catch {
              // Ignore errors creating heartbeat file (e.g., permissions)
            }
          } else {
            // Ignore other errors writing heartbeat file
          }
        }
      }, 1000); // Update every second
    }

    return () => {
      clearInterval(timer);
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
    };
  }, [exit, outputFile, heartbeatFile, timeout]); // Added timeout to dependencies

  // Handle final submission
  const handleSubmit = (value: string) => {
    logger.debug(`User submitted: ${value}`);
    writeResponseToFile(outputFile, value) // Use outputFile from props
      .catch((err) => logger.error('Failed to write response file:', err))
      .finally(() => {
        exit(); // Use Ink's exit for normal submission
      });
  };

  // Wrapper for handleSubmit to match the signature of InteractiveInput's onSubmit
  const handleInputSubmit = (_questionId: string, value: string) => {
    handleSubmit(value);
  };

  const progressValue = (timeLeft / timeout) * 100;

  return (
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor="blue"
    >
      {projectName && (
        <Box marginBottom={1} justifyContent="center">
          <Text bold color="magenta">
            {projectName}
          </Text>
        </Box>
      )}
      <InteractiveInput
        question={prompt}
        questionId={prompt}
        predefinedOptions={predefinedOptions}
        onSubmit={handleInputSubmit}
      />
      {showCountdown && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Time remaining: {timeLeft}s</Text>
          <ProgressBar value={progressValue} />
        </Box>
      )}
    </Box>
  );
};

// Initialize and render the app
initialize()
  .then(() => {
    if (options) {
      render(<App options={options} />);
    } else {
      // This case should theoretically not be reached due to error handling in initialize
      logger.error('Options could not be initialized. Cannot render App.');
      process.exit(1);
    }
  })
  .catch(() => {
    // Error already logged in initialize or readOptionsFromFile
    process.exit(1);
  });
