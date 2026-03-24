# PRD: CLI File Organizer Tool

## Overview
A Node.js command-line tool called `tidyfiles` that organizes files in a directory by type, date, or custom rules. Supports multiple subcommands, configuration files, colored terminal output, and generates a man page.

## Target Users
- Developers who want to automate file organization
- Power users managing downloads, screenshots, or project directories
- System administrators maintaining file servers

## Features

### MVP Features
1. **Organize by Type** - Sort files into folders by extension (images/, documents/, videos/, etc.)
2. **Organize by Date** - Sort files into YYYY/MM folders based on modification date
3. **Custom Rules** - User-defined rules in a config file (e.g., move *.psd to design/)
4. **Dry Run Mode** - Preview changes without moving any files
5. **Undo** - Reverse the last organize operation using a log file
6. **Watch Mode** - Monitor a directory and auto-organize new files
7. **Config Management** - Init, view, and edit config from CLI
8. **Verbose and Quiet Modes** - Control output verbosity

### CLI Interface
```
tidyfiles <command> [options]

Commands:
  tidyfiles sort <dir>       Organize files in a directory
  tidyfiles watch <dir>      Watch a directory and auto-organize
  tidyfiles undo             Reverse the last operation
  tidyfiles config init      Create default config file
  tidyfiles config show      Display current configuration
  tidyfiles config set <k=v> Set a config value
  tidyfiles stats <dir>      Show file type statistics for a directory

Options:
  -m, --mode <type|date|custom>  Organization mode (default: type)
  -d, --dry-run                  Preview without making changes
  -r, --recursive                Include subdirectories
  -v, --verbose                  Show detailed output
  -q, --quiet                    Suppress all output except errors
  -c, --config <path>            Path to config file
  --no-color                     Disable colored output
  --version                      Show version
  --help                         Show help
```

### User Flow
1. User installs globally: `npm install -g tidyfiles`
2. Initializes config: `tidyfiles config init`
3. Previews: `tidyfiles sort ~/Downloads --dry-run`
4. Executes: `tidyfiles sort ~/Downloads --mode type`
5. Checks result: files organized into typed folders
6. Undoes if needed: `tidyfiles undo`

## Tech Stack
- Runtime: Node.js 18+
- CLI framework: Commander.js
- Colored output: chalk
- File watching: chokidar
- Config: cosmiconfig (supports .tidyfilesrc, tidyfiles.config.js, package.json key)
- Progress: ora (spinners) + cli-progress (progress bars)
- Testing: Vitest
- Build: tsup (TypeScript to ESM/CJS)

### Structure
```
/
├── src/
│   ├── index.ts              # Entry point, CLI setup
│   ├── commands/
│   │   ├── sort.ts           # Sort command
│   │   ├── watch.ts          # Watch command
│   │   ├── undo.ts           # Undo command
│   │   ├── config.ts         # Config subcommands
│   │   └── stats.ts          # Stats command
│   ├── core/
│   │   ├── organizer.ts      # File organization logic
│   │   ├── rules.ts          # Rule matching engine
│   │   ├── watcher.ts        # Directory watcher
│   │   └── logger.ts         # Operation log for undo
│   ├── utils/
│   │   ├── fs.ts             # File system helpers
│   │   ├── output.ts         # Colored output formatting
│   │   └── config.ts         # Config loading/saving
│   └── types.ts              # TypeScript type definitions
├── tests/
│   ├── sort.test.ts
│   ├── rules.test.ts
│   ├── undo.test.ts
│   ├── config.test.ts
│   └── fixtures/             # Test file fixtures
├── man/
│   └── tidyfiles.1           # Man page (roff format)
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration File

### Default Config (.tidyfilesrc.json)
```json
{
  "defaultMode": "type",
  "recursive": false,
  "typeMap": {
    "images": ["jpg", "jpeg", "png", "gif", "svg", "webp", "ico"],
    "documents": ["pdf", "doc", "docx", "txt", "md", "rtf", "odt"],
    "videos": ["mp4", "mov", "avi", "mkv", "webm"],
    "audio": ["mp3", "wav", "flac", "aac", "ogg"],
    "archives": ["zip", "tar", "gz", "rar", "7z"],
    "code": ["js", "ts", "py", "rb", "go", "rs", "java", "c", "cpp", "h"],
    "data": ["json", "csv", "xml", "yaml", "yml", "sql"]
  },
  "customRules": [],
  "ignore": ["node_modules", ".git", ".DS_Store", "Thumbs.db"],
  "logFile": "~/.tidyfiles/operations.log"
}
```

### Custom Rules Format
```json
{
  "customRules": [
    { "pattern": "*.psd", "destination": "design/photoshop" },
    { "pattern": "screenshot-*", "destination": "screenshots" },
    { "pattern": "*.{test,spec}.{js,ts}", "destination": "tests" }
  ]
}
```

## Package Configuration

### package.json (required fields)
```json
{
  "name": "tidyfiles",
  "bin": {
    "tidyfiles": "./dist/index.js"
  },
  "type": "module",
  "files": ["dist", "man"]
}
```

### Entry Point Shebang
The compiled entry point (`dist/index.js`) MUST include a shebang line as the first line:
```
#!/usr/bin/env node
```
Configure tsup to add this automatically via the `banner` option in `tsup.config.ts`:
```typescript
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  banner: { js: '#!/usr/bin/env node' },
});
```

## Requirements
- TypeScript throughout
- Entry point must have `#!/usr/bin/env node` shebang for global CLI usage
- package.json must include `bin` field mapping `tidyfiles` to the compiled entry point
- Zero-config default behavior (works without a config file)
- Graceful error handling (permission denied, disk full, file in use)
- Cross-platform (macOS, Linux, Windows paths)
- Atomic operations (no partial moves on failure)
- Operation log stored in ~/.tidyfiles/ for undo capability
- Colored output respects NO_COLOR and --no-color flag
- Exit codes: 0 success, 1 error, 2 invalid usage
- Man page installable via `npm install -g`

## Testing
- Unit tests: Rule matching, config loading, file type detection (Vitest)
- Integration tests: Sort operations on temp directory fixtures
- Snapshot tests: CLI help output and stats output formatting
- Edge cases: Empty directories, hidden files, symlinks, permission errors
- All tests use temp directories (cleaned up after each test)

## Out of Scope
- GUI or web interface
- Cloud storage (S3, GCS) support
- File deduplication
- Content-based organization (analyzing file contents)
- Scheduled/cron execution
- Plugin system

## Success Criteria
- All 7 CLI commands work correctly
- Dry run accurately previews all operations
- Undo fully reverses the last operation
- Watch mode detects and organizes new files within 2 seconds
- Custom rules override default type mapping
- Config init creates a valid default config
- Stats shows accurate file counts by type
- All tests pass
- Man page renders correctly with `man tidyfiles`

---

**Purpose:** Tests Loki Mode's ability to build a well-structured CLI tool with proper argument parsing, config management, file system operations, and documentation. Expect ~30-45 minutes for full execution.
