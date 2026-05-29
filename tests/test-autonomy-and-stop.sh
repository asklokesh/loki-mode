#!/usr/bin/env bash
# v7.7.31 regression tests:
#   - inter-iteration countdown is STOP-aware (1s ticks, checks STOP/PAUSE)
#   - the claude argv array in run.sh is never empty-expanded (bash 3.2 + set -u)
#   - /api/running-projects treats a recorded-but-dead pid as authoritative
#     (a stale session.json no longer flips a dead session back to running)
#   - the autonomy override (--append-system-prompt) is wired on BOTH routes,
#     gated on flag support, opt-out via LOKI_AUTONOMY_OVERRIDE
#   - the override text is byte-identical between bash and Bun routes
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
RUN="$REPO_ROOT/autonomy/run.sh"
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"

# --- Fix #1a: STOP-aware countdown ----------------------------------------
grep -q 'Stop/pause signal detected during wait' "$RUN" \
  && ok "countdown checks STOP/PAUSE during the inter-iteration wait" \
  || bad "countdown does not check STOP/PAUSE during wait"

# The countdown must sleep in short ticks (1s), not 10s/60s chunks, so SIGTERM
# and STOP take effect promptly. Assert the old chunked-interval logic is gone.
if grep -q 'interval=60' "$RUN"; then
    bad "countdown still uses a 60s sleep chunk (SIGTERM deferred up to 60s)"
else
    ok "countdown no longer uses long sleep chunks"
fi

# --- Fix #1b: bash 3.2 + set -u safe claude argv array ---------------------
# The claude argv array must be seeded with base flags so it is never expanded
# empty (empty "${arr[@]}" under set -u errors on bash 3.2, stock macOS shell).
grep -q '_loki_claude_argv=("--dangerously-skip-permissions" "--model"' "$RUN" \
  && ok "claude argv array seeded with base flags (bash 3.2 + set -u safe)" \
  || bad "claude argv array may be empty-expanded under set -u"

# --- Fix #2: autonomy override wired on the bash route ---------------------
grep -q '_loki_autonomy_override_text' "$RUN" \
  && grep -q 'append-system-prompt' "$RUN" \
  && ok "run.sh main loop wires --append-system-prompt autonomy override" \
  || bad "run.sh main loop missing autonomy override"

grep -q '_loki_autonomy_override_text()' "$CLAUDE_SH" \
  && grep -q 'LOKI_AUTONOMY_OVERRIDE' "$CLAUDE_SH" \
  && ok "providers/claude.sh defines override + honors LOKI_AUTONOMY_OVERRIDE" \
  || bad "providers/claude.sh missing override helper / opt-out"

# gated on flag support (never pass a flag the installed CLI lacks)
grep -q 'loki_claude_flag_supported "--append-system-prompt"' "$RUN" \
  && ok "override gated on loki_claude_flag_supported in run.sh" \
  || bad "override not gated on flag support in run.sh"

# --- Fix #2: Bun-route parity ----------------------------------------------
BUN_FLAGS="$REPO_ROOT/loki-ts/src/providers/claude_flags.ts"
grep -q 'append-system-prompt' "$BUN_FLAGS" \
  && grep -q 'AUTONOMY_OVERRIDE_TEXT' "$BUN_FLAGS" \
  && grep -q 'LOKI_AUTONOMY_OVERRIDE' "$BUN_FLAGS" \
  && ok "Bun claude_flags.ts wires the override + opt-out (route parity)" \
  || bad "Bun route missing autonomy override (parity regression)"

# --- override text byte-identical across routes ----------------------------
BASH_OV=$(bash -c "cd '$REPO_ROOT'; source providers/loader.sh; load_provider claude >/dev/null 2>&1; _loki_autonomy_override_text" 2>/dev/null)
if command -v bun >/dev/null 2>&1; then
    BUN_OV=$(cd "$REPO_ROOT" && bun -e 'import { AUTONOMY_OVERRIDE_TEXT } from "./loki-ts/src/providers/claude_flags.ts"; process.stdout.write(AUTONOMY_OVERRIDE_TEXT);' 2>/dev/null)
    if [ "$BASH_OV" = "$BUN_OV" ] && [ -n "$BASH_OV" ]; then
        ok "autonomy override text is byte-identical (bash == Bun)"
    else
        bad "autonomy override text differs between bash and Bun routes"
    fi
else
    ok "autonomy override text identity skipped (bun not on PATH)"
fi

# the override must forbid AskUserQuestion + assert precedence over CLAUDE.md
echo "$BASH_OV" | grep -q 'AskUserQuestion' \
  && echo "$BASH_OV" | grep -qi 'take precedence' \
  && ok "override forbids AskUserQuestion and asserts precedence over CLAUDE.md" \
  || bad "override text missing AskUserQuestion / precedence language"

