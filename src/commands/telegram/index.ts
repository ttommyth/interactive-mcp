import TelegramBot from 'node-telegram-bot-api';
import { randomBytes } from 'crypto';
import { USER_INPUT_TIMEOUT_SECONDS } from '@/constants.js';
import logger from '../../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

interface PendingQuestion {
  resolve: (response: string) => void;
  messageId: number;
  timeout: NodeJS.Timeout;
  predefinedOptions?: string[];
  chatId: number;
  projectName: string;
  originalMessage: string;
  countdownIntervals: NodeJS.Timeout[];
  startTime: number;
  timeoutSeconds: number;
}

interface IntensiveChatMessage {
  question: string;
  answer?: string;
  messageId?: number;
}

interface IntensiveChatSession {
  sessionId: string;
  chatId: number;
  projectName: string;
  isActive: boolean;
  messageHistory: IntensiveChatMessage[];
}

class TelegramInteraction {
  private bot: TelegramBot;
  private allowedChatIds: Set<number>;
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private intensiveChatSessions: Map<string, IntensiveChatSession> = new Map();
  private messageHandlerSet = false;

  constructor(bot: TelegramBot, allowedChatIds: number[]) {
    this.bot = bot;
    this.allowedChatIds = new Set(allowedChatIds);
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    if (this.messageHandlerSet) return;

    // Set up message handler
    this.bot.on('message', (msg) => {
      this.handleMessage(msg);
    });

    // Set up callback query handler for inline keyboards
    this.bot.on('callback_query', (query) => {
      this.handleCallbackQuery(query);
    });

    this.messageHandlerSet = true;
    logger.info('Telegram message handlers set up', {
      allowedChatIds: Array.from(this.allowedChatIds),
    });
  }

  private isAllowedChat(chatId: number): boolean {
    return this.allowedChatIds.has(chatId);
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    if (!msg.chat || !this.isAllowedChat(msg.chat.id)) {
      logger.warn('Unauthorized chat attempt', { chatId: msg.chat?.id });
      return;
    }

    // Check if this is part of an intensive chat session
    for (const [, session] of this.intensiveChatSessions.entries()) {
      if (session.chatId === msg.chat.id && session.isActive) {
        let response: string;

        // Handle different message types
        if (msg.text !== undefined) {
          response = msg.text;
        } else if (msg.photo && msg.photo.length > 0) {
          // Download and read photo content
          response = await this.downloadAndReadPhoto(msg.photo, msg.caption);
        } else if (msg.document) {
          // Download and read file content
          const fileContent = await this.downloadAndReadFile(
            msg.document.file_id,
            msg.document.file_name,
          );
          response = `[FILE:${msg.document.file_name || 'unknown'}] ${fileContent}${
            msg.caption ? ` Caption: ${msg.caption}` : ''
          }`;
        } else if (msg.voice) {
          response = `[VOICE:${msg.voice.file_id}]`;
        } else if (msg.video) {
          response = `[VIDEO:${msg.video.file_id}]${
            msg.caption ? ` ${msg.caption}` : ''
          }`;
        } else {
          return;
        }

        // Store the answer in session history
        const lastMessage =
          session.messageHistory[session.messageHistory.length - 1];
        if (lastMessage && !lastMessage.answer) {
          lastMessage.answer = response;
        }

        // Continue to check for pending questions
        break;
      }
    }

    // Find if this is a response to a pending question
    // Fix: Add proper session validation and prevent multiple resolutions
    let resolvedSessionId: string | null = null;

    for (const [sessionId, pending] of this.pendingQuestions.entries()) {
      if (pending.chatId === msg.chat.id && !resolvedSessionId) {
        let response: string;

        // Handle different message types
        if (msg.text !== undefined) {
          response = msg.text;
        } else if (msg.photo && msg.photo.length > 0) {
          // Download and read photo content
          response = await this.downloadAndReadPhoto(msg.photo, msg.caption);
        } else if (msg.document) {
          // Download and read file content
          const fileContent = await this.downloadAndReadFile(
            msg.document.file_id,
            msg.document.file_name,
          );
          response = `[FILE:${msg.document.file_name || 'unknown'}] ${fileContent}${
            msg.caption ? ` Caption: ${msg.caption}` : ''
          }`;
        } else if (msg.voice) {
          // Handle voice message
          response = `[VOICE:${msg.voice.file_id}]`;
        } else if (msg.video) {
          // Handle video
          response = `[VIDEO:${msg.video.file_id}]${
            msg.caption ? ` ${msg.caption}` : ''
          }`;
        } else {
          // Unknown message type, skip
          return;
        }

        // Mark this session as resolved to prevent multiple resolutions
        resolvedSessionId = sessionId;

        // Clear timeout and intervals
        clearTimeout(pending.timeout);
        pending.countdownIntervals.forEach(clearInterval);
        this.pendingQuestions.delete(sessionId);

        logger.info('Telegram message resolved', {
          sessionId,
          chatId: msg.chat.id,
          responseLength: response.length,
        });

        pending.resolve(response);
        return;
      }
    }
  }

