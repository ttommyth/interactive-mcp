import React, { FC, useState, useEffect, useRef } from 'react';
import { render, Box, Text, useApp } from 'ink';
import { ProgressBar } from '@inkjs/ui';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { InteractiveInput } from '@/components/InteractiveInput.js';
import { USER_INPUT_TIMEOUT_SECONDS } from '@/constants.js'; // Import the constant
import logger from '../../utils/logger.js';

// Interface for chat message
interface ChatMessage {
  text: string;
  isQuestion: boolean;
  answer?: string;
}

// Parse command line arguments from a single JSON-encoded argument
const parseArgs = () => {
  const args = process.argv.slice(2);
  const defaults = {
    sessionId: crypto.randomUUID(),
    title: 'Interactive Chat Session',
    outputDir: undefined as string | undefined,
    timeoutSeconds: USER_INPUT_TIMEOUT_SECONDS,
  };

  if (args[0]) {
    try {
      // Decode base64-encoded JSON payload to avoid quoting issues
      const decoded = Buffer.from(args[0], 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return { ...defaults, ...parsed };
    } catch (e) {
      logger.error('Invalid input options payload, using defaults.', e);
    }
  }
  return defaults;
};

// Get command line arguments
const options = parseArgs();

// Function to write response to output file
const writeResponseToFile = async (questionId: string, response: string) => {
  if (!options.outputDir) return;

  // Create response file path
  const responseFilePath = path.join(
    options.outputDir,
    `response-${questionId}.txt`,
  );

  // Write file in UTF-8 format
  await fs.writeFile(responseFilePath, response, 'utf8');

  //wait 500 ms
  await new Promise((resolve) => setTimeout(resolve, 500));
};

// Create a heartbeat file to indicate the session is still active
const updateHeartbeat = async () => {
  if (!options.outputDir) return;

  const heartbeatPath = path.join(options.outputDir, 'heartbeat.txt');
  try {
    const dir = path.dirname(heartbeatPath);
    await fs.mkdir(dir, { recursive: true }); // Ensure directory exists
    await fs.writeFile(heartbeatPath, Date.now().toString(), 'utf8');
  } catch (writeError) {
    // Log the specific error but allow the poll cycle to continue
    logger.error(
      `Failed to write heartbeat file ${heartbeatPath}:`,
      writeError,
    );
  }
};

// Register process termination handlers
const handleExit = () => {
  if (options.outputDir) {
    // Write exit file to indicate session has ended
    fs.writeFile(path.join(options.outputDir, 'session-closed.txt'), '', 'utf8')
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error('Failed to write exit file:', error);
        process.exit(1);
      });
  } else {
    process.exit(0);
  }
};

// Listen for termination signals
process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);
process.on('beforeExit', handleExit);

interface AppProps {
  sessionId: string;
  title: string;
  outputDir?: string;
  timeoutSeconds: number;
}

