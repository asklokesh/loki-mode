# Agent 10: Full-Stack Project E2E Testing - Bug Fixes

## Summary

Audited all 21 PRD templates, the CLI `loki init` scaffolding system, the web-app file browser, and the file watcher subsystem. Found and fixed 12 bugs across templates, CLI, server, and tests.

## Known Bugs Fixed

### BUG-TPL-001: SaaS template references inconsistent NextAuth.js patterns
- **File:** `templates/saas-starter.md`
- **Issue:** Template specifies NextAuth.js v5 in tech stack but uses v4-style route pattern in API docs (`/api/auth/[...nextauth]` without mentioning the v5 `auth.ts` config approach).
- **Fix:** Updated the OAuth route description to reference both the Auth.js v5 config file (`src/lib/auth.ts`) and the catch-all route, making the pattern consistent.

### BUG-TPL-002: CLI template missing shebang and bin configuration
- **File:** `templates/cli-tool.md`
- **Issue:** The CLI tool template had no mention of `#!/usr/bin/env node` shebang, no `bin` field in package.json, and no tsup banner configuration. A CLI tool built from this template would fail on `npm install -g` because the entry point wouldn't be executable.
- **Fix:** Added a "Package Configuration" section with the required `bin` field in package.json, the shebang requirement, and tsup `banner` configuration to auto-inject the shebang into compiled output.

### BUG-TPL-003: Discord bot template missing environment variable handling
- **File:** `templates/discord-bot.md`
- **Issue:** Template referenced `dotenv` in tech stack and `.env.example` in project structure but never specified what environment variables are needed. The AI agent would have to guess `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, etc.
- **Fix:** Added a comprehensive "Environment Variables" section with required vars (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`), optional vars (`DISCORD_GUILD_ID`, `LOG_CHANNEL_ID`, etc.), a complete `.env.example` template, and startup validation code.

### BUG-PROJ-001: File tree too shallow for monorepo structures
- **File:** `web-app/server.py` (line 2366)
- **Issue:** `_build_file_tree()` had `max_depth=4`, which is insufficient for monorepo structures like `packages/frontend/src/components/ui/Button.tsx` (6 levels). Files beyond 4 levels were silently omitted from the file browser.
- **Fix:** Increased `max_depth` from 4 to 8. Added a `MAX_CHILDREN=500` per-directory cap with a "... (N more items)" indicator to prevent memory issues on very large projects. Also added more noise directories to the ignore list: `vendor`, `.turbo`, `.nx`, `coverage`, `.parcel-cache`.

### BUG-PROJ-002: File tree doesn't update after directory moves/renames
- **File:** `web-app/server.py` (line 429)
- **Issue:** The `FileChangeHandler.on_any_event()` method filtered directory events to only `("created", "deleted")`, dropping `"moved"` events. When the AI renamed or moved directories during development, the file tree in the browser would not update until a manual refresh.
- **Fix:** Added `"moved"` to the allowed directory event types: `("created", "deleted", "moved")`.

## Additional Bugs Discovered and Fixed

### BUG-TPL-004: Phantom `saas-app` template entry (CRITICAL)
- **Files:** `autonomy/loki` (line 7387), `tests/test-init-command.sh`
- **Issue:** The `TEMPLATE_NAMES` array in `cmd_init()` contained `saas-app` which has no corresponding template file. Only `saas-starter.md` exists. This caused `loki init --template saas-app` to pass validation (the name is in the array) but then fail at file lookup with a confusing "Unknown template" error. The init tests were also broken, asserting `saas-app` in config.
- **Fix:** Removed `saas-app` from the `TEMPLATE_NAMES` array, removed its label from `_get_template_label()`, updated the help text examples to reference `saas-starter`, updated the test file to use `saas-starter` in all 4 affected test cases.

### BUG-TPL-005: REST API Auth template uses .js extensions with "TypeScript throughout"
- **File:** `templates/rest-api-auth.md`
- **Issue:** The template says "TypeScript throughout" in requirements but lists all files with `.js` extensions in the project structure. Also referenced `Jest + supertest` instead of `Vitest + supertest` (inconsistent with other templates).
- **Fix:** Changed all file extensions from `.js` to `.ts` in the project structure, added `tsconfig.json` to the file tree, updated testing framework from "Jest + supertest" to "Vitest + supertest".

