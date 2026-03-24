# PRD: Discord Moderation Bot

## Overview
A Discord bot called "Sentinel" that provides server moderation, role management, welcome messages, and utility commands via slash commands. Designed for medium-to-large Discord communities.

## Target Users
- Discord server administrators and moderators
- Community managers running gaming, developer, or hobby servers
- Server owners who want automated moderation

## Features

### MVP Features
1. **Slash Commands** - All interactions via Discord slash commands (no prefix commands)
2. **Moderation** - Warn, mute, kick, ban with reason logging and duration support
3. **Auto-Moderation** - Spam detection, link filtering, banned word list
4. **Role Management** - Self-assignable reaction roles, role menus, temporary roles
5. **Welcome System** - Customizable welcome messages, auto-role assignment, member count channel
6. **Logging** - Audit log channel for all mod actions, message edits/deletes, joins/leaves
7. **Server Stats** - Member count, message activity, moderation action summary

### Command List
```
Moderation:
  /warn <user> <reason>              - Issue a warning
  /mute <user> <duration> [reason]   - Timeout a user
  /unmute <user>                     - Remove timeout
  /kick <user> [reason]              - Kick from server
  /ban <user> [reason] [days]        - Ban and optionally purge messages
  /unban <user>                      - Remove ban
  /purge <count> [user]              - Delete messages (max 100)
  /warnings <user>                   - View user's warning history
  /case <id>                         - View moderation case details

Auto-Mod:
  /automod spam <on|off>             - Toggle spam detection
  /automod links <on|off|allowlist>  - Toggle link filtering
  /automod words <add|remove|list>   - Manage banned words

Roles:
  /reactionrole create <channel> <message> - Create reaction role message
  /reactionrole add <emoji> <role>         - Add role option to message
  /temprole <user> <role> <duration>       - Assign temporary role

Welcome:
  /welcome channel <channel>         - Set welcome channel
  /welcome message <template>        - Set welcome message template
  /welcome autorole <role>           - Set auto-assigned role
  /welcome test                      - Preview welcome message

Utility:
  /serverinfo                        - Server statistics
  /userinfo <user>                   - User account details
  /stats                             - Bot and moderation statistics
  /config show                       - Show server configuration
```

### User Flow
1. Admin invites bot to server with required permissions
2. Bot registers slash commands on join
3. Admin runs `/welcome channel #welcome` to configure welcome
4. Admin creates reaction role message in a channel
5. New members receive welcome message and auto-role
6. Moderators use `/warn`, `/mute`, `/kick`, `/ban` as needed
7. All actions logged to configured audit channel

## Environment Variables

The bot requires the following environment variables, loaded via `dotenv` from a `.env` file:

### Required
```bash
DISCORD_TOKEN=           # Bot token from Discord Developer Portal
DISCORD_CLIENT_ID=       # Application ID for slash command registration
```

### Optional
```bash
DISCORD_GUILD_ID=        # Development guild ID (for fast command registration during dev)
LOG_CHANNEL_ID=          # Default audit log channel (can be overridden per guild via /config)
NODE_ENV=production      # Set to "production" to disable debug logging
DATABASE_PATH=./data/sentinel.db  # SQLite database file path (default: ./data/sentinel.db)
```

### .env.example
```bash
# Discord Bot Configuration
# Get these from https://discord.com/developers/applications
DISCORD_TOKEN=your-bot-token-here
DISCORD_CLIENT_ID=your-client-id-here

# Optional: Development guild for fast command registration
# DISCORD_GUILD_ID=your-test-server-id

# Optional: Default audit log channel
# LOG_CHANNEL_ID=your-log-channel-id

# Optional: Database path (default: ./data/sentinel.db)
# DATABASE_PATH=./data/sentinel.db
```

### Startup Validation
The bot MUST validate required environment variables on startup and exit with a clear error message if any are missing:
```typescript
const requiredEnvVars = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}
```

## Tech Stack
- Runtime: Node.js 18+
- Library: discord.js v14
- Database: SQLite via better-sqlite3 (per-guild data)
- Command handling: discord.js built-in SlashCommandBuilder
- Scheduling: node-cron (for temporary role/mute expiry)
- Environment: dotenv for token and config

