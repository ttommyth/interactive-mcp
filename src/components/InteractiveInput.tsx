import React, { FC, useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import logger from '@/utils/logger.js';

interface InteractiveInputProps {
  question: string;
  questionId: string;
  predefinedOptions?: string[];
  onSubmit: (questionId: string, value: string) => void;
}

export const InteractiveInput: FC<InteractiveInputProps> = ({
  question,
  questionId,
  predefinedOptions = [],
  onSubmit,
}) => {
  const [mode, setMode] = useState<'option' | 'input'>(
    predefinedOptions.length > 0 ? 'option' : 'input',
  );
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [inputValue, setInputValue] = useState<string>('');

  useInput((input, key) => {
    if (predefinedOptions.length > 0) {
      if (key.upArrow) {
        setMode('option');
        setSelectedIndex(
          (prev) =>
            (prev - 1 + predefinedOptions.length) % predefinedOptions.length,
        );
        return;
      }

      if (key.downArrow) {
        setMode('option');
        setSelectedIndex((prev) => (prev + 1) % predefinedOptions.length);
        return;
      }
    }

    // Any other key press switches to input mode
    if (
      !key.return &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.tab &&
      !key.shift &&
      !key.leftArrow &&
      !key.rightArrow &&
      input
    ) {
      setMode('input');
      // Update inputValue only if switching to input mode via typing
      // TextInput's onChange will handle subsequent typing
      if (mode === 'option') {
        setInputValue(input); // Start input with the typed character
      }
    }
  });

  const handleInputChange = (value: string) => {
    if (value !== inputValue) {
      setInputValue(value);
      // If user starts typing, switch to input mode
      if (value.length > 0 && mode === 'option') {
        setMode('input');
      } else if (value.length === 0 && predefinedOptions.length > 0) {
        // Optionally switch back to option mode if input is cleared
        // setMode('option');
      }
    }
  };

  const handleSubmit = (value: string) => {
    // TextInput owns Enter so each answer is submitted only once.
    if (mode === 'option' && predefinedOptions.length > 0) {
      onSubmit(questionId, predefinedOptions[selectedIndex]);
    } else {
      onSubmit(questionId, value);
    }
  };

  return (
    <>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan" wrap="wrap">
          {question}
        </Text>
      </Box>

      {predefinedOptions.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor={true}>
            Use ↑/↓ to select options, type for custom input, Enter to submit
          </Text>
          {predefinedOptions.map((opt, i) => (
            <Text
              key={i}
              color={
                i === selectedIndex && mode === 'option'
                  ? 'greenBright'
                  : undefined
              }
            >
              {i === selectedIndex && mode === 'option' ? '› ' : '  '}
              {opt}
            </Text>
          ))}
        </Box>
      )}

      <Box>
        <Text color={mode === 'input' ? 'greenBright' : undefined}>
          {mode === 'input' ? '✎ ' : '› '}
          <TextInput
            placeholder={
              predefinedOptions.length > 0
                ? 'Type or select an option...'
                : 'Type your answer...'
            }
            onChange={handleInputChange}
            onSubmit={handleSubmit}
          />
        </Text>
      </Box>
    </>
  );
};