### BUG-TPL-006: Templates missing environment variable specifications
- **Files:** `templates/slack-bot.md`, `templates/rest-api.md`, `templates/rest-api-auth.md`
- **Issue:** Templates referenced `.env.example` in their project structures but never specified what environment variables are needed. The autonomous agent would have to invent variable names and defaults.
- **Fix:** Added "Environment Variables" sections with complete `.env.example` content and startup validation requirements to all three templates.

### BUG-TPL-007: api-only README entry says Jest, template uses Vitest
- **File:** `templates/README.md`
- **Issue:** The README template gallery listed "Express, in-memory, Jest" for api-only.md but the actual template specifies Vitest.
- **Fix:** Updated README to say "Vitest" instead of "Jest".

### BUG-TPL-008: Template count mismatch across documentation
- **Files:** `CLAUDE.md`, `autonomy/loki`
- **Issue:** CLAUDE.md said "13 PRD templates" but there are 21. The loki CLI said "22 built-in template names" but there are 21 (after removing the phantom `saas-app`).
- **Fix:** Updated CLAUDE.md to "21 PRD templates". Updated loki CLI comment to "21 built-in template names" and help text to "21 PRD templates".

### BUG-TPL-009: 7 templates missing purpose footer
- **Files:** `dashboard.md`, `data-pipeline.md`, `game.md`, `microservice.md`, `npm-library.md`, `slack-bot.md`, `web-scraper.md`
- **Issue:** The README says every template should have a "Purpose Footer" explaining what it tests. 7 templates were missing this section entirely. Also missing: estimated execution time.
- **Fix:** Added purpose footer with description and time estimate to all 7 templates.

### BUG-TPL-010: static-landing-page missing Success Criteria
- **File:** `templates/static-landing-page.md`
- **Issue:** This template had no "Success Criteria" section and no "Testing" section, unlike all other templates. The autonomous agent would not know when to stop.
- **Fix:** Added a "Success Criteria" section with 6 measurable criteria. Also added estimated time to the purpose footer.

## Validation Results

- `bash -n autonomy/loki` -- PASS
- `python3 -c "ast.parse(open('web-app/server.py').read())"` -- PASS
- `bash -n tests/test-init-command.sh` -- PASS
- All 21 template markdown files have properly closed code blocks -- PASS
- All 21 templates now have purpose footers with time estimates -- PASS
- No remaining references to phantom `saas-app` template in source code -- PASS

## Files Changed

| File | Change |
|------|--------|
| `web-app/server.py` | Fixed file watcher to handle directory moves; increased file tree depth to 8; added monorepo-friendly ignore list and child cap |
| `autonomy/loki` | Removed phantom `saas-app` template; fixed template count (22->21); updated help text examples |
| `tests/test-init-command.sh` | Updated 4 test cases from `saas-app` to `saas-starter` |
| `templates/saas-starter.md` | Fixed NextAuth.js v5 route pattern reference |
| `templates/cli-tool.md` | Added shebang, bin field, and tsup banner configuration |
| `templates/discord-bot.md` | Added environment variables section with required/optional vars |
| `templates/slack-bot.md` | Added environment variables section |
| `templates/rest-api-auth.md` | Fixed .js to .ts extensions; added env vars section; fixed Jest to Vitest |
| `templates/rest-api.md` | Added environment variables section |
| `templates/README.md` | Fixed "Jest" to "Vitest" for api-only entry |
| `templates/static-landing-page.md` | Added Success Criteria section and time estimate |
| `templates/dashboard.md` | Added purpose footer |
| `templates/data-pipeline.md` | Added purpose footer |
| `templates/game.md` | Added purpose footer |
| `templates/microservice.md` | Added purpose footer |
| `templates/npm-library.md` | Added purpose footer |
| `templates/slack-bot.md` | Added purpose footer |
| `templates/web-scraper.md` | Added purpose footer |
| `CLAUDE.md` | Fixed template count from 13 to 21 |