# --- Fix #2: opt-out behavioral test (Bun route buildAutoFlags) ------------
# Assert the flag is PRESENT by default and ABSENT when LOKI_AUTONOMY_OVERRIDE=off.
if command -v bun >/dev/null 2>&1; then
    T_OPTOUT=$(cd "$REPO_ROOT/loki-ts" && bun -e '
import { buildAutoFlags, ensureClaudeHelpCache } from "./src/providers/claude_flags.ts";
await ensureClaudeHelpCache();
const has = () => buildAutoFlags({tier:"development",complexity:"standard",primary:"opus",targetDir:"."}).includes("--append-system-prompt");
delete process.env.LOKI_AUTONOMY_OVERRIDE;
const onDefault = has();
process.env.LOKI_AUTONOMY_OVERRIDE = "off";
const offDisabled = !has();
process.env.LOKI_AUTONOMY_OVERRIDE = "on";
const onExplicit = has();
console.log(onDefault && offDisabled && onExplicit ? "OPTOUT_OK" : `OPTOUT_FAIL on=${onDefault} off=${offDisabled} explicit=${onExplicit}`);
' 2>&1 | tail -1)
    [ "$T_OPTOUT" = "OPTOUT_OK" ] && ok "override present by default, absent when LOKI_AUTONOMY_OVERRIDE=off (Bun)" || bad "opt-out behavior: $T_OPTOUT"
else
    ok "opt-out behavioral test skipped (bun not on PATH)"
fi

# the override must keep commit hygiene + categorical safety language (council fix)
echo "$BASH_OV" | grep -qi 'never push or force-push' \
  && echo "$BASH_OV" | grep -qi 'does NOT relax any safety rule' \
  && echo "$BASH_OV" | grep -qi 'git add -A' \
  && ok "override keeps commit hygiene + categorical safety carve-out" \
  || bad "override missing commit-hygiene / categorical safety language"

# --- Fix #1c: running-projects treats dead pid as authoritative ------------
grep -q 'not has_pid' "$REPO_ROOT/dashboard/server.py" \
  && ok "running-projects: dead recorded pid is authoritative (no stale-session flip)" \
  || bad "running-projects still flips a dead pid back to running via session.json"

T_DEADPID=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, os, tempfile, shutil
sys.path.insert(0, '.')
from pathlib import Path
import dashboard.registry as registry
td = tempfile.mkdtemp(prefix='lk731-')
registry.REGISTRY_DIR = Path(td) / '.loki' / 'dashboard'
registry.REGISTRY_FILE = registry.REGISTRY_DIR / 'projects.json'
proj = tempfile.mkdtemp(prefix='lk731p-'); os.makedirs(os.path.join(proj, '.loki'))
# session.json says running, but the recorded pid is DEAD (999999)
with open(os.path.join(proj, '.loki', 'session.json'), 'w') as f:
    f.write('{"status": "running"}')
try:
    e = registry.register_project(proj)
    reg = registry._load_registry()
    reg['projects'][e['id']].update(pid=999999, port=57374, status='running')
    registry._save_registry(reg)
    from dashboard import server
    from fastapi.testclient import TestClient
    c = TestClient(server.app)
    row = {p['id']: p for p in c.get('/api/running-projects').json()['projects']}.get(e['id'])
    # dead pid must win over the stale session.json -> running False
    print('DEADPID_OK' if row and row['running'] is False else f'DEADPID_FAIL: {row}')
finally:
    shutil.rmtree(td, ignore_errors=True); shutil.rmtree(proj, ignore_errors=True)
PYEOF
)
[ "$T_DEADPID" = "DEADPID_OK" ] && ok "dead pid + stale session.json -> running=False (functional)" || bad "dead-pid functional: $T_DEADPID"

# --- syntax ----------------------------------------------------------------
bash -n "$RUN" && ok "autonomy/run.sh passes bash -n" || bad "run.sh syntax error"
bash -n "$CLAUDE_SH" && ok "providers/claude.sh passes bash -n" || bad "claude.sh syntax error"
$PY -c "import ast; ast.parse(open('$REPO_ROOT/dashboard/server.py').read())" \
  && ok "dashboard/server.py parses" || bad "server.py syntax error"

# --- bash 3.2 empty-array safety (functional, if /bin/bash is 3.2) ----------
if /bin/bash -c 'set -u; a=("x"); cmd=(echo "${a[@]}"); "${cmd[@]}"' >/dev/null 2>&1; then
    ok "seeded array expands cleanly under set -u on /bin/bash"
else
    bad "seeded array expansion fails under set -u on /bin/bash"
fi

# --- no em dashes in changed files -----------------------------------------
if grep -lP '\xe2\x80\x94' "$RUN" "$CLAUDE_SH" "$BUN_FLAGS" \
     "$REPO_ROOT/dashboard/server.py" "$REPO_ROOT/CHANGELOG.md" \
     "$REPO_ROOT/README.md" "$SCRIPT_DIR/test-autonomy-and-stop.sh" >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
