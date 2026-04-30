# Use Cases

Real-world examples and patterns for using Loki Mode effectively.

---

## Individual Developer

### Build a Side Project

**Scenario:** You have a weekend to build a todo app.

**Spec (PRD markdown -- todo-app.md):**
```markdown
# Todo Application

## Overview
Simple, elegant todo app with local storage.

## Requirements
- [ ] Add/edit/delete todos
- [ ] Mark as complete
- [ ] Filter by status
- [ ] Dark mode support
- [ ] Persist in localStorage

## Tech Stack
- React 18 + TypeScript
- TailwindCSS
- Vite
```

**Execution:**
```bash
loki start todo-app.md
```

**Result:** Complete working app in ~2 hours.

---

### Fix a Bug from GitHub Issue

**Scenario:** You have a bug report on GitHub.

```bash
# Use the GitHub issue as the spec and start
loki issue https://github.com/myorg/myapp/issues/42 --start

# Or step by step
loki issue 42 --dry-run  # Preview
loki issue 42            # Generate spec (PRD markdown)
loki start .loki/prd/issue-42.md
```

---

### Rapid Prototyping

**Scenario:** Test a business idea quickly.

**Spec (PRD markdown -- mvp.md):**
```markdown
# Landing Page MVP

## Goal
Validate market interest in AI writing assistant.

## Requirements
- [ ] Hero section with value proposition
- [ ] Feature highlights (3 cards)
- [ ] Email signup form (Mailchimp integration)
- [ ] Testimonials section
- [ ] Mobile responsive

## Constraints
- Single page
- No backend needed
- Deploy to Vercel
```

**Execution:**
```bash
loki start mvp.md --simple  # Use simple complexity
```

---

## Startup Team

### Sprint Automation

**Scenario:** Automate routine sprint tasks.

**Setup:**
```bash
# Import sprint issues from GitHub
export LOKI_GITHUB_IMPORT=true
export LOKI_GITHUB_LABELS="sprint-42"
export LOKI_GITHUB_MILESTONE="v2.0"

# Start with parallel mode
loki start --github --parallel
```

### Nightly Builds

**CI/CD Integration (.github/workflows/loki.yml):**
```yaml
name: Nightly Loki Build
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM daily

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Loki Mode
        run: npm install -g loki-mode

      - name: Run Loki Mode
        env:
          LOKI_DASHBOARD: 'false'
          LOKI_MAX_ITERATIONS: 50
          LOKI_COMPLEXITY: simple
        run: |
          loki start ./nightly-tasks.md --background
          loki logs -f
```

### Feature Development

**Scenario:** Implement a complete feature across multiple services.

**Spec (PRD markdown -- auth-system.md):**
```markdown
# Authentication System

## Overview
Implement OAuth 2.0 authentication with multiple providers.

## Requirements

### Backend
- [ ] OAuth 2.0 flow implementation
- [ ] Google provider
- [ ] GitHub provider
- [ ] JWT token generation
- [ ] Refresh token rotation
- [ ] Session management

### Frontend
- [ ] Login page with provider buttons
- [ ] OAuth callback handling
- [ ] Token storage (httpOnly cookies)
- [ ] Auto-refresh logic
- [ ] Logout functionality

### Security
- [ ] CSRF protection
- [ ] Rate limiting on auth endpoints
- [ ] Audit logging for auth events

## Tech Stack
- Backend: Node.js + Express
- Frontend: React
- Database: PostgreSQL
```

**Execution:**
```bash
# Enable parallel for faster execution
export LOKI_PARALLEL_MODE=true
export LOKI_MAX_PARALLEL_SESSIONS=3

loki start auth-system.md --complex
```

---

## Enterprise Deployment

### Secure CI/CD Pipeline

**Scenario:** Deploy Loki Mode in enterprise CI/CD.

**Setup:**
```bash
# Generate CI token
loki enterprise token generate ci-pipeline \
  --scopes "read,write,execute" \
  --expires 90

# Configure environment
export LOKI_ENTERPRISE_AUTH=true
export LOKI_ENTERPRISE_AUDIT=true
export LOKI_SANDBOX_MODE=true
export LOKI_STAGED_AUTONOMY=true
```

