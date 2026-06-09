# PRD: Purple Lab Platform -- Hosted Autonomous Development IDE

## Vision

Purple Lab becomes a hosted development platform like Replit, but for autonomous AI-powered development. Users describe what they want, agents build it, and they can browse/edit/preview/deploy -- all from the browser. Autonomi manages the infrastructure, storage, and compute. No CLI installation needed.

## Key Insight

Loki Mode already has 75+ commands and 120+ API endpoints. The platform doesn't need new capabilities -- it needs to surface existing ones through a production-grade web interface that matches or exceeds Replit's UX.

---

## Architecture: Local vs Hosted

**Current (Local):** User installs CLI, runs `loki start`, views results locally.

**Platform (Hosted):** User opens purplelab.dev (or app.autonomi.dev), types a prompt or picks a template, agents build on Autonomi infrastructure, user browses/edits/deploys from browser. Backend is the same server.py + run.sh, containerized per-workspace.

**Per-workspace container model:**
- Each project gets an isolated container (Docker or Firecracker)
- Container runs: Purple Lab server + loki CLI + language runtimes
- Persistent volume for project files
- Ephemeral compute for builds (scale to zero when idle)
- WebSocket proxy for real-time terminal/logs/preview

---

## Page Structure

### Page 1: Home (landing)
**URL:** `/`

**Layout:** Sidebar + main content (like Replit)

**Left sidebar:**
- Workspace name / avatar
- Navigation: Home, Projects, Templates, Integrations, Settings
- Bottom: Docs, Changelog, version

**Main content:**
- Prompt input: "Describe what you want to build..." with Plan toggle
- Category shortcuts: Website, API, CLI, Mobile, Bot, Data Pipeline (maps to Loki templates)
- Example prompts: rotated from curated list
- Recent Projects: card grid with thumbnail, name, date, status, file count

**Loki features surfaced:**
- `loki init` templates -> category shortcuts
- `loki plan` -> Plan toggle (shows estimate before building)
- `loki start` -> Submit prompt
- Session history -> Recent Projects

---

### Page 2: Projects List
**URL:** `/projects`

**Layout:** Sidebar + grid/list

- Search and filter (status, date, provider, complexity)
- Project cards: thumbnail (screenshot or file tree preview), name, status badge, date, file count, provider used
- Actions: Open, Delete, Duplicate, Export
- Sorting: newest first, name, status

**Loki features surfaced:**
- Session history API -> project list
- `loki export` -> Export action
- `loki share` -> Share as Gist action

---

### Page 3: Workspace (IDE)
**URL:** `/project/:id`

**Layout:** Full-screen IDE (already built in v6.41.0, needs enhancement)

**Left panel: File Explorer**
- File tree (exists)
- Search files (Cmd+P, exists)
- New file/folder (exists)
- Git status indicators (show modified/added/untracked via colors)

**Center panel: Editor**
- Monaco editor (exists)
- Tabs (exists)
- Save with Cmd+S (exists)
- Unsaved indicator (exists)

**Right panel: Preview**
- Live preview iframe (exists, needs enhancement)
- URL bar with current path
- Back/Forward/Refresh buttons
- Open in new tab button
- Auto-refresh on save (exists)

**Bottom panel: Activity (NEW)**
- Tabs: Terminal | Agent Log | Build Output | Quality Gates | AI Chat
- **Terminal tab:** Real-time loki session output (already streamed via WebSocket)
- **Agent Log tab:** Shows which agents are active, what they're working on (uses `/api/agents` and `/api/session/agents`)
- **Build Output tab:** Structured build phases -- RARV cycle visualization, iteration count, current phase
- **Quality Gates tab:** 9-gate status display (uses existing checklist/quality endpoints)
- **AI Chat tab:** Send messages to iterate on the project ("fix the login page", "add dark mode") -- triggers `loki start` with the prompt as PRD amendment

**Header toolbar:**
- Project name + status
- Provider selector: Claude / Codex / Gemini (uses `loki provider set`)
- Mode selector: Quick (3 iterations) / Standard (5) / Max (8+) -- maps to complexity tiers
- Run button (re-run build with current PRD)
- Stop/Pause/Resume buttons (exist)
- Share button -> GitHub Gist (`loki share`)
- Deploy button (future: `loki deploy`)
- Settings gear -> project config

---

### Page 4: Templates Gallery
**URL:** `/templates`

**Layout:** Grid of 22 template cards

Each card:
- Template name and description
- Category badge (Simple / Standard / Complex)
- Preview thumbnail
- "Use Template" button -> pre-fills PRD and navigates to Home

**Loki features surfaced:**
- All 22 `templates/*.md` files
- `loki plan` -> shows estimate on hover/click
- `loki init` -> scaffolds project

---

### Page 5: Integrations
**URL:** `/integrations`

**Layout:** List of integration cards

Integrations available:
- **GitHub**: Connect repo, import issues, create PRs (`loki github`, `loki run`)
- **Jira**: Bidirectional sync (`LOKI_JIRA_*` env vars)
- **Linear**: Issue sync (`LOKI_LINEAR_*` env vars)
- **Slack**: Notifications + slash commands (`LOKI_SLACK_*`)
- **Teams**: Adaptive Cards notifications (`LOKI_TEAMS_*`)
- **OpenTelemetry**: Trace export (`loki telemetry`)

Each card: name, description, status (Connected/Not configured), Configure button

---

### Page 6: Settings
**URL:** `/settings`

Sections:
- **Profile:** Name, email, avatar
- **Provider:** Default provider selection, API keys, model preferences
- **Enterprise:** Token management, OIDC/SSO config, audit log access
- **Notifications:** Email/Slack/Teams triggers
- **Billing:** Usage stats, cost tracking (uses `loki metrics` and `/api/cost`)