  private async handleCallbackQuery(
    query: TelegramBot.CallbackQuery,
  ): Promise<void> {
    if (!query.message?.chat || !this.isAllowedChat(query.message.chat.id)) {
      logger.warn('Unauthorized callback query attempt', {
        chatId: query.message?.chat?.id,
      });
      return;
    }

    // Find the pending question for this callback
    for (const [sessionId, pending] of this.pendingQuestions.entries()) {
      if (pending.messageId === query.message?.message_id && query.data) {
        // Clear timeout and intervals
        clearTimeout(pending.timeout);
        pending.countdownIntervals.forEach(clearInterval);
        this.pendingQuestions.delete(sessionId);

        // Find the option number for better feedback
        const optionIndex =
          pending.predefinedOptions?.indexOf(query.data || '') ?? -1;
        const optionNumber = optionIndex >= 0 ? optionIndex + 1 : '';
        const feedbackText = optionNumber
          ? `✅ Selected option ${optionNumber}`
          : `✅ Selected: ${query.data}`;

        // Answer the callback query with feedback
        await this.bot?.answerCallbackQuery(query.id, {
          text: feedbackText,
          show_alert: false,
        });

        // Edit the message to show the selection
        try {
          const originalText = query.message.text || '';
          const selectionText = optionNumber
            ? `✅ <b>Selected option ${optionNumber}:</b> <code>${this.escapeHtml(query.data || '')}</code>`
            : `✅ <b>Selected:</b> <code>${this.escapeHtml(query.data || '')}</code>`;
          const updatedText = `${originalText}\n\n${selectionText}`;

          await this.bot?.editMessageText(updatedText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] }, // Remove buttons
          });
        } catch (error) {
          logger.warn('Failed to edit message after button click', { error });
        }