### Structure
```
/
├── src/
│   ├── index.ts                 # Bot client setup and login
│   ├── deploy-commands.ts       # Slash command registration script
│   ├── commands/
│   │   ├── moderation/
│   │   │   ├── warn.ts
│   │   │   ├── mute.ts
│   │   │   ├── kick.ts
│   │   │   ├── ban.ts
│   │   │   ├── purge.ts
│   │   │   └── warnings.ts
│   │   ├── automod/
│   │   │   └── automod.ts
│   │   ├── roles/
│   │   │   ├── reactionrole.ts
│   │   │   └── temprole.ts
│   │   ├── welcome/
│   │   │   └── welcome.ts
│   │   └── utility/
│   │       ├── serverinfo.ts
│   │       ├── userinfo.ts
│   │       └── stats.ts
│   ├── events/
│   │   ├── ready.ts
│   │   ├── interactionCreate.ts
│   │   ├── guildMemberAdd.ts
│   │   ├── guildMemberRemove.ts
│   │   ├── messageCreate.ts       # Auto-mod checks
│   │   ├── messageDelete.ts       # Audit logging
│   │   └── messageUpdate.ts       # Audit logging
│   ├── services/
│   │   ├── moderation.ts          # Mod action logic and case creation
│   │   ├── automod.ts             # Spam/link/word detection
│   │   ├── roles.ts               # Role assignment logic
│   │   ├── welcome.ts             # Welcome message rendering
│   │   └── logger.ts              # Audit log channel posting
│   ├── database/
│   │   ├── db.ts                  # Database connection
│   │   ├── migrations.ts          # Schema setup
│   │   └── queries.ts             # Prepared statements
│   ├── utils/
│   │   ├── permissions.ts         # Permission checks
│   │   ├── embeds.ts              # Discord embed builders
│   │   ├── duration.ts            # Duration string parsing (1h, 7d, etc.)
│   │   └── pagination.ts          # Paginated embed responses
│   └── types.ts
├── tests/
│   ├── moderation.test.ts
│   ├── automod.test.ts
│   ├── duration.test.ts
│   └── permissions.test.ts
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Database Schema

```sql
-- Per-guild configuration
CREATE TABLE guild_config (
  guild_id TEXT PRIMARY KEY,
  welcome_channel_id TEXT,
  welcome_message TEXT DEFAULT 'Welcome to the server, {user}!',
  welcome_autorole_id TEXT,
  log_channel_id TEXT,
  automod_spam INTEGER DEFAULT 0,
  automod_links INTEGER DEFAULT 0,
  link_allowlist TEXT DEFAULT '[]'
);

-- Moderation cases
CREATE TABLE mod_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  action TEXT NOT NULL,        -- warn, mute, kick, ban, unmute, unban
  reason TEXT,
  duration INTEGER,            -- seconds, NULL for permanent
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Banned words per guild
CREATE TABLE banned_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  word TEXT NOT NULL,
  UNIQUE(guild_id, word)
);

-- Reaction roles
CREATE TABLE reaction_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  role_id TEXT NOT NULL,
  UNIQUE(message_id, emoji)
);

-- Temporary roles (for scheduled removal)
CREATE TABLE temp_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);
```

## Requirements
- TypeScript throughout
- All commands use Discord slash command system (no message prefix)
- Permission checks: mod commands require MODERATE_MEMBERS, admin commands require ADMINISTRATOR
- Bot permission validation on startup (check it has required permissions)
- Graceful error handling with user-friendly error embeds
- Rate limiting awareness (respect Discord API limits)
- Multi-guild support (all data scoped by guild_id)
- Duration parsing supports: 30m, 1h, 7d, 2w formats
- Welcome message templates support: {user}, {server}, {memberCount} placeholders

## Testing
- Unit tests: Duration parsing, permission checks, auto-mod detection logic (Vitest)
- Integration tests: Database queries, case creation, config management
- Mock tests: Mock discord.js Client and interactions for command testing
- Manual testing: Requires a test Discord server and bot token

## Out of Scope
- Music playback
- Leveling / XP system
- Ticket system
- Custom bot status / presence cycling
- Web dashboard for configuration
- Sharding (multi-process for 2500+ guilds)
- Deployment (Docker, hosting)

## Success Criteria
- Bot connects and registers all slash commands
- All moderation commands create cases and log to audit channel
- Auto-mod detects spam (repeated messages) and filters banned words
- Reaction roles assign/remove roles on reaction add/remove
- Welcome messages fire on member join with correct template rendering
- Temporary roles and mutes expire automatically
- All tests pass
- Bot handles permission errors gracefully (missing perms, target hierarchy)

---

**Purpose:** Tests Loki Mode's ability to build an event-driven application with real-time interactions, database persistence, and complex permission logic. Expect ~45-60 minutes for full execution.