**Jenkins Pipeline:**
```groovy
pipeline {
    agent any

    environment {
        LOKI_API_TOKEN = credentials('loki-ci-token')
        LOKI_ENTERPRISE_AUTH = 'true'
        LOKI_ENTERPRISE_AUDIT = 'true'
    }

    stages {
        stage('Run Loki Mode') {
            steps {
                sh 'loki start ./feature-prd.md --sandbox'
            }
        }

        stage('Review') {
            steps {
                input message: 'Review Loki output and approve?'
            }
        }

        stage('Deploy') {
            steps {
                sh 'npm run deploy'
            }
        }
    }

    post {
        always {
            sh 'loki enterprise audit tail > audit-log.txt'
            archiveArtifacts artifacts: 'audit-log.txt'
        }
    }
}
```

### Multi-Project Orchestration

**Scenario:** Manage microservices development across teams.

**Setup:**
```bash
# Register all projects
loki projects register ~/services/api-gateway
loki projects register ~/services/user-service
loki projects register ~/services/order-service
loki projects register ~/services/notification-service

# Or auto-discover
loki projects discover

# Check health
loki projects health

# Sync learnings
loki projects sync
```

### Compliance Workflow

**Scenario:** Financial services with strict compliance.

**Configuration:**
```bash
# Maximum security settings
export LOKI_ENTERPRISE_AUTH=true
export LOKI_ENTERPRISE_AUDIT=true
export LOKI_SANDBOX_MODE=true
export LOKI_STAGED_AUTONOMY=true
export LOKI_AUTONOMY_MODE=supervised
export LOKI_ALLOWED_PATHS="/app/src,/app/tests"
export LOKI_BLOCKED_COMMANDS="rm -rf,dd,mkfs,curl,wget"

# Disable risky phases
export LOKI_PHASE_WEB_RESEARCH=false
```

**Audit Export:**
```bash
# Export audit logs for compliance review
loki enterprise audit summary > monthly-audit.json

# Forward to SIEM
curl -X POST https://siem.company.com/api/logs \
  -H "Authorization: Bearer $SIEM_TOKEN" \
  -d @monthly-audit.json
```

---

## Integration Patterns

### Slack Notifications

```bash
export LOKI_SLACK_WEBHOOK="https://hooks.slack.com/services/T00/B00/xxx"

# Test
loki notify test "Loki Mode connected!"

# Automatic notifications on:
# - Session start
# - Task completion
# - Errors
# - Session end
```

### Discord Notifications

```bash
export LOKI_DISCORD_WEBHOOK="https://discord.com/api/webhooks/xxx/yyy"
loki notify status
```

### Custom Webhook Integration

**Scenario:** Send events to custom monitoring system.

```bash
export LOKI_WEBHOOK_URL="https://monitoring.company.com/api/events"
```

**Payload format:**
```json
{
  "event": "task_complete",
  "project": "my-app",
  "title": "Task Completed",
  "message": "Implemented user authentication",
  "timestamp": "2026-02-02T12:00:00Z",
  "metadata": {}
}
```

---

## VS Code Integration

### Daily Development

1. Install VS Code extension (search "Loki Mode")
2. Open command palette: `Cmd+Shift+P`
3. Type "Loki Mode: Start Session"
4. Select your spec file (PRD markdown)
5. Monitor in sidebar

### Features

- **Chat Sidebar** - Interact with session
- **Log Viewer** - Real-time logs
- **Status Bar** - Session status
- **Commands** - Start/stop/pause from VS Code

---

## Advanced Patterns

### Conditional Execution

```bash
# Only run certain phases
export LOKI_PHASE_E2E_TESTS=false
export LOKI_PHASE_PERFORMANCE=false

# Quick iteration for frontend work
export LOKI_COMPLEXITY=simple
```

### Custom Completion Conditions

```bash
# Stop when all tests pass
export LOKI_COMPLETION_PROMISE="ALL TESTS PASSING"

# Or specific milestone
export LOKI_COMPLETION_PROMISE="DEPLOYMENT COMPLETE"
```

### Human-in-the-Loop

```bash
# Enable supervised mode
export LOKI_AUTONOMY_MODE=supervised

# Or checkpoint mode for less interruption
export LOKI_AUTONOMY_MODE=checkpoint
```

### Cross-Project Learning

```bash
# Check what Loki has learned
loki memory stats

# Search for patterns
loki memory search "database migration"

# Apply learnings to new project
# (Automatic - Loki uses learnings from all projects)
```