        pending.resolve(query.data);
        return;
      }
    }

    // Answer callback query even if not found
    await this.bot?.answerCallbackQuery(query.id, {
      text: 'This question has expired',
      show_alert: false,
    });
  }

  // Helper function to escape HTML special characters
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Creates an enhanced message with numbered options and corresponding inline keyboard
   * @param baseMessage The base message text
   * @param predefinedOptions Array of option strings
   * @returns Object with enhanced message text and inline keyboard
   */
  private createEnhancedOptionsMessage(
    baseMessage: string,
    predefinedOptions: string[],
  ): { message: string; keyboard: TelegramBot.InlineKeyboardButton[][] } {
    // Add numbered options to the message
    const numberedOptions = predefinedOptions.map((option, index) => {
      const numberEmoji =
        ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'][index] ||
        `${index + 1}️⃣`;
      return `${numberEmoji} ${this.escapeHtml(option)}`;
    });

    const enhancedMessage = `${baseMessage}\n\n<b>Options:</b>\n${numberedOptions.join('\n')}`;

    // Create inline keyboard with numbered buttons
    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

    // Create rows of buttons (up to 5 per row for numbers, then 3 per row for better UX)
    const buttonsPerRow = predefinedOptions.length <= 5 ? 5 : 3;

    for (let i = 0; i < predefinedOptions.length; i += buttonsPerRow) {
      const row: TelegramBot.InlineKeyboardButton[] = [];

      for (
        let j = i;
        j < Math.min(i + buttonsPerRow, predefinedOptions.length);
        j++
      ) {
        row.push({
          text: `${j + 1}`,
          callback_data: predefinedOptions[j], // Still use original option as callback data
        });
      }

      keyboard.push(row);
    }

    return { message: enhancedMessage, keyboard };
  }

  // Helper function to format message with better HTML
  private formatMessage(projectName: string, message: string): string {
    const escapedProjectName = this.escapeHtml(projectName);

    // First convert markdown to HTML, then escape any remaining HTML
    const formattedMessage = message
      // Convert **bold** to <b>bold</b> (non-greedy)
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      // Convert *italic* to <i>italic</i> (but not if it's part of **)
      .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<i>$1</i>')
      // Convert `code` to <code>code</code>
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
      // Convert ### Header to <b>Header</b>
      .replace(/^### (.*$)/gm, '<b>$1</b>')
      // Convert ## Header to <b>Header</b>
      .replace(/^## (.*$)/gm, '<b>$1</b>')
      // Convert # Header to <b>Header</b>
      .replace(/^# (.*$)/gm, '<b>$1</b>')
      // Convert --- to horizontal line
      .replace(/^---$/gm, '━━━━━━━━━━━━━━━━━━━━')
      // Convert bullet points
      .replace(/^- (.*$)/gm, '• $1')
      .replace(/^\* (.*$)/gm, '• $1')
      // Convert numbered lists
      .replace(/^(\d+)\. (.*$)/gm, '$1. $2');

    // Now escape any HTML that wasn't part of our formatting
    // We need to be careful not to escape our intentional HTML tags
    const htmlTags = /<\/?[bi]>|<\/?code>/g;
    const htmlTagsArray: string[] = [];
    let match;

    // Extract our HTML tags
    while ((match = htmlTags.exec(formattedMessage)) !== null) {
      htmlTagsArray.push(match[0]);
    }

    // Replace our HTML tags with placeholders
    let tempMessage = formattedMessage.replace(htmlTags, '___HTML_TAG___');

    // Escape the rest
    tempMessage = this.escapeHtml(tempMessage);

    // Restore our HTML tags
    let tagIndex = 0;
    tempMessage = tempMessage.replace(/___HTML_TAG___/g, () => {
      return htmlTagsArray[tagIndex++] || '';
    });

    return `<b>${escapedProjectName}</b>\n\n${tempMessage}`;
  }

  /**
   * Start timeout indicator that shows countdown and warnings
   */
  private startTimeoutIndicator(
    sessionId: string,
    chatId: number,
    messageId: number,
    originalMessage: string,
    timeoutSeconds: number,
    startTime: number,
  ): NodeJS.Timeout[] {
    const intervals: NodeJS.Timeout[] = [];

    // Update countdown every 15 seconds (but not too frequently to avoid rate limits)
    const updateInterval = Math.min(15, Math.max(5, timeoutSeconds / 4));

    const countdownInterval = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = timeoutSeconds - elapsed;

      if (remaining <= 0) {
        clearInterval(countdownInterval);
        return;
      }

      // Show countdown at specific intervals
      if (
        remaining === 30 ||
        remaining === 15 ||
        (remaining <= 10 && remaining > 0)
      ) {
        try {
          const timeEmoji = remaining <= 10 ? '⚠️' : '⏰';
          const urgencyText = remaining <= 10 ? ' <b>(URGENT)</b>' : '';
          const countdownText = `\n\n${timeEmoji} <i>${remaining}s remaining${urgencyText}</i>`;

          await this.bot?.editMessageText(originalMessage + countdownText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: this.pendingQuestions.get(sessionId)
              ?.predefinedOptions
              ? {
                  inline_keyboard: this.createEnhancedOptionsMessage(
                    '',
                    this.pendingQuestions.get(sessionId)!.predefinedOptions!,
                  ).keyboard,
                }
              : undefined,
          });
        } catch (error) {
          logger.warn('Failed to update countdown message', {
            sessionId,
            chatId,
            messageId,
            remaining,
            error,
          });
        }
      }
    }, updateInterval * 1000);

    intervals.push(countdownInterval);
    return intervals;
  }

  async sendInput(
    projectName: string,
    promptMessage: string,
    timeoutSeconds: number = USER_INPUT_TIMEOUT_SECONDS,
    predefinedOptions?: string[],
  ): Promise<string> {
    // Generate unique session ID with timestamp to prevent collisions
    const sessionId = `${randomBytes(8).toString('hex')}_${Date.now()}`;
    // Use improved HTML formatting
    const fullMessage = this.formatMessage(projectName, promptMessage);

    return new Promise<string>((resolve) => {
      let isResolved = false; // Flag to prevent multiple resolutions

      const safeResolve = (response: string) => {
        if (!isResolved) {
          isResolved = true;
          resolve(response);
        }
      };

      const sendToChats = async () => {
        for (const chatId of this.allowedChatIds) {
          try {
            let sentMessage: TelegramBot.Message;

            if (predefinedOptions && predefinedOptions.length > 0) {
              // Create enhanced message with numbered options and inline keyboard
              const { message: enhancedMessage, keyboard } =
                this.createEnhancedOptionsMessage(
                  fullMessage,
                  predefinedOptions,
                );

              sentMessage = await this.bot!.sendMessage(
                chatId,
                enhancedMessage,
                {
                  parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: keyboard },
                },
              );
            } else {
              sentMessage = await this.bot!.sendMessage(chatId, fullMessage, {
                parse_mode: 'HTML',
              });
            }

            const startTime = Date.now();

            // Set up timeout with notification
            const timeout = setTimeout(async () => {
              const pending = this.pendingQuestions.get(sessionId);
              if (pending && !isResolved) {
                // Clear intervals
                pending.countdownIntervals.forEach(clearInterval);
                this.pendingQuestions.delete(sessionId);

                // Send timeout notification to user
                try {
                  await this.bot!.sendMessage(
                    chatId,
                    `⏰ <i>Question from <b>${this.escapeHtml(projectName)}</b> has timed out (${timeoutSeconds}s)</i>`,
                    { parse_mode: 'HTML' },
                  );
                } catch (error) {
                  logger.error('Failed to send timeout notification', {
                    chatId,
                    error,
                  });
                }

                safeResolve('__TIMEOUT__');
              }
            }, timeoutSeconds * 1000);

            // Start timeout indicator
            const countdownIntervals = this.startTimeoutIndicator(
              sessionId,
              chatId,
              sentMessage.message_id,
              predefinedOptions
                ? this.createEnhancedOptionsMessage(
                    fullMessage,
                    predefinedOptions,
                  ).message
                : fullMessage,
              timeoutSeconds,
              startTime,
            );

            // Store pending question with more info
            this.pendingQuestions.set(sessionId, {
              resolve: safeResolve, // Use safe resolve function
              messageId: sentMessage.message_id,
              timeout,
              predefinedOptions,
              chatId,
              projectName,
              originalMessage: predefinedOptions
                ? this.createEnhancedOptionsMessage(
                    fullMessage,
                    predefinedOptions,
                  ).message
                : fullMessage,
              countdownIntervals,
              startTime,
              timeoutSeconds,
            });

            logger.info('Telegram message sent with timeout indicator', {
              chatId,
              sessionId,
              messageId: sentMessage.message_id,
              hasPredefinedOptions: !!predefinedOptions?.length,
              timeoutSeconds,
            });
          } catch (error) {
            logger.error('Failed to send Telegram message', { chatId, error });
            // If all chats fail, we'll timeout naturally
          }
        }
      };

      void sendToChats();
    });
  }

  async sendNotification(projectName: string, message: string): Promise<void> {
    // Use the improved formatting for notifications too
    const formattedMessage = this.formatMessage(projectName, message);
    const fullMessage = `🔔 ${formattedMessage}`;

    for (const chatId of this.allowedChatIds) {
      try {
        await this.bot.sendMessage(chatId, fullMessage, {
          parse_mode: 'HTML',
        });
        logger.info('Telegram notification sent', { chatId });
      } catch (error) {
        logger.error('Failed to send Telegram notification', { chatId, error });
      }
    }
  }

  // New methods for intensive chat support
  async startIntensiveChat(
    sessionId: string,
    projectName: string,
    title: string,
  ): Promise<boolean> {
    if (this.allowedChatIds.size === 0) {
      return false;
    }

    const chatId = Array.from(this.allowedChatIds)[0]; // Use first chat ID for intensive sessions

    // Create session
    this.intensiveChatSessions.set(sessionId, {
      sessionId,
      chatId,
      projectName,
      isActive: true,
      messageHistory: [],
    });

    // Send session start message
    try {
      const startMessage = this.formatMessage(
        projectName,
        `🚀 **Intensive Chat Session Started**\n\n📋 **Session:** ${title}\n🆔 **ID:** \`${sessionId}\`\n\n💬 You can now send messages, photos, files, or voice messages. This session will stay active until closed.`,
      );

      await this.bot.sendMessage(chatId, startMessage, {
        parse_mode: 'HTML',
      });

      logger.info('Telegram intensive chat session started', {
        sessionId,
        chatId,
        projectName,
      });

      return true;
    } catch (error) {
      logger.error('Failed to start Telegram intensive chat session', {
        sessionId,
        error,
      });
      this.intensiveChatSessions.delete(sessionId);
      return false;
    }
  }

  async askInIntensiveChat(
    sessionId: string,
    question: string,
    predefinedOptions?: string[],
    timeoutSeconds: number = USER_INPUT_TIMEOUT_SECONDS,
  ): Promise<string | null> {
    const session = this.intensiveChatSessions.get(sessionId);
    if (!session || !session.isActive) {
      return null;
    }

    // Add question to session history
    const messageEntry: IntensiveChatMessage = { question, answer: undefined };
    session.messageHistory.push(messageEntry);

    // Send the question
    try {
      const questionMessage = this.formatMessage(
        session.projectName,
        `❓ **Question ${session.messageHistory.length}:**\n\n${question}`,
      );

      let sentMessage: TelegramBot.Message;

      if (predefinedOptions && predefinedOptions.length > 0) {
        // Create enhanced message with numbered options and inline keyboard
        const { message: enhancedMessage, keyboard } =
          this.createEnhancedOptionsMessage(questionMessage, predefinedOptions);

        sentMessage = await this.bot!.sendMessage(
          session.chatId,
          enhancedMessage,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
          },
        );
      } else {
        sentMessage = await this.bot!.sendMessage(
          session.chatId,
          questionMessage,
          {
            parse_mode: 'HTML',
          },
        );
      }

      messageEntry.messageId = sentMessage.message_id;

      // Wait for response
      return new Promise<string>((resolve) => {
        // Generate unique session ID with timestamp to prevent collisions
        const questionSessionId = `${randomBytes(8).toString('hex')}_${Date.now()}`;
        const startTime = Date.now();
        let isResolved = false; // Flag to prevent multiple resolutions

        const safeResolve = (response: string) => {
          if (!isResolved) {
            isResolved = true;
            messageEntry.answer = response;
            resolve(response);
          }
        };

        const timeout = setTimeout(async () => {
          const pending = this.pendingQuestions.get(questionSessionId);
          if (pending && !isResolved) {
            // Clear intervals
            pending.countdownIntervals.forEach(clearInterval);
            this.pendingQuestions.delete(questionSessionId);

            // Send timeout notification
            try {
              await this.bot!.sendMessage(
                session.chatId,
                `⏰ <i>Question ${session.messageHistory.length} has timed out (${timeoutSeconds}s)</i>`,
                { parse_mode: 'HTML' },
              );
            } catch (error) {
              logger.error(
                'Failed to send intensive chat timeout notification',
                {
                  sessionId,
                  error,
                },
              );
            }

            safeResolve('__TIMEOUT__');
          }
        }, timeoutSeconds * 1000);

        // Start timeout indicator for intensive chat
        const countdownIntervals = this.startTimeoutIndicator(
          questionSessionId,
          session.chatId,
          sentMessage.message_id,
          predefinedOptions
            ? this.createEnhancedOptionsMessage(
                questionMessage,
                predefinedOptions,
              ).message
            : questionMessage,
          timeoutSeconds,
          startTime,
        );

        // Store pending question
        this.pendingQuestions.set(questionSessionId, {
          resolve: safeResolve, // Use safe resolve function
          messageId: sentMessage.message_id,
          timeout,
          predefinedOptions,
          chatId: session.chatId,
          projectName: session.projectName,
          originalMessage: predefinedOptions
            ? this.createEnhancedOptionsMessage(
                questionMessage,
                predefinedOptions,
              ).message
            : questionMessage,
          countdownIntervals,
          startTime,
          timeoutSeconds,
        });
      });
    } catch (error) {
      logger.error('Failed to send intensive chat question', {
        sessionId,
        error,
      });
      return null;
    }
  }

  async stopIntensiveChat(sessionId: string): Promise<boolean> {
    const session = this.intensiveChatSessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.isActive = false;

    // Send session end message with summary
    try {
      const summaryLines = session.messageHistory.map((msg, index) => {
        const answer = msg.answer || '<i>No answer</i>';
        return `${index + 1}. <b>Q:</b> ${this.escapeHtml(msg.question)}\n   <b>A:</b> ${this.escapeHtml(answer)}`;
      });

      const summaryMessage = this.formatMessage(
        session.projectName,
        `🏁 **Intensive Chat Session Ended**\n\n📊 **Summary** (${session.messageHistory.length} questions):\n\n${summaryLines.join('\n\n')}\n\n✅ Session closed successfully.`,
      );

      await this.bot!.sendMessage(session.chatId, summaryMessage, {
        parse_mode: 'HTML',
      });

      logger.info('Telegram intensive chat session stopped', {
        sessionId,
        chatId: session.chatId,
        questionsCount: session.messageHistory.length,
      });
    } catch (error) {
      logger.error('Failed to send intensive chat session end message', {
        sessionId,
        error,
      });
    }

    // Clean up
    this.intensiveChatSessions.delete(sessionId);
    return true;
  }

  cleanup(): void {
    logger.info('Telegram interaction cleanup started', {
      pendingQuestionsCount: this.pendingQuestions.size,
      intensiveChatSessionsCount: this.intensiveChatSessions.size,
    });

    // Clear all pending questions and their intervals
    for (const [sessionId, pending] of this.pendingQuestions.entries()) {
      logger.debug('Cleaning up pending question', { sessionId });
      clearTimeout(pending.timeout);
      pending.countdownIntervals.forEach(clearInterval);
      pending.resolve('__CLEANUP__'); // Resolve with cleanup indicator
    }
    this.pendingQuestions.clear();

    // Clear intensive chat sessions
    for (const [sessionId, session] of this.intensiveChatSessions.entries()) {
      logger.debug('Cleaning up intensive chat session', { sessionId });
      session.isActive = false;
    }
    this.intensiveChatSessions.clear();

    logger.info('Telegram interaction cleanup completed');
  }

  // Helper function to download and read file content
  private async downloadAndReadFile(
    fileId: string,
    filename?: string,
  ): Promise<string> {
    try {
      // Get file info from Telegram
      const file = await this.bot.getFile(fileId);

      if (!file.file_path) {
        throw new Error('File path not available');
      }

      // Download file to temporary location
      const tempDir = os.tmpdir();

      // Download the file
      await this.bot.downloadFile(fileId, tempDir);

      // The downloaded file will be at the file_path location
      const downloadedPath = path.join(tempDir, path.basename(file.file_path));

      // Read file content based on type
      let content: string;
      const fileExtension = path
        .extname(filename || file.file_path || '')
        .toLowerCase();

      if (
        [
          '.txt',
          '.md',
          '.json',
          '.js',
          '.ts',
          '.py',
          '.html',
          '.css',
          '.xml',
          '.csv',
        ].includes(fileExtension)
      ) {
        // Text files - read as UTF-8
        content = await fs.readFile(downloadedPath, 'utf-8');
      } else if (
        ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExtension)
      ) {
        // Images - return base64 encoded
        const buffer = await fs.readFile(downloadedPath);
        content = `[BASE64_IMAGE:${buffer.toString('base64')}]`;
      } else {
        // Other files - return base64 encoded with size info
        const buffer = await fs.readFile(downloadedPath);
        const sizeKB = Math.round(buffer.length / 1024);
        content = `[BINARY_FILE:${sizeKB}KB:${buffer.toString('base64')}]`;
      }

      // Clean up temporary file
      try {
        await fs.unlink(downloadedPath);
      } catch (cleanupError) {
        logger.warn('Failed to cleanup temporary file', {
          downloadedPath,
          cleanupError,
        });
      }

      return content;
    } catch (error) {
      logger.error('Failed to download and read file', {
        fileId,
        filename,
        error,
      });
      return `[ERROR: Could not download file - ${error instanceof Error ? error.message : 'Unknown error'}]`;
    }
  }

  // Helper function to download and read photo
  private async downloadAndReadPhoto(
    photoSizes: TelegramBot.PhotoSize[],
    caption?: string,
  ): Promise<string> {
    try {
      // Get the largest photo size
      const largestPhoto = photoSizes[photoSizes.length - 1];
      const content = await this.downloadAndReadFile(
        largestPhoto.file_id,
        'photo.jpg',
      );

      return `[PHOTO:${largestPhoto.width}x${largestPhoto.height}:${content}]${caption ? ` ${caption}` : ''}`;
    } catch (error) {
      logger.error('Failed to download and read photo', { error });
      return `[ERROR: Could not download photo - ${error instanceof Error ? error.message : 'Unknown error'}]${caption ? ` ${caption}` : ''}`;
    }
  }
}

