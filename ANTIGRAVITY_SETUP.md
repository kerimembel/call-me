# Google Antigravity & VS Code Extension Setup Guide

This guide explains how to set up the **CallMe** system to work with **Google Antigravity** (or any VS Code-based editor). This allows your AI agents to call you or message you on Telegram when they need your input.

## 1. Prerequisites

-   **Node.js** & **npm** installed.
-   **Bun** installed (for the server).
-   **ngrok** account (free is fine).
-   **Telegram** account.

---

## 2. Setting up Telegram (Get Credentials)

To allow the system to message you, you need a Telegram Bot.

### Step A: Create a Bot
1.  Open Telegram and search for **@BotFather**.
2.  Send the command `/newbot`.
3.  Follow the instructions:
    -   Give your bot a name (e.g., "My AI Assistant").
    -   Give your bot a username (must end in `bot`, e.g., `my_dev_helper_bot`).
4.  **BotFather** will give you a **Token** (e.g., `123456789:ABCdefGHIjklMNOpqrstUVwxyz`).
    -   Save this as `TELEGRAM_BOT_TOKEN`.

### Step B: Get Your Chat ID
1.  Search for your new bot in Telegram (by its username) and click **Start** (or send `/start`).
2.  The server logs will eventually show your Chat ID, but the easiest way to find it beforehand is:
    -   Search for **@userinfobot** in Telegram.
    -   Click Start. It will reply with your "Id".
    -   Save this number as `TELEGRAM_CHAT_ID`.

---

## 3. Server Setup

The server acts as the bridge between VS Code and your Phone/Telegram.

1.  Navigate to the `server` directory:
    ```bash
    cd server
    ```

2.  Install dependencies:
    ```bash
    bun install
    ```

3.  Configure Environment Variables:
    -   Open (or create) `.env` file (you can copy `.env.example`).
    -   Add your Telegram credentials:

    ```env
    # Phone Settings (Telnyx/Twilio) - See main README
    CALLME_PHONE_PROVIDER=telnyx
    ...

    # Telegram Settings
    TELEGRAM_BOT_TOKEN=your_bot_token_here
    TELEGRAM_CHAT_ID=your_chat_id_here
    ```

4.  Start the server:
    ```bash
    bun start
    ```

5.  **Copy the URL:**
    -   The console will show something like: `ngrok tunnel: https://abc-123.ngrok-free.app`
    -   Copy this URL. You will need it for the VS Code extension.

---

## 4. Extension Setup (VS Code / Antigravity)

Now we need to install the bridge into your IDE.

1.  Navigate to the `extension` directory:
    ```bash
    cd extension
    ```

2.  Install dependencies and package the extension:
    ```bash
    npm install
    npx vsce package
    ```
    -   This will create a file named `callme-extension-0.0.1.vsix`.

3.  **Install in Antigravity (or VS Code):**
    -   Open the **Extensions** view (Ctrl+Shift+X).
    -   Click the "..." (Views and More Actions) menu at the top right of the Extensions pane.
    -   Select **"Install from VSIX..."**.
    -   Choose the `callme-extension-0.0.1.vsix` file you just created.

---

## 5. Configuration & Testing

1.  **Connect Extension to Server:**
    -   In Antigravity, go to **Settings** (`Ctrl+,`).
    -   Search for `CallMe`.
    -   In **CallMe: Server Url**, paste the ngrok URL you copied earlier (e.g., `https://abc-123.ngrok-free.app`).

2.  **Manual Test:**
    -   Open Command Palette (`Ctrl+Shift+P`).
    -   Run: `CallMe: Ask via Telegram`.
    -   Type "Hello from IDE".
    -   Check your Telegram; you should receive the message.
    -   Reply to the message in Telegram.
    -   Check Antigravity; a notification should appear with your reply.

---

## 6. How to Use with AI Agents

You can now instruct your AI agent in Antigravity to use these tools.

**Example Prompt:**
> "I am going AFK. Continue working on the refactoring task. If you encounter any ambiguous code or need a decision, use the 'CallMe: Ask via Telegram' command to ask me. Wait for my reply before proceeding. If you finish, call me using 'CallMe: Call User' to let me know."

The agent will be able to invoke the VS Code commands programmatically to reach you.
