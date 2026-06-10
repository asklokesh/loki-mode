# Troubleshooting

Common issues and solutions.

---

## Installation Issues

### Command Not Found: loki

**Symptom:**
```bash
loki --version
# zsh: command not found: loki
```

**Solutions:**

1. **npm global path not in PATH:**
   ```bash
   # Add to ~/.zshrc or ~/.bashrc
   export PATH="$PATH:$(npm config get prefix)/bin"
   source ~/.zshrc
   ```

2. **Reinstall:**
   ```bash
   npm install -g loki-mode
   ```

3. **Use npx:**
   ```bash
   npx loki-mode --version
   ```

### Permission Denied

**Symptom:**
```bash
npm install -g loki-mode
# EACCES: permission denied
```

**Solution:**
```bash
# Fix npm permissions
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
npm install -g loki-mode
```

---

## Session Issues

### Session Won't Start

**Symptom:**
```bash
loki start ./prd.md
# Error: Claude CLI not found
```

**Solutions:**

1. **Install Claude CLI:**
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

2. **Check provider:**
   ```bash
   loki provider show
   loki provider info claude
   ```

### Max Retries Exceeded

**Symptom:**
```
Max retries (50) exceeded. Stopping.
```

**Solutions:**

1. **Reset retry count:**
   ```bash
   loki reset retries
   ```

2. **Increase limit:**
   ```bash
   export LOKI_MAX_RETRIES=100
   ```

3. **Check for persistent errors in logs:**
   ```bash
   loki logs | grep -i error
   ```

### Session Stuck

**Symptom:** Session not progressing.

**Solutions:**

1. **Check status:**
   ```bash
   loki status
   ```

2. **View logs:**
   ```bash
   loki logs -f
   ```

3. **Force stop and restart:**
   ```bash
   loki stop
   loki reset all
   loki start ./prd.md
   ```

### Rate Limited

**Symptom:**
```
Rate limit detected! Waiting...
```

**Solution:** This is normal. Loki automatically waits and retries. To reduce rate limits:

```bash
# Reduce parallel agents
export LOKI_MAX_PARALLEL_AGENTS=5

# Disable fast tier
export LOKI_ALLOW_HAIKU=false
```

---

## Dashboard Issues

### Dashboard Won't Start

**Symptom:**
```bash
loki dashboard start
# Error: Port 57374 already in use
```

**Solutions:**

1. **Use different port:**
   ```bash
   loki dashboard start --port 8080
   ```

2. **Kill existing process:**
   ```bash
   lsof -i :57374 | awk 'NR>1 {print $2}' | xargs kill
   ```

### Dashboard Not Loading

**Symptom:** Browser shows blank page or connection refused.

**Solutions:**

1. **Check if running:**
   ```bash
   loki dashboard status
   ```

2. **Check URL:**
   ```bash
   loki dashboard url
   # Open the URL in browser
   ```

3. **Restart:**
   ```bash
   loki dashboard stop
   loki dashboard start
   ```

---

## API Issues

### API Authentication Failed

**Symptom:**
```
401 Unauthorized
```

**Solutions:**

1. **Check if auth is enabled:**
   ```bash
   loki enterprise status
   ```

2. **Generate new token:**
   ```bash
   loki enterprise token generate my-token
   ```

3. **Use token correctly:**
   ```bash
   curl -H "Authorization: Bearer loki_xxx..." http://localhost:57374/api/status
   ```

### API Connection Refused

**Symptom:**
```
curl: (7) Failed to connect to localhost port 57374
```

**Solutions:**

1. **Start API server:**
   ```bash
   loki serve
   # or
   loki api start
   ```

2. **Check status:**
   ```bash
   loki api status
   ```

---

## Notification Issues

### Notifications Not Sending

**Symptom:** No Slack/Discord messages appearing.

**Solutions:**

1. **Check configuration:**
   ```bash
   loki notify status
   ```

2. **Test manually:**
   ```bash
   loki notify test "Test message"
   ```

3. **Verify webhook URL:**
   ```bash
   echo $LOKI_SLACK_WEBHOOK
   ```

4. **Check webhook is active** in Slack/Discord settings.

### Wrong Channel

**Solution:**
```bash
export LOKI_NOTIFY_CHANNELS=slack  # Only Slack
loki notify test
```

---

## Provider Issues

### Wrong Provider

**Symptom:** Using Codex when Claude expected.

**Solution:**
```bash
loki provider show
loki provider set claude
```

### Provider Not Installed

**Symptom:**
```
Error: Provider 'codex' not installed
```

**Solution:**
```bash
# Install the missing CLI
npm install -g @openai/codex-cli
codex auth
```

---

## Memory/Learning Issues

### Learnings Not Saving

**Symptom:** `loki memory list` shows no entries.

**Solutions:**

1. **Check directory exists:**
   ```bash
   ls -la ~/.loki/learnings/
   ```

2. **Ensure session completed** (learnings extracted at end).

3. **Check CONTINUITY.md** has patterns section.

### Duplicate Learnings

**Solution:** Duplicates are automatically filtered by MD5 hash. If seeing duplicates:

```bash
# Clear and let re-extract
loki memory clear patterns
```

---

## Enterprise Issues

### Token Not Working

**Solutions:**

1. **Check token not revoked:**
   ```bash
   loki enterprise token list --all
   ```

2. **Check expiration:**
   ```bash
   loki enterprise token list
   ```

3. **Regenerate:**
   ```bash
   loki enterprise token revoke old-token
   loki enterprise token generate new-token
   ```

### Audit Logs Missing

**Solutions:**

1. **Ensure enabled:**
   ```bash
   export LOKI_ENTERPRISE_AUDIT=true
   ```

2. **Check directory:**
   ```bash
   ls -la ~/.loki/dashboard/audit/
   ```

---

## Performance Issues

### Slow Execution

**Solutions:**

1. **Enable parallel mode:**
   ```bash
   export LOKI_PARALLEL_MODE=true
   ```

2. **Use simpler complexity:**
   ```bash
   export LOKI_COMPLEXITY=simple
   ```

3. **Disable unnecessary phases:**
   ```bash
   export LOKI_PHASE_E2E_TESTS=false
   export LOKI_PHASE_PERFORMANCE=false
   ```

### High Memory Usage

**Solutions:**

1. **Reduce parallel agents:**
   ```bash
   export LOKI_MAX_PARALLEL_AGENTS=3
   ```

2. **Enable context compaction:**
   ```bash
   # Already enabled by default
   ```

3. **Use Docker sandbox** for isolation.

---

## Getting Help

### Collect Debug Info

```bash
# Version info
loki --version
claude --version

# Current config
loki config show

# Recent logs
loki logs -n 100 > loki-debug.log

# Provider info
loki provider list
loki provider info claude
```

### Report Issue

Include:
1. Loki Mode version
2. Provider and version
3. OS and version
4. Error message
5. Steps to reproduce
6. Debug logs

[Open Issue](https://github.com/asklokesh/loki-mode/issues/new)
