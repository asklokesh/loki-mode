# PRD: Purple Lab Platform v2 -- Hosted Autonomous Development IDE
## Post-Feedback Final Plan (3 review loops completed)

---

## Feedback Applied

Three review loops identified these critical gaps in v1 of this PRD:
1. **Product review:** Missing deployment, secrets, import project, issue-driven workflow; `loki plan` should be default; timeline unrealistic
2. **Engineering review:** Only 2 pages exist today; sidebar/navigation is the foundational gap; Phase 1 needs auth to work as hosted platform
3. **Competitive review:** Bottom activity panel is on wrong page; AI Chat is missing entirely; platform feels 40% done -- needs structural work before features

---

## Current State (v6.41.0) -- Honest Assessment

**Working:**
- Monaco editor with syntax highlighting (17+ languages)
- File tree with CRUD (create, save, delete files/dirs)
- Tabs with unsaved indicator, Cmd+S save
- Quick Open (Cmd+P) fuzzy file search
- Live preview iframe with auto-refresh on save
- Resizable split panes
- URL routing (/project/:id persists on refresh)
- Session history with status detection
- WebSocket real-time streaming during builds
- Error boundaries on all panels

**Not working / missing:**
- NO sidebar navigation (users stuck in IDE, can't browse projects)
- NO projects list page
- NO templates gallery page
- NO settings page
- NO AI chat (can't iterate by talking to agents)
- Bottom activity panel (agents, quality gates, build output) only on HomePage, NOT in IDE workspace
- NO deployment capability
- NO secrets management
- NO import project flow
- Preview has no URL bar, back/forward, or open-in-new-tab

---

## Revised Architecture

### Phase 1: Platform Shell + Navigation (buildable now)
**Goal:** Make Purple Lab feel like a real platform, not a disconnected prototype.

**1a. Global Sidebar (all pages)**
- Logo + "Purple Lab" branding
- Nav items: Home, Projects, Templates, Settings
- Active page highlight
- Connection status indicator
- Bottom: Docs link, version

**1b. Projects Page (/projects)**
- Card grid from `/api/sessions/history` (already returns status, file count, PRD snippet)
- Search bar, status filter (completed/started/empty)
- Actions per card: Open, Delete, Export as zip
- Empty state: "No projects yet. Start building."

**1c. Templates Gallery (/templates)**
- Card grid from `/api/templates` (22 templates, already served)
- Category badges: Simple (green), Standard (blue), Complex (orange)
- Click -> pre-fills PRD on home page, user confirms and builds
- Template preview (show first 10 lines of PRD content)

**1d. Fix Workspace Navigation**
- Add sidebar to ProjectPage (same sidebar as all pages)
- Add breadcrumb: Projects > project-name
- Back button navigates to /projects (not just /)

**Files to create/modify:**
- NEW: `web-app/src/components/Sidebar.tsx`
- NEW: `web-app/src/pages/ProjectsPage.tsx`
- NEW: `web-app/src/pages/TemplatesPage.tsx`
- NEW: `web-app/src/pages/SettingsPage.tsx` (shell)
- MODIFY: `web-app/src/App.tsx` (add routes, wrap in sidebar layout)
- MODIFY: `web-app/src/pages/ProjectPage.tsx` (add sidebar)

---

### Phase 2: Enhanced Workspace (buildable now)
**Goal:** Bring the monitoring panels into the IDE and add AI chat.

**2a. Bottom Activity Panel in ProjectWorkspace**
Tabbed panel below the editor (collapsible, resizable height):
- **Build Log:** Real-time loki output (WebSocket, already works on HomePage)
- **Agents:** Active agent cards with status (already built as AgentDashboard)
- **Quality Gates:** 8-gate display (already built as QualityGatesPanel)
- **AI Chat:** NEW -- text input that sends prompts to iterate on the project

**2b. AI Chat (key differentiator)**
- Input at bottom: "Make the header blue" or "Add user authentication"
- Backend: `POST /api/sessions/:id/chat` which runs `loki quick "<prompt>"` in the project directory
- Output streams to Build Log tab
- File tree refreshes after completion
- Preview auto-refreshes

**2c. Mode Selector**
In workspace header toolbar:
- Quick (fast, 3 iterations) -- `loki quick`
- Standard (full RARV, 5 iterations) -- `loki start`
- Max (extended, 8+ iterations) -- `loki start --complexity complex`

**2d. Plan Before Build**
Default behavior: when user submits a PRD, run `loki plan` first.
Show: complexity tier, estimated cost, iteration count, phases.
User confirms "Build" or adjusts.

**2e. Preview Toolbar**
URL bar showing current preview path, Refresh button, Open in New Tab button.

**Files to create/modify:**
- NEW: `web-app/src/components/ActivityPanel.tsx` (bottom tabs: Build Log, Agents, Quality, Chat)
- NEW: `web-app/src/components/AIChatPanel.tsx`
- NEW: `web-app/src/components/PreviewToolbar.tsx`
- MODIFY: `web-app/src/components/ProjectWorkspace.tsx` (add bottom panel, mode selector)
- MODIFY: `web-app/server.py` (add POST /api/sessions/:id/chat endpoint)

---

### Phase 3: Import + Deploy + Secrets (needs backend work)
**Goal:** Close the loop -- users can bring code in and ship code out.

**3a. Import Project**
- "Import from GitHub" button on Projects page
- Backend: clone repo, run `loki onboard` to analyze, generate CLAUDE.md
- User lands in IDE with file tree populated
- Uses `loki explain` to show architecture summary on first open

**3b. Deploy to Public URL**
- "Deploy" button in workspace header
- Backend: build the project (npm build / python build), serve on a public URL
- URL format: `{project-id}.purplelab.dev` (or subdomain on autonomi.dev)
- Show deployment status and live URL
- Uses Docker container already present in workspace

**3c. Secrets / Environment Variables**
- Per-project secrets pane in workspace settings
- Stored encrypted, injected into build container as env vars
- UI: key-value editor with show/hide toggle
- Uses existing `loki secrets` CLI command

**3d. Cost Tracking**
- Visible in workspace header: current session cost estimate
- Uses existing `/api/cost` and `/api/budget` endpoints
- Budget limit warning when approaching threshold

---

### Phase 4: Hosted Infrastructure (requires infra work)
**Goal:** Multi-tenant hosted platform with user isolation.

- Per-user container orchestration (Docker or Firecracker)
- Persistent storage per workspace
- User auth (email + OAuth via existing OIDC support)
- Usage metering and billing
- Custom preview domains
- Provider failover (`loki failover`) for platform uptime

---

## What to Cut from v1

Based on feedback:
- Memory System Viewer (power-user debug tool, not customer-facing)
- Full Integrations page (keep GitHub only, defer Jira/Linear/Slack/Teams)
- 41-agent grid (most sessions have 1-3 agents active; show compact list instead)
- Code Review panel (let quality gates surface findings inline)
- Collaboration/multiplayer (acknowledged as future need, not v1)
- Database provisioning (out of scope for v1)

---

## What to Fix Before Building (bugs from competitive review)

1. Preview only auto-refreshes on HTML/CSS/JS saves (not .py or .json)
2. Quick Open should show all results with scrolling (remove slice(0,20) limit)
3. File creation should optimistically update tree (no wait for API)
4. ProjectWorkspace should be read-only for completed sessions
5. No-HTML projects should show helpful message instead of blank preview

---

## Loki Features to Surface (under-leveraged)

| Feature | Where in UI | Backend |
|---------|-------------|---------|
| `loki plan` | Plan step before every build | Exists |
| `loki run <issue>` | "Import from Issue" on Home page | Exists |
| `loki review` | Right-click file -> "Review this file" | Exists |
| `loki test` | Right-click file -> "Generate tests" | Exists |
| `loki explain` | "Explain Project" button in workspace | Exists |
| `loki onboard` | Import project flow | Exists |
| `loki failover` | Auto-provider switching | Exists |
| `loki trigger` | Scheduled builds (cron) | Exists |
| `loki ci` | Quality checks on save | Exists |
| `--budget` | Cost display in header | Exists |
| `--compliance` | Compliance preset selector | Exists |

---

## Realistic Timeline

- **Phase 1 (Platform Shell):** 3-4 days -- sidebar, projects page, templates page, settings shell, workspace nav fix
- **Phase 2 (Enhanced Workspace):** 5-7 days -- activity panel, AI chat, mode selector, plan-before-build, preview toolbar
- **Phase 3 (Import + Deploy + Secrets):** 2-3 weeks -- needs backend work for GitHub import, deploy pipeline, secrets encryption
- **Phase 4 (Hosted Infra):** 2-3 months -- container orchestration, auth, billing, custom domains

**MVP milestone (Phase 1 + 2): ~2 weeks**

---

## Success Criteria (revised)

- User can go from prompt to working preview in under 3 minutes
- User can iterate via AI chat without starting a new session
- Page refresh at any point preserves full state
- User can browse all past projects and templates from sidebar
- Plan step shows cost estimate before every build
- Preview renders all relative assets correctly
- Quality gates visible during builds
- Cost tracking visible in workspace header
