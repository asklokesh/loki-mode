# Loki Mode v5.51.0 -- Integration Cookbook

Step-by-step guides for connecting Loki Mode to external services. Each integration is opt-in and configured via environment variables.

---

## Slack Integration

### Prerequisites

- A Slack workspace with admin access
- A Slack App created at https://api.slack.com/apps
- Bot Token Scopes: `chat:write`, `commands`, `incoming-webhook`

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LOKI_SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (starts with `xoxb-`) |
| `LOKI_SLACK_SIGNING_SECRET` | Yes | Used to verify inbound webhook requests |
| `LOKI_SLACK_CHANNEL` | No | Default channel for notifications (e.g., `#loki-alerts`) |
| `LOKI_SLACK_WEBHOOK_URL` | No | Incoming webhook URL for simple notifications |

### Configuration

1. **Create a Slack App:**

   Go to https://api.slack.com/apps and click "Create New App". Choose "From scratch" and select your workspace.

2. **Add Bot Token Scopes:**

   Navigate to "OAuth & Permissions" and add these Bot Token Scopes:
   - `chat:write` -- Post messages
   - `commands` -- Handle slash commands
   - `incoming-webhook` -- Post via webhook

3. **Install to Workspace:**

   Click "Install to Workspace" and authorize. Copy the Bot User OAuth Token.

4. **Configure Signing Secret:**

   Under "Basic Information", copy the Signing Secret.

5. **Set Environment Variables:**

   ```bash
   export LOKI_SLACK_BOT_TOKEN="xoxb-your-bot-token"
   export LOKI_SLACK_SIGNING_SECRET="your-signing-secret"
   export LOKI_SLACK_CHANNEL="#loki-alerts"
   ```

6. **Enable Slash Commands (optional):**

   Under "Slash Commands", create:
   - `/loki-status` -- Get current execution status
   - `/loki-approve` -- Approve a pending gate

   Set the Request URL to your Loki Mode dashboard endpoint:
   ```
   https://your-loki-host:57374/api/webhooks/slack
   ```

### Verification

```bash
# Test bot token validity
curl -H "Authorization: Bearer $LOKI_SLACK_BOT_TOKEN" \
  https://slack.com/api/auth.test

# Test notification delivery
curl -X POST "$LOKI_SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"text": "Loki Mode integration test"}'
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| `not_authed` error | Verify `LOKI_SLACK_BOT_TOKEN` is set and valid |
| Webhook signature fails | Check `LOKI_SLACK_SIGNING_SECRET` matches Slack app settings |
| Messages not appearing | Ensure bot is invited to the target channel |
| Slash command timeout | Check Loki Mode dashboard is accessible from Slack servers |

---

## Microsoft Teams Integration

### Prerequisites

- Microsoft Teams with admin access
- Incoming Webhook connector configured on a channel
- Ability to create Adaptive Cards

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LOKI_TEAMS_WEBHOOK_URL` | Yes | Incoming Webhook URL from Teams connector |
| `LOKI_TEAMS_WEBHOOK_SECRET` | No | Shared secret for HMAC verification of inbound requests |

### Configuration

1. **Create an Incoming Webhook:**

   In your Teams channel:
   - Click the `...` menu on the channel
   - Select "Connectors" (or "Workflows" in newer versions)
   - Find "Incoming Webhook" and click "Configure"
   - Name it "Loki Mode" and save
   - Copy the webhook URL

2. **Set Environment Variables:**

   ```bash
   export LOKI_TEAMS_WEBHOOK_URL="https://your-tenant.webhook.office.com/webhookb2/..."
   export LOKI_TEAMS_WEBHOOK_SECRET="your-shared-secret"
   ```

3. **Notification Format:**

   Loki Mode sends Adaptive Cards to Teams with:
   - Execution status (running, completed, failed)
   - Task progress summary
   - Quality gate results
   - Approval request buttons (when approval gates are configured)

### Verification

