# Telegram Bot Setup for Interactive MCP

This guide explains how to set up and use Telegram bot functionality instead of terminal windows for user interaction.

## Prerequisites

1. A Telegram bot token (get one from [@BotFather](https://t.me/BotFather))
2. Your Telegram chat ID (get it from [@userinfobot](https://t.me/userinfobot))

## Setup Steps

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` to create a new bot
3. Follow the instructions to name your bot
4. Save the bot token (looks like `123456789:ABCdefGhiJklmnopQRSTUVwxyz`)

### 2. Get Your Chat ID

1. Open Telegram and search for [@userinfobot](https://t.me/userinfobot)
2. Send `/start` to get your chat ID
3. Save the chat ID (looks like `123456789`)

### 3. Set Environment Variable

Set the `TELEGRAM_BOT_TOKEN` environment variable:

**Windows:**

```cmd
set TELEGRAM_BOT_TOKEN=123456789:ABCdefGhiJklmnopQRSTUVwxyz
```

**Linux/macOS:**

```bash
export TELEGRAM_BOT_TOKEN=123456789:ABCdefGhiJklmnopQRSTUVwxyz
```

**Or create a `.env` file (recommended):**

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhiJklmnopQRSTUVwxyz
```

## Usage

### Running with Telegram Mode

Instead of using terminal windows, use the `--use-telegram` flag:

```bash
# Single chat ID
interactive-mcp --use-telegram --telegram-chat-ids 123456789

# Multiple chat IDs (comma-separated)
interactive-mcp --use-telegram --telegram-chat-ids 123456789,987654321

# With custom timeout for Telegram (recommended: longer than terminal)
interactive-mcp --use-telegram --telegram-chat-ids 123456789 --telegram-timeout 600

# Different timeouts for terminal vs Telegram
interactive-mcp --use-telegram --telegram-chat-ids 123456789 --timeout 30 --telegram-timeout 300
```

### MCP Client Configuration

When using with MCP clients (like Claude Desktop), update your MCP configuration:

**For Claude Desktop (`claude_desktop_config.json`):**

```json
{
  "mcpServers": {
    "interactive": {
      "command": "interactive-mcp",
      "args": ["--use-telegram", "--telegram-chat-ids", "123456789"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "123456789:ABCdefGhiJklmnopQRSTUVwxyz"
      }
    }
  }
}
```

## Features

### 1. Interactive Messages

- Questions appear as Telegram messages with your project name
- Simply reply to the message with your answer
- **Smart Timeout**: Get notified when questions expire with remaining time
- HTML formatting for better readability

### 2. Quick Reply Buttons

- When predefined options are available, they appear as inline buttons
- Click a button to select that option instantly
- No need to type the response

### 3. Rich Media Support

- **📷 Images**: Send photos as responses - bot receives `[IMAGE:file_id] caption`
- **📄 Files**: Send documents/files - bot receives `[FILE:file_id:filename] caption`
- **🎵 Voice**: Send voice messages - bot receives `[VOICE:file_id]`
- **🎬 Video**: Send video files - bot receives `[VIDEO:file_id] caption`
- **💬 Text**: Regular text messages work as before

### 4. Enhanced Notifications

- Desktop notifications become Telegram messages with 🔔 emoji
- HTML formatting for better presentation
- Real-time delivery to your phone/desktop

### 5. Smart Timeouts

- **Timeout Notification**: Users get notified when questions expire
- **Separate Timeouts**: Different timeout for Telegram vs terminal mode
- **Visual Feedback**: Clear indication of expired questions

### 6. Security

- Only specified chat IDs can interact with the bot
- Unauthorized users receive no response
- All interactions are logged with detailed context

## Example Interaction

**Terminal Mode (old):**

```
[Pop-up window appears]
MyProject: Do you want to continue? (yes/no)
[User types in terminal window]
```

**Telegram Mode (new):**

```
🤖 MyProject (in bold)

Do you want to continue?

[yes] [no]  <- Clickable buttons

--- If timeout occurs ---
⏰ Question from MyProject has timed out (300s)
```

**Rich Media Example:**

```
User sends photo with caption "Here's the screenshot"
Bot receives: [IMAGE:BAADBAADrwADBREAAaOJPG...] Here's the screenshot

User sends document "config.json"
Bot receives: [FILE:BAADBAADrwADBREAAaOJPG...:config.json]
```

## Troubleshooting

### Bot Token Issues

- Make sure `TELEGRAM_BOT_TOKEN` is set correctly
- Verify the token works by testing with [@BotFather](https://t.me/BotFather)

### Chat ID Issues

- Ensure chat IDs are numeric (no letters)
- Double-check your chat ID with [@userinfobot](https://t.me/userinfobot)
- Multiple chat IDs must be comma-separated

### Bot Not Responding

- Check if you've started a conversation with your bot
- Send `/start` to your bot first
- Verify the bot token is valid and active

### Permission Errors

- Make sure your chat ID is in the allowed list
- Check the logs for "Unauthorized chat attempt" messages

## Switching Back to Terminal Mode

Simply remove the `--use-telegram` flag to return to terminal window mode:

```bash
interactive-mcp --timeout 30
```

Both modes can coexist - choose the one that works best for your workflow!