---

## Workspace Features Detail

### AI Chat Panel (Key differentiator from Replit)

This is the "Loki way" -- instead of just editing code, users can talk to the AI to iterate:

**Input:** Text prompt at bottom of workspace (like Replit's Agent chat)
**Behavior:**
1. User types "add a dark mode toggle"
2. Purple Lab creates amendment to PRD
3. Runs `loki start` in the background (or uses `loki quick` for small changes)
4. Real-time agent activity streams to Agent Log tab
5. File tree updates as agents create/modify files
6. Preview auto-refreshes when build completes
7. User can continue iterating

**This maps to Replit's "Agent modes":**
- **Quick mode** (like Lite): `loki quick "<prompt>"` -- 3 iterations, fast
- **Standard mode** (like Autonomous): `loki start` -- full RARV cycle
- **Max mode** (like Max): `loki start --complexity complex` -- extended iterations

### Quality Gates Panel

Shows the 9 Loki quality gates in real-time:
1. Static Analysis (CodeQL/ESLint)
2. 3-Reviewer Blind Review
3. Anti-Sycophancy Check
4. Severity Blocking (Critical/High)
5. Test Coverage (>80%)
6. Security Scan (OWASP)
7. Performance Check
8. Mock Detector
9. Mutation Detector

Each gate: name, status (pass/fail/pending), details expandable

### Agent Activity

Real-time grid showing which of the 41 agent types are active:
- Agent name, type, domain, model tier (Opus/Sonnet/Haiku)
- Current task
- Status (working/idle/completed)
- Duration

### Memory System Viewer

Browse what the AI has learned across sessions:
- Episodic memory: specific interactions
- Semantic memory: generalized patterns
- Procedural memory: learned skills
- Token economics: discovery vs read efficiency

### Code Review Panel

When quality gates run, show results:
- Findings by severity (Critical/High/Medium/Low)
- File + line links (click to jump in editor)
- Suggested fixes
- Approve/Reject actions

---

## API Endpoints Needed (New)

Most features use existing endpoints. New ones needed for hosted platform:

1. `POST /api/workspace/create` -- create new workspace (container)
2. `DELETE /api/workspace/:id` -- destroy workspace
3. `GET /api/workspace/:id/status` -- container health
4. `POST /api/chat` -- send AI chat message (triggers loki quick/start)
5. `GET /api/templates` -- already exists
6. `POST /api/project/duplicate` -- clone a project
7. `POST /api/project/export` -- export as zip
8. `GET /api/project/:id/screenshot` -- generate thumbnail (headless browser or placeholder)

---

## Implementation Phases

### Phase 1: Platform Shell (1 week)
- Sidebar navigation with page routing
- Home page with prompt input + category shortcuts + recent projects
- Projects list page with cards
- Templates gallery page
- Settings page shell

### Phase 2: Enhanced Workspace (1 week)
- Bottom activity panel with tabs (Terminal, Agents, Build, Quality, Chat)
- AI Chat input that triggers builds
- Quality gates real-time display
- Agent activity grid
- Preview URL bar with navigation
- Mode selector (Quick/Standard/Max)

### Phase 3: Hosted Infrastructure (2 weeks)
- Per-workspace container orchestration
- Persistent storage per project
- User authentication (OIDC/email)
- Usage metering and billing hooks
- Custom domain for previews (project-id.purplelab.dev)

### Phase 4: Polish (1 week)
- Project thumbnails/screenshots
- Integrations settings page
- Memory system browser
- Code review panel
- Onboarding flow for new users

---

## What We Already Have vs What's New

| Feature | Status | Source |
|---------|--------|--------|
| Monaco editor | DONE | v6.40.0 |
| File tree + CRUD | DONE | v6.40.0 |
| Tabs | DONE | v6.41.0 |
| Quick Open (Cmd+P) | DONE | v6.41.0 |
| Live preview | DONE | v6.39.0 |
| Preview auto-refresh | DONE | v6.41.0 |
| URL routing | DONE | v6.39.0 |
| Session persistence | DONE | v6.39.0 |
| Resizable panes | DONE | v6.40.0 |
| Error boundaries | DONE | v6.38.4 |
| WebSocket real-time | DONE | v6.36.0 |
| Session history | DONE | v6.36.1 |
| Provider selection | DONE | v6.35.0 |
| Template gallery | EXISTS (API) | Needs UI page |
| Quality gates display | EXISTS (API) | Needs panel |
| Agent activity | EXISTS (API) | Needs panel |
| Memory browser | EXISTS (API) | Needs panel |
| Code review | EXISTS (API) | Needs panel |
| AI Chat | NEEDS BUILD | New component |
| Sidebar navigation | NEEDS BUILD | New layout |
| Projects list page | NEEDS BUILD | New page |
| Settings page | NEEDS BUILD | New page |
| Bottom activity panel | NEEDS BUILD | New component |
| Container orchestration | NEEDS BUILD | Infrastructure |

---

## Design Language

Match Autonomi design system (already used in Purple Lab):
- Light bg: #FFFEFB, card: #FFFFFF, accent: #553DE9
- Font: Inter (body), JetBrains Mono (code), DM Serif Display (headings)
- Glass effect on panels
- Rounded corners (xl/2xl)
- Minimal, clean, professional -- not flashy

---

## Success Metrics

- User can go from prompt to working preview in under 5 minutes
- Page refresh at any point preserves full state
- Preview renders all relative assets correctly
- Quality gates visible in real-time during builds
- AI chat iteration feels natural (no context loss between prompts)
- 95%+ uptime for hosted workspaces