/**
 * Create a new TelegramInteraction instance
 * @param bot TelegramBot instance (managed externally)
 * @param allowedChatIds Array of allowed Telegram chat IDs
 * @returns TelegramInteraction instance
 */
export function createTelegramInteraction(
  bot: TelegramBot,
  allowedChatIds: number[],
): TelegramInteraction {
  return new TelegramInteraction(bot, allowedChatIds);
}

/**
 * Get user input via Telegram bot
 * @param bot TelegramBot instance
 * @param projectName Name of the project requesting input (used for title)
 * @param promptMessage Message to display to the user
 * @param timeoutSeconds Timeout in seconds
 * @param allowedChatIds Array of allowed Telegram chat IDs
 * @param predefinedOptions Optional list of predefined options for quick selection
 * @returns User input or '__TIMEOUT__' if timeout
 */
export async function getTelegramInput(
  bot: TelegramBot,
  projectName: string,
  promptMessage: string,
  timeoutSeconds: number = USER_INPUT_TIMEOUT_SECONDS,
  allowedChatIds: number[],
  predefinedOptions?: string[],
): Promise<string> {
  const interaction = new TelegramInteraction(bot, allowedChatIds);
  return interaction.sendInput(
    projectName,
    promptMessage,
    timeoutSeconds,
    predefinedOptions,
  );
}

