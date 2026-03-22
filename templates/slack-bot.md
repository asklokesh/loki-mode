# PRD: Slack Bot

## Overview
A Slack bot that responds to commands, processes events, and integrates with external services. Supports slash commands, interactive messages, and scheduled notifications.

## Target Users
- Teams automating workflows through Slack
- Developers building internal tools for Slack workspaces
- Organizations standardizing team communication and processes

## Core Features
1. **Slash Commands** - Register and handle custom slash commands with argument parsing
2. **Event Handling** - Listen for message events, reactions, channel joins, and user mentions
3. **Interactive Messages** - Send messages with buttons, menus, and modals for user input
4. **Scheduled Messages** - Schedule recurring notifications and reminders with cron syntax
5. **External Integrations** - Connect to REST APIs and databases to fetch and display data
6. **Help System** - Built-in help command listing all available commands and their usage
7. **Error Reporting** - Log errors and send admin notifications when commands fail

## Technical Requirements
- Node.js with TypeScript
- Bolt for Slack SDK (official Slack framework)
- Express for webhook endpoints
- SQLite for persistent storage (schedules, user preferences)
- Environment-based configuration for tokens and signing secrets
- Structured logging with request context
- Socket Mode for development, HTTP for production

## Quality Gates
- Unit tests for command handlers and argument parsers
- Integration tests with Slack API mocks
- Interactive message flows tested end-to-end
- Error handling verified for invalid inputs and API failures
- Rate limiting compliance with Slack API limits

## Project Structure
```
/
├── src/
│   ├── app.ts                 # Bolt app initialization
│   ├── server.ts              # Entry point (Socket Mode or HTTP)
│   ├── commands/
│   │   ├── index.ts           # Command router
│   │   ├── help.ts            # /help command handler
│   │   └── remind.ts          # /remind command handler
│   ├── events/
│   │   ├── message.ts         # Message event handler
│   │   └── reaction.ts        # Reaction event handler
│   ├── actions/
│   │   └── buttons.ts         # Interactive button handlers
│   ├── views/
│   │   └── modals.ts          # Modal view definitions
│   ├── services/
│   │   ├── scheduler.ts       # Cron-based scheduled messages
│   │   └── external.ts        # External API integrations
│   ├── db.ts                  # SQLite connection and queries
│   └── config.ts              # Token and config from env
├── tests/
│   ├── commands.test.ts       # Command handler tests
│   └── scheduler.test.ts      # Scheduler logic tests
├── .env.example               # Required Slack tokens
├── package.json
└── README.md
```

## Out of Scope
- OAuth installation flow for multi-workspace distribution
- Slack App Directory submission
- Real-time messaging API (RTM) -- use Events API instead
- Message threading and conversation management
- File upload or download handling
- Workflow Builder integration
- Slack Connect (cross-org) support

## Acceptance Criteria
- Bot connects via Socket Mode in development
- All slash commands parse arguments and return formatted responses
- Message events trigger the correct handler based on content
- Interactive buttons and modals submit data and update the original message
- Scheduled messages fire within 60 seconds of their configured time
- Failed commands send an error notification to the admin channel
- Help command lists all registered commands with usage examples

## Success Metrics
- Bot responds to all registered slash commands
- Event handlers process messages and reactions correctly
- Interactive modals collect and persist user input
- Scheduled messages fire at configured times
- Error notifications reach admin channel
- All tests pass