```bash
# Test webhook delivery
curl -X POST "$LOKI_TEAMS_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "message",
    "attachments": [{
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [{
          "type": "TextBlock",
          "text": "Loki Mode integration test",
          "weight": "bolder"
        }]
      }
    }]
  }'
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| HTTP 400 from webhook | Verify the Adaptive Card JSON is valid |
| HTTP 403 from webhook | Webhook URL may have expired; recreate the connector |
| No notifications | Check `LOKI_TEAMS_WEBHOOK_URL` is set |
| HMAC verification fails | Ensure `LOKI_TEAMS_WEBHOOK_SECRET` matches on both sides |

---

## Jira Integration

### Prerequisites

- Jira Cloud instance (e.g., `https://company.atlassian.net`)
- User email and API token (create at https://id.atlassian.com/manage/api-tokens)
- Project key (e.g., `PROJ`)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LOKI_JIRA_URL` | Yes | Jira Cloud base URL |
| `LOKI_JIRA_EMAIL` | Yes | Jira user email for authentication |
| `LOKI_JIRA_TOKEN` | Yes | Jira API token |
| `LOKI_JIRA_PROJECT_KEY` | No | Default Jira project key |

### Configuration

1. **Create a Jira API Token:**

   Go to https://id.atlassian.com/manage/api-tokens and create a new token.

2. **Set Environment Variables:**

   ```bash
   export LOKI_JIRA_URL="https://company.atlassian.net"
   export LOKI_JIRA_EMAIL="user@company.com"
   export LOKI_JIRA_TOKEN="your-api-token"
   export LOKI_JIRA_PROJECT_KEY="PROJ"
   ```

3. **Epic Sync:**

   Import a Jira epic as a PRD:

   ```javascript
   const { JiraApiClient } = require('./src/integrations/jira/api-client');
   const { JiraSyncManager } = require('./src/integrations/jira/sync-manager');

   const api = new JiraApiClient({
     baseUrl: process.env.LOKI_JIRA_URL,
     email: process.env.LOKI_JIRA_EMAIL,
     apiToken: process.env.LOKI_JIRA_TOKEN,
   });

   const sync = new JiraSyncManager({ apiClient: api, projectKey: 'PROJ' });

   // Import epic as PRD
   const { prd, metadata } = await sync.syncFromJira('PROJ-123');

   // Sync RARV status back to Jira
   await sync.syncToJira('PROJ-123', {
     phase: 'building',
     progress: 45,
     details: 'Implementing authentication module',
   });
   ```

4. **Status Mapping:**

   Loki Mode RARV phases map to Jira statuses:

   | Loki Phase | Jira Status |
   |------------|-------------|
   | planning | In Progress |
   | building | In Progress |
   | testing | In Review |
   | reviewing | In Review |
   | deployed | Done |
   | completed | Done |
   | failed | Blocked |
   | blocked | Blocked |

5. **Sub-Task Creation:**

   Loki Mode can create Jira sub-tasks mirroring its internal task decomposition:

   ```javascript
   const keys = await sync.createSubTasks('PROJ-123', [
     { title: 'Set up database schema', description: 'Create tables for user model' },
     { title: 'Implement API endpoints', description: 'REST endpoints for CRUD' },
   ]);
   // keys: ['PROJ-124', 'PROJ-125']
   ```

### Verification

```bash
# Test Jira API access
curl -u "$LOKI_JIRA_EMAIL:$LOKI_JIRA_TOKEN" \
  "$LOKI_JIRA_URL/rest/api/3/myself" | python3 -m json.tool

# Test epic fetch
curl -u "$LOKI_JIRA_EMAIL:$LOKI_JIRA_TOKEN" \
  "$LOKI_JIRA_URL/rest/api/3/issue/PROJ-123" | python3 -m json.tool
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| HTTP 401 | Check email and API token are correct |
| HTTP 403 | User lacks permission on the Jira project |
| Epic children not found | Verify epic link field name in your Jira instance |
| Status transition fails | Check available transitions with `getTransitions()` |
| JQL injection error | Epic keys are validated against `^[A-Z][A-Z0-9_]+-\d+$` |

---

## Linear Integration

### Prerequisites

- Linear workspace
- API key (create at Settings > API > Personal API Keys)
- Team ID (found in team settings URL)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LOKI_LINEAR_API_KEY` | Yes | Linear personal API key |
| `LOKI_LINEAR_TEAM_ID` | No | Default team ID for issue creation |
| `LOKI_LINEAR_WEBHOOK_SECRET` | No | Webhook signing secret for inbound events |

### Configuration

1. **Create a Linear API Key:**

   Go to Linear Settings > API and create a Personal API Key.

2. **Set Environment Variables:**

   ```bash
   export LOKI_LINEAR_API_KEY="lin_api_your_key_here"
   export LOKI_LINEAR_TEAM_ID="your-team-id"
   ```

3. **Project Sync:**

   ```javascript
   const { LinearClient } = require('./src/integrations/linear/client');

   const client = new LinearClient(process.env.LOKI_LINEAR_API_KEY);

   // Fetch a project with all issues
   const project = await client.getProject('project-id');

   // Update issue status
   await client.updateIssue('issue-id', { stateId: 'state-id' });

   // Create a sub-issue
   await client.createSubIssue('parent-id', 'team-id', 'Task title', 'Description');

   // Post a comment
   await client.createComment('issue-id', '**Loki Mode** completed testing phase.');
   ```

4. **Status Mapping:**

   Configure in `.loki/config.yaml`:

   ```yaml
   integrations:
     linear:
       api_key: "lin_api_your_key_here"
       team_id: "your-team-id"
       status_mapping:
         REASON: "In Progress"
         ACT: "In Progress"
         REFLECT: "In Review"
         VERIFY: "Done"
         DONE: "Done"
   ```

5. **Webhook Handler (optional):**

   Configure Linear to send webhooks to your Loki Mode instance for bidirectional sync.

### Verification

```bash
# Test Linear API access
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LOKI_LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { id name } }"}'
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| `RateLimitError` | Wait for `retryAfterMs` before retrying |
| `LinearApiError` HTTP 401 | Check API key is valid and not expired |
| Team states not found | Verify `team_id` is correct |
| Config not loading | Check `.loki/config.yaml` syntax |