/**
 * Send notification via Telegram bot
 * @param bot TelegramBot instance
 * @param projectName Name of the project
 * @param message Notification message
 * @param allowedChatIds Array of allowed Telegram chat IDs
 */
export async function sendTelegramNotification(
  bot: TelegramBot,
  projectName: string,
  message: string,
  allowedChatIds: number[],
): Promise<void> {
  const interaction = new TelegramInteraction(bot, allowedChatIds);
  return interaction.sendNotification(projectName, message);
}

/**
 * Start an intensive chat session via Telegram
 * @param bot TelegramBot instance
 * @param sessionId Unique session identifier
 * @param projectName Name of the project
 * @param title Title for the session
 * @param allowedChatIds Array of allowed Telegram chat IDs
 * @returns True if session started successfully
 */
export async function startTelegramIntensiveChat(
  bot: TelegramBot,
  sessionId: string,
  projectName: string,
  title: string,
  allowedChatIds: number[],
): Promise<boolean> {
  const interaction = new TelegramInteraction(bot, allowedChatIds);
  return interaction.startIntensiveChat(sessionId, projectName, title);
}

/**
 * Ask a question in an active Telegram intensive chat session
 * @param bot TelegramBot instance
 * @param sessionId Session identifier
 * @param question Question to ask
 * @param predefinedOptions Optional predefined options
 * @param timeoutSeconds Timeout in seconds
 * @returns User response or null if session not found
 */
export async function askTelegramIntensiveChat(
  bot: TelegramBot,
  sessionId: string,
  question: string,
  predefinedOptions?: string[],
  timeoutSeconds: number = USER_INPUT_TIMEOUT_SECONDS,
): Promise<string | null> {
  // Note: This requires the bot to have the same session state
  // For intensive chat, it's better to use the instance-based approach
  throw new Error(
    'Use createTelegramInteraction() and call askInIntensiveChat() on the instance for intensive chat sessions',
  );
}

/**
 * Stop an active Telegram intensive chat session
 * @param bot TelegramBot instance
 * @param sessionId Session identifier
 * @returns True if session was stopped successfully
 */
export async function stopTelegramIntensiveChat(
  bot: TelegramBot,
  sessionId: string,
): Promise<boolean> {
  // Note: This requires the bot to have the same session state
  // For intensive chat, it's better to use the instance-based approach
  throw new Error(
    'Use createTelegramInteraction() and call stopIntensiveChat() on the instance for intensive chat sessions',
  );
}

/**
 * Cleanup Telegram bot resources (deprecated - manage bot lifecycle externally)
 */
export function cleanupTelegram(): void {
  logger.warn(
    'cleanupTelegram() is deprecated. Manage bot lifecycle externally.',
  );
}
