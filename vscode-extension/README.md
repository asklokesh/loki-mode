# Loki Mode for VS Code

> **DEPRECATED as of v7.2.0.** The Loki Mode VSCode extension is no longer
> maintained. Use the dashboard at `loki dashboard start` instead. Last
> published: v7.1.0. The marketplace listing remains for users on older
> versions but will not receive updates.
>
> The `vscode-extension/` source remains in the repository so contributors
> who want to build and install the extension locally can still do so, but
> no further releases will be published to the VS Code Marketplace.

Multi-agent autonomous development powered by Claude Code, OpenAI Codex, and Google Gemini.

## Features

### Session Management
- Start autonomous development sessions from PRD files
- Choose between Claude Code, OpenAI Codex, or Google Gemini as your AI provider
- Pause, resume, and stop sessions at any time
- Inject human guidance during execution

### Real-Time Task Tracking
- View all tasks grouped by status: In Progress, Pending, Completed
- Live progress updates with spinning indicators for active tasks
- Click tasks to see details and current progress

### Status Bar Integration
- Always-visible status indicator in the VS Code status bar
- Shows current phase and task progress when running
- Quick access to actions via click menu

### Session Information Panel
- View PRD file, provider, and current phase
- Track session duration in real-time
- See current task and overall progress

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Loki Mode"
4. Click Install

### From VSIX File

1. Download the `.vsix` file from the releases page
2. Open VS Code
3. Go to Extensions
4. Click the "..." menu and select "Install from VSIX..."
5. Select the downloaded file

### Requirements

- VS Code 1.80.0 or higher
- Node.js 18+ (for the backend server)
- One of the supported AI CLI tools:
  - Claude Code CLI (`claude`)
  - OpenAI Codex CLI (`codex`)
  - Google Gemini CLI (`gemini`)

## Quick Start

### Step 1: Start the Backend Server

**The extension requires the Loki Mode server to be running first:**

```bash
# Using Loki CLI (if installed via npm or Homebrew)
loki start

# Or from loki-mode source directory
./autonomy/run.sh
```

You should see: "Loki API server listening on http://localhost:57374"

### Step 2: Use the Extension

1. Open a project folder in VS Code
2. Click the Loki Mode icon in the Activity Bar (sidebar)
3. Select "Start Session"
4. Choose your PRD file
5. Select your AI provider (Claude recommended)
6. Watch as Loki Mode autonomously develops your project

## Commands

| Command | Description | Keyboard Shortcut |
|---------|-------------|-------------------|
| `Loki: Start Session` | Start a new autonomous development session | - |
| `Loki: Stop Session` | Stop the current session | - |
| `Loki: Pause Session` | Pause execution | - |
| `Loki: Resume Session` | Resume a paused session | - |
| `Loki: Show Status` | Display current session status | - |
| `Loki: Inject Input` | Send human guidance to the AI | - |
| `Loki: Refresh Tasks` | Refresh task and session data | - |

Access all commands via:
- Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
- Status bar click menu
- Activity Bar panel context menus

## Extension Settings

Configure Loki Mode in your VS Code settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `loki.apiEndpoint` | Backend API server URL | `http://localhost:57374` |
| `loki.defaultProvider` | Default AI provider | `claude` |
| `loki.autoRefresh` | Auto-refresh interval (ms) | `5000` |
| `loki.showNotifications` | Show progress notifications | `true` |

### Example Settings

```json
{
  "loki.apiEndpoint": "http://localhost:57374",
  "loki.defaultProvider": "claude",
  "loki.autoRefresh": 3000,
  "loki.showNotifications": true
}
```

## Providers

### Claude Code (Recommended)
- Full feature support
- Parallel task execution
- Sub-agent spawning
- MCP integration

### OpenAI Codex
- Degraded mode
- Sequential task execution
- No sub-agent support

### Google Gemini
- Degraded mode
- Sequential task execution
- No sub-agent support

## Views

### Session Panel
Located in the Activity Bar, shows:
- Current session status
- PRD file path (click to open)
- Selected provider
- Current phase
- Task progress
- Session duration
- Action buttons (Pause/Resume/Stop)

### Tasks Panel
Located below the Session panel, shows:
- Tasks grouped by status
- In Progress tasks (expanded by default)
- Pending tasks (expanded by default)
- Completed tasks (collapsed by default)

### Status Bar
Located in the bottom status bar:
- Idle: Shows "Loki Mode" with rocket icon
- Running: Shows phase and progress with spinning icon
- Paused: Shows "Paused" with pause icon
- Error: Shows "Error" with error icon

## Screenshots

[Screenshot: Session Panel]
[Screenshot: Tasks Panel]
[Screenshot: Status Bar Running]
[Screenshot: Provider Selection]

## Troubleshooting

### Session won't start
1. Ensure the backend server is running at the configured endpoint
2. Check that your AI CLI tool is installed and accessible
3. Verify your PRD file is valid

### Tasks not updating
1. Click "Refresh Tasks" in the panel
2. Check the Output panel for errors
3. Verify API endpoint connectivity

### Status bar not visible
1. Right-click the status bar
2. Ensure "Loki Mode" is checked
3. Restart VS Code if needed

## Backend Setup

This extension requires the Loki Mode backend server. To start it:

```bash
# Using npm
npm install -g loki-mode
loki server

# Using Docker
docker run -p 57374:57374 lokesh/loki-mode

# From source
cd autonomy && ./run.sh --server
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Links

- [Loki Mode Documentation](https://github.com/asklokesh/loki-mode)
- [Report Issues](https://github.com/asklokesh/loki-mode/issues)
- [Changelog](CHANGELOG.md)