const App: FC<AppProps> = ({ sessionId, title, outputDir, timeoutSeconds }) => {
  // console.clear(); // Clear console before rendering UI - Removed from here
  const { exit: appExit } = useApp();
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(
    null,
  );
  const [currentPredefinedOptions, setCurrentPredefinedOptions] = useState<
    string[] | undefined
  >(undefined);
  const [timeLeft, setTimeLeft] = useState<number | null>(null); // State for countdown timer
  const timerRef = useRef<NodeJS.Timeout | null>(null); // Ref to hold timer ID

  // Clear console only once on mount
  useEffect(() => {
    console.clear();
  }, []); // Empty dependency array ensures this runs only once

  // Check for new questions periodically
  useEffect(() => {
    // Set up polling for new inputs
    const questionPoller = setInterval(async () => {
      if (!outputDir) return;

      try {
        // Update heartbeat to indicate we're still running
        await updateHeartbeat();

        // Look for the session-specific input file
        const inputFilePath = path.join(outputDir, `${sessionId}.json`);

        // Check if new input file exists
        try {
          const inputExists = await fs.stat(inputFilePath);

          if (inputExists) {
            // Read input file content
            const inputFileContent = await fs.readFile(inputFilePath, 'utf8');
            let questionId: string | null = null;
            let questionText: string | null = null;
            let options: string[] | undefined = undefined;

            try {
              // Parse input file content as JSON { id: string, text: string, options?: string[] }
              const inputData = JSON.parse(inputFileContent);
              if (
                typeof inputData === 'object' &&
                inputData !== null &&
                typeof inputData.id === 'string' &&
                typeof inputData.text === 'string' &&
                (inputData.options === undefined ||
                  Array.isArray(inputData.options))
              ) {
                questionId = inputData.id;
                questionText = inputData.text;
                // Ensure options are strings if they exist
                options = Array.isArray(inputData.options)
                  ? inputData.options.map(String)
                  : undefined;
              } else {
                logger.error(
                  `Invalid format in ${sessionId}.json. Expected JSON with id (string), text (string), and optional options (array).`,
                );
              }
            } catch (parseError) {
              logger.error(
                `Error parsing ${sessionId}.json as JSON:`,
                parseError,
              );
            }

            // Proceed only if we successfully parsed the question ID and text
            if (questionId && questionText) {
              // Add question to chat using the ID and options from the file
              addNewQuestion(questionId, questionText, options);

              // Delete the input file
              await fs.unlink(inputFilePath);
            } else {
              // If parsing failed or format was invalid, delete the problematic file
              logger.error(`Deleting invalid input file: ${inputFilePath}`);
              await fs.unlink(inputFilePath);
            }
          }
        } catch (e: unknown) {
          // Type guard to check if it's an error with a code property
          if (
            typeof e === 'object' &&
            e !== null &&
            'code' in e &&
            (e as { code: unknown }).code !== 'ENOENT'
          ) {
            logger.error(
              `Error checking/reading input file ${inputFilePath}:`,
              e,
            );
          }
          // If it's not an error with a code or the code is ENOENT, we ignore it silently.
        }

        // Check if we should exit
        const closeFilePath = path.join(outputDir, 'close-session.txt');
        try {
          await fs.stat(closeFilePath);
          // If close file exists, exit the process
          handleExit();
        } catch {
          // No close request
        }
      } catch (error) {
        logger.error('Error in poll cycle:', error);
      }
    }, 100);

    return () => clearInterval(questionPoller);
  }, [outputDir, sessionId]);

  // Countdown timer effect
  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0 || !currentQuestionId) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return; // No timer needed or timer expired
    }

    // Start timer if not already running
    if (!timerRef.current) {
      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => (prev !== null ? prev - 1 : null));
      }, 1000);
    }

    // Check if timer reached zero
    if (timeLeft <= 0 && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
      // Auto-submit timeout indicator on timeout
      handleSubmit(currentQuestionId, '__TIMEOUT__');
    }

    // Cleanup function to clear interval on unmount or when dependencies change
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [timeLeft, currentQuestionId]); // Rerun effect when timeLeft or currentQuestionId changes

  // Add a new question to the chat
  const addNewQuestion = (
    questionId: string,
    questionText: string,
    options?: string[],
  ) => {
    console.clear(); // Clear console before displaying new question
    // Clear existing timer before starting new one
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    setChatHistory((prev) => [
      ...prev,
      {
        text: questionText,
        isQuestion: true,
      },
    ]);

    setCurrentQuestionId(questionId);
    setCurrentPredefinedOptions(options);
    setTimeLeft(timeoutSeconds); // Use timeout from props
  };

  // Handle user submitting an answer
  const handleSubmit = async (questionId: string, value: string) => {
    // Clear the timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setTimeLeft(null); // Reset timer state

    // Update the chat history with the answer
    setChatHistory((prev) =>
      prev.map((msg) => {
        // Find the last question in history that matches the ID and doesn't have an answer yet
        // Use slice().reverse().find() for broader compatibility instead of findLast()
        if (
          msg.isQuestion &&
          !msg.answer &&
          msg ===
            prev
              .slice()
              .reverse()
              .find((m: ChatMessage) => m.isQuestion && !m.answer)
        ) {
          return { ...msg, answer: value };
        }
        return msg;
      }),
    );

    // Reset current question state
    setCurrentQuestionId(null);
    setCurrentPredefinedOptions(undefined);

    // Write response to file
    if (outputDir) {
      await writeResponseToFile(questionId, value);
    }
  };

  // Calculate progress bar value (moved slightly down, renamed to percentage)
  const percentage = timeLeft !== null ? (timeLeft / timeoutSeconds) * 100 : 0; // Use timeout from props

  return (
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor="blue"
    >
      <Box marginBottom={1} flexDirection="column" width="100%">
        <Text bold color="magentaBright" wrap="wrap">
          {title}
        </Text>
        <Text color="gray">Session ID: {sessionId}</Text>
        <Text color="gray">Press Ctrl+C to exit the chat session</Text>
      </Box>

      <Box flexDirection="column" width="100%">
        {/* Chat history */}
        {chatHistory.map((msg, i) => (
          <Box key={i} flexDirection="column" marginY={1}>
            {msg.isQuestion ? (
              <Text color="cyan" wrap="wrap">
                Q: {msg.text}
              </Text>
            ) : null}
            {msg.answer ? (
              <Text color="green" wrap="wrap">
                A: {msg.answer}
              </Text>
            ) : null}
          </Box>
        ))}
      </Box>

      {/* Current question input */}
      {currentQuestionId && (
        <Box
          flexDirection="column"
          marginTop={1}
          padding={1}
          borderStyle="single"
          borderColor={timeLeft !== null && timeLeft <= 10 ? 'red' : 'yellow'} // Highlight border when time is low
        >
          <InteractiveInput
            // Use slice().reverse().find() for broader compatibility instead of findLast()
            question={
              chatHistory
                .slice()
                .reverse()
                .find((m: ChatMessage) => m.isQuestion && !m.answer)?.text || ''
            }
            questionId={currentQuestionId}
            predefinedOptions={currentPredefinedOptions}
            onSubmit={handleSubmit}
          />
          {/* Countdown Timer and Progress Bar */}
          {timeLeft !== null && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={timeLeft <= 10 ? 'red' : 'yellow'}>
                Time remaining: {timeLeft}s
              </Text>
              <ProgressBar value={percentage} />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

// Render the app
render(<App {...options} />);