---

## GitHub Integration

### Prerequisites

- GitHub repository (github.com or GitHub Enterprise)
- Personal Access Token (PAT) or GitHub App token
- GitHub Actions (for CI/CD integration)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LOKI_GITHUB_SYNC` | No | Enable GitHub sync (`true`) |
| `GITHUB_TOKEN` | Yes (in CI) | GitHub token for API access |
| `GITHUB_REPOSITORY` | Auto (in CI) | Repository name (`owner/repo`) |
| `GITHUB_SHA` | Auto (in CI) | Commit SHA for status checks |
| `GITHUB_EVENT_NAME` | Auto (in CI) | Trigger event name |

### Configuration

1. **GitHub Actions Integration:**

   Add to your workflow:

   ```yaml
   # .github/workflows/loki-mode.yml
   name: Loki Mode
   on:
     pull_request_review:
       types: [submitted]
     issues:
       types: [labeled]
     workflow_dispatch:

   jobs:
     loki:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - name: Run Loki Mode
           uses: asklokesh/loki-mode@v5
           with:
             token: ${{ secrets.GITHUB_TOKEN }}
   ```

2. **PR Quality Reports:**

   When triggered by `pull_request_review`, Loki Mode posts a quality report comment on the PR with:
   - Overall status (PASS/FAIL)
   - Quality gate results table
   - Task completion metrics
   - Deployment link (if available)

3. **Issue Execution Summaries:**

   When triggered by `issues`, Loki Mode posts an execution summary comment on the issue.

4. **Status Checks:**

   For `workflow_dispatch` and `schedule` triggers, Loki Mode creates a commit status check on the SHA.

### PR Comment Format

The reporter uses markdown templates from `src/integrations/github/templates/`:
- `quality-report.md` -- PR quality report template
- `execution-summary.md` -- Issue execution summary template

Custom templates are supported. Place your templates in the same directory to override defaults.

### Verification

```bash
# Test GitHub API access
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/owner/repo

# Manual report posting
node -e "
  const { postResults } = require('./src/integrations/github/reporter');
  postResults({
    eventName: 'workflow_dispatch',
    token: process.env.GITHUB_TOKEN,
    repository: 'owner/repo',
    sha: 'abc1234',
    status: 'success',
    executionId: 'test-001',
    serverUrl: 'https://github.com',
    runId: '12345',
  }).then(() => console.log('Done'));
"
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| HTTP 401 from GitHub API | Check `GITHUB_TOKEN` is valid and has required scopes |
| PR comment not posted | Ensure event is `pull_request_review` and PR number is in payload |
| Status check not created | Ensure `GITHUB_SHA` is set |
| Template not rendering | Check template files exist in `src/integrations/github/templates/` |

---

## Integration Architecture

All integrations follow the adapter pattern defined in `src/integrations/adapter.js`:

```
IntegrationAdapter (abstract base)
  |
  +-- importProject(externalId)     -- Import from external system
  +-- syncStatus(projectId, status) -- Sync RARV state outbound
  +-- postComment(externalId, md)   -- Post markdown comment
  +-- createSubtasks(id, tasks)     -- Mirror task decomposition
  +-- getWebhookHandler()           -- Handle inbound webhooks
  +-- withRetry(operation, fn)      -- Exponential backoff retry
```

Retry behavior:
- Default: 3 retries with exponential backoff
- Base delay: 1,000ms, max delay: 30,000ms
- Events emitted: `retry`, `success`, `failure`
