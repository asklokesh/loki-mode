#!/usr/bin/env bash
# v7.7.18 regression test: memory capture wedge (MCP tool + ingest CLI +
# SessionEnd hook installer). Solves the diagnosis root cause where
# memory only captured during `loki start` sessions.
#
# Tests cover:
#  1. ingest_from_summary writes an episode
#  2. ingest_from_claude_transcript writes an episode with action_log
#  3. LOKI_MEMORY_CAPTURE_DISABLED escape hatch
#  4. Secret scrubber on transcript content
#  5. `loki memory ingest --from-stdin` CLI round-trip
#  6. `loki memory enable-hook` idempotent installer
#  7. `loki memory enable-hook` honors LOKI_MEMORY_HOOK_DISABLED
#  8. `loki memory disable-hook` reverses the install (idempotent)
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
SKIP=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
skip() { SKIP=$((SKIP+1)); echo "SKIP: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1: ingest_from_summary
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
from memory.ingest import ingest_from_summary
tmp = tempfile.mkdtemp(prefix='loki-v7718-')
try:
    path = ingest_from_summary(
        os.path.join(tmp, '.loki', 'memory'),
        goal='build the foo widget',
        outcome='success',
        files_modified=['/tmp/foo.py'],
        files_read=['/tmp/bar.py'],
        tool_calls_summary='wrote foo.py based on bar.py reference',
    )
    if not path or not os.path.isfile(path):
        print(f'SUMMARY_FAIL: path={path}')
    else:
        ep = json.load(open(path))
        # `goal` lives under context per EpisodeTrace.to_dict (memory/schemas.py:355)
        ep_goal = ep.get('context', {}).get('goal', '')
        if (ep.get('outcome') == 'success'
            and '/tmp/foo.py' in ep.get('files_modified', [])
            and '/tmp/bar.py' in ep.get('files_read', [])
            and 'foo widget' in ep_goal):
            print('SUMMARY_OK')
        else:
            print(f'SUMMARY_FAIL_FIELDS: outcome={ep.get("outcome")} mod={ep.get("files_modified")} read={ep.get("files_read")} goal={ep_goal!r}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "SUMMARY_OK" ]; then ok "ingest_from_summary writes episode with populated fields"; else bad "summary: $RESULT"; fi

# Test 2: ingest_from_claude_transcript on synthetic transcript
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
from memory.ingest import ingest_from_claude_transcript
tmp = tempfile.mkdtemp(prefix='loki-v7718-')
try:
    # Build a minimal synthetic Claude Code transcript
    transcript = os.path.join(tmp, 'session.jsonl')
    entries = [
        {'type': 'user', 'sessionId': 'abc12345', 'timestamp': '2026-05-28T00:00:00Z',
         'message': {'content': 'Refactor the auth module'}},
        {'type': 'assistant', 'timestamp': '2026-05-28T00:00:10Z',
         'message': {'content': [
             {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': '/tmp/auth.py'}},
             {'type': 'tool_use', 'name': 'Edit', 'input': {'file_path': '/tmp/auth.py'}},
             {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'pytest /tmp/test_auth.py'}},
         ]}},
        {'type': 'user', 'timestamp': '2026-05-28T00:01:00Z',
         'message': {'content': 'looks good'}},
    ]
    with open(transcript, 'w') as f:
        for e in entries:
            f.write(json.dumps(e) + '\n')
    memory_dir = os.path.join(tmp, '.loki', 'memory')
    path = ingest_from_claude_transcript(transcript, memory_dir)
    if not path or not os.path.isfile(path):
        print(f'TRANSCRIPT_FAIL: path={path}')
    else:
        ep = json.load(open(path))
        ep_goal = ep.get('context', {}).get('goal', '')
        ok_goal = 'Refactor' in ep_goal
        ok_read = '/tmp/auth.py' in ep.get('files_read', [])
        ok_mod = '/tmp/auth.py' in ep.get('files_modified', [])
        ok_actions = len(ep.get('action_log', [])) == 3
        ok_agent = ep.get('agent') == 'claude-code'
        ok_duration = ep.get('duration_seconds', -1) >= 60
        if ok_goal and ok_read and ok_mod and ok_actions and ok_agent and ok_duration:
            print('TRANSCRIPT_OK')
        else:
            print(f'TRANSCRIPT_FIELDS_FAIL: goal={ok_goal} read={ok_read} mod={ok_mod} actions={ok_actions} agent={ok_agent} duration={ok_duration}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "TRANSCRIPT_OK" ]; then ok "ingest_from_claude_transcript extracts goal+files+action_log"; else bad "transcript: $RESULT"; fi

# Test 3: LOKI_MEMORY_CAPTURE_DISABLED escape hatch
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
os.environ['LOKI_MEMORY_CAPTURE_DISABLED'] = 'true'
from memory.ingest import ingest_from_summary
tmp = tempfile.mkdtemp(prefix='loki-v7718-')
try:
    path = ingest_from_summary(os.path.join(tmp, '.loki', 'memory'), goal='blocked')
    if path is None:
        print('DISABLED_OK')
    else:
        print(f'DISABLED_FAIL: wrote {path}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "DISABLED_OK" ]; then ok "LOKI_MEMORY_CAPTURE_DISABLED blocks ingest"; else bad "escape hatch: $RESULT"; fi

# Test 4: secret scrubber on transcript content
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
from memory.ingest import ingest_from_claude_transcript
tmp = tempfile.mkdtemp(prefix='loki-v7718-')
try:
    transcript = os.path.join(tmp, 'session.jsonl')
    entries = [
        {'type': 'user', 'sessionId': 'def67890', 'timestamp': '2026-05-28T00:00:00Z',
         'message': {'content': 'API_KEY=hunter2supersecret in config'}},
        {'type': 'assistant', 'timestamp': '2026-05-28T00:00:05Z',
         'message': {'content': [
             {'type': 'tool_use', 'name': 'Bash',
              'input': {'command': 'curl -H "Authorization: Bearer sk-livethismadeupbut1234567890ABCDEF" https://api'}},
         ]}},
    ]
    with open(transcript, 'w') as f:
        for e in entries:
            f.write(json.dumps(e) + '\n')
    path = ingest_from_claude_transcript(transcript, os.path.join(tmp, '.loki', 'memory'))
    ep = json.load(open(path))
    serialized = json.dumps(ep, default=str)
    leaked = ('hunter2supersecret' in serialized
              or 'sk-livethismadeupbut' in serialized)
    redacted = '[REDACTED]' in serialized
    if not leaked and redacted:
        print('SCRUB_OK')
    elif leaked:
        print(f'SCRUB_FAIL_LEAK')
    else:
        print(f'SCRUB_FAIL_NO_REDACT_MARK')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "SCRUB_OK" ]; then ok "scrubber redacts secrets in transcript ingest"; else bad "scrub: $RESULT"; fi

# Test 5: loki memory ingest --from-stdin CLI round-trip
TEST=/tmp/loki-v7718-cli-stdin
rm -rf "$TEST"; mkdir -p "$TEST"
RESULT=$(cd "$TEST" && echo '{"goal":"cli stdin test","outcome":"partial","files_modified":["/tmp/x.py"]}' \
    | LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" memory ingest --from-stdin 2>/dev/null \
    | $PY -c "import json, sys, os; d=json.loads(sys.stdin.read()); print('CLI_STDIN_OK' if d.get('episode_path') and os.path.isfile(d['episode_path']) else f'CLI_STDIN_FAIL: {d}')")
if [ "$RESULT" = "CLI_STDIN_OK" ]; then ok "loki memory ingest --from-stdin writes episode"; else bad "cli stdin: $RESULT"; fi
rm -rf "$TEST"

# Test 6 (council fix Opus 2): path-aware scrubber redacts sensitive paths
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
from memory.ingest import ingest_from_summary
tmp = tempfile.mkdtemp(prefix='loki-v7718-')
try:
    path = ingest_from_summary(
        os.path.join(tmp, '.loki', 'memory'),
        goal='harmless goal',
        outcome='success',
        files_modified=[
            '/Users/me/.aws/credentials',
            '/home/dev/project/.env',
            '/safe/path/script.py',
        ],
        files_read=[
            '/Users/me/.ssh/id_rsa',
            '/home/dev/project/src/main.py',
        ],
    )
    ep = json.load(open(path))
    mods = ep.get('files_modified', [])
    reads = ep.get('files_read', [])
    # Sensitive paths should be redacted with markers
    mod_str = ' '.join(mods)
    read_str = ' '.join(reads)
    ok_aws_redacted = 'credentials' not in mod_str or '[REDACTED' in mod_str
    ok_env_redacted = ('.env' not in mod_str.replace('REDACTED', '')) or '[REDACTED' in mod_str
    ok_ssh_redacted = 'id_rsa' not in read_str or '[REDACTED' in read_str
    ok_safe_kept = '/safe/path/script.py' in mods
    ok_normal_kept = '/home/dev/project/src/main.py' in reads
    if ok_aws_redacted and ok_env_redacted and ok_ssh_redacted and ok_safe_kept and ok_normal_kept:
        print('PATH_SCRUB_OK')
    else:
        print(f'PATH_SCRUB_FAIL: mods={mods} reads={reads}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "PATH_SCRUB_OK" ]; then ok "path-aware scrub redacts .aws/.ssh/.env + keeps safe paths"; else bad "path scrub: $RESULT"; fi

# Test 7 (council fix Opus 2): transcript file size cap
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
from memory.ingest import ingest_from_claude_transcript
tmp = tempfile.mkdtemp(prefix='loki-v7718-')
try:
    transcript = os.path.join(tmp, 'huge.jsonl')
    # Write 51 MB of dummy data
    with open(transcript, 'wb') as f:
        line = b'{"type":"x"}\n'
        for _ in range(51 * 1024 * 1024 // len(line)):
            f.write(line)
    memory_dir = os.path.join(tmp, '.loki', 'memory')
    os.makedirs(memory_dir, exist_ok=True)
    path = ingest_from_claude_transcript(transcript, memory_dir)
    # Should skip (return None) and write to .errors.log
    errors_log = os.path.join(memory_dir, '.errors.log')
    if path is None and os.path.exists(errors_log):
        with open(errors_log) as f:
            errors = f.read()
        if 'too large' in errors:
            print('SIZE_CAP_OK')
        else:
            print(f'SIZE_CAP_FAIL_no_log_entry')
    else:
        print(f'SIZE_CAP_FAIL: path={path}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "SIZE_CAP_OK" ]; then ok "transcript >50MB skipped with .errors.log entry"; else bad "size cap: $RESULT"; fi

# Test 8 (council fix Opus 2): hook script handles both stdin JSON + env var
# Just verify the script is syntactically clean + has both code paths.
HOOK="$REPO_ROOT/claude/hooks/loki-session-end.sh"
if grep -q "transcript_path" "$HOOK" && grep -q "CLAUDE_TRANSCRIPT_PATH" "$HOOK" && bash -n "$HOOK"; then
    ok "sample hook script supports both stdin JSON + env var formats"
else
    bad "hook script does not handle both formats"
fi

# Test 9 (v7.7.18a fix): Bun-route stdin propagation. The default-case
# fall-through in loki-ts/src/commands/memory.ts:runMemory previously
# used run() which does not pipe stdin to the bash subprocess, so
# `echo '{}' | loki memory ingest --from-stdin` failed silently on the
# default Bun route (worked only with LOKI_LEGACY_BASH=1). Now uses
# Bun.spawn with stdin:"inherit".
TEST=/tmp/loki-v7718-bun-stdin
rm -rf "$TEST"; mkdir -p "$TEST"
RESULT=$(cd "$TEST" && echo '{"goal":"bun stdin propagation","outcome":"success","files_modified":["/tmp/y.py"]}' \
    | BUN_FROM_SOURCE=1 bash "$REPO_ROOT/bin/loki" memory ingest --from-stdin 2>/dev/null \
    | $PY -c "import json, sys, os
try:
    d = json.loads(sys.stdin.read())
    print('BUN_STDIN_OK' if d.get('episode_path') and os.path.isfile(d['episode_path']) else f'BUN_STDIN_FAIL: {d}')
except Exception as e:
    print(f'BUN_STDIN_PARSE_FAIL: {e}')")
if [ "$RESULT" = "BUN_STDIN_OK" ]; then ok "Bun route propagates stdin to bash fall-through (v7.7.18a)"; else bad "bun stdin: $RESULT"; fi
rm -rf "$TEST"

# Cleanup
bash -c 'for d in /tmp/loki-v7718-*; do rm -rf "$d" 2>/dev/null; done'

echo ""
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
