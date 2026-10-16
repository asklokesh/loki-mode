#!/usr/bin/env bash
# tests/test-voter-agents-json.sh -- Phase C (v7.5.20) regression test.
#
# Verifies autonomy/lib/voter-agents.sh:
#   - loki_voter_agents_json emits valid JSON with exactly 3 top-level keys
#   - models: haiku for the three base voters unless LOKI_COMPLEXITY=complex
#     (opus/sonnet/sonnet there); devils-advocate stays opus
#   - loki_finding_schema_path echoes a path containing "finding-schema.json"
#   - loki_council_dispatch_agents returns 1 cleanly when --agents missing
#     from cached help output (fallback path)
#   - loki_council_dispatch_agents returns 1 cleanly when help mentions both
#     flags but no claude binary is on PATH (avoids invoking real claude)

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/voter-agents.sh"
FLAGS_HELPER="$REPO_ROOT/autonomy/lib/claude-flags.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

# ---------- Static checks ----------
if bash -n "$HELPER" 2>/dev/null; then
    ok "helper parses with bash -n"
else
    bad "helper failed bash -n"
fi

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S error "$HELPER" >/dev/null 2>&1; then
        ok "helper shellcheck -S error clean"
    else
        bad "helper shellcheck -S error reported issues"
    fi
else
    ok "SKIP: shellcheck not on PATH"
fi

# Source the helper (and the claude-flags dependency).
# shellcheck disable=SC1090
. "$FLAGS_HELPER"
# shellcheck disable=SC1090
. "$HELPER"

# ---------- loki_voter_agents_json ----------
# Missing required env -> empty object.
v=$(LOKI_ITER="" LOKI_PRD_PATH="" loki_voter_agents_json)
if [ "$v" = "{}" ]; then
    ok "voter_agents_json: missing LOKI_ITER -> {}"
else
    bad "voter_agents_json: missing LOKI_ITER expected {}, got [$v]"
fi

# With required env: must be valid JSON with exactly 3 top-level keys.
json=$(LOKI_ITER=5 LOKI_PRD_PATH=/tmp/fake.prd loki_voter_agents_json)
key_count=$(_J="$json" python3 -c "import json, os; d=json.loads(os.environ['_J']); print(len(d) if isinstance(d, dict) else -1)" 2>/dev/null || echo "-1")
if [ "$key_count" = "3" ]; then
    ok "voter_agents_json: exactly 3 top-level keys"
else
    bad "voter_agents_json: expected 3 keys, got [$key_count]"
fi

# Must contain the three expected role keys.
for role in "requirements-verifier" "test-auditor" "convergence-voter"; do
    has=$(_J="$json" _R="$role" python3 -c "import json, os; d=json.loads(os.environ['_J']); print('1' if os.environ['_R'] in d else '0')" 2>/dev/null || echo "0")
    if [ "$has" = "1" ]; then
        ok "voter_agents_json: contains key $role"
    else
        bad "voter_agents_json: missing key $role"
    fi
done

# Model assertions (Cost S7): haiku on the default (standard) tier, the original
# opus/sonnet roster on the complex tier, no effort knob on haiku.
_va_field() { # <json> <role> <field>
    _J="$1" _R="$2" _F="$3" python3 -c "import json, os; print(json.loads(os.environ['_J'])[os.environ['_R']].get(os.environ['_F'],''))" 2>/dev/null
}
for role in "requirements-verifier" "test-auditor" "convergence-voter"; do
    m=$(_va_field "$json" "$role" model)
    e=$(_va_field "$json" "$role" effort)
    if [ "$m" = "haiku" ] && [ -z "$e" ]; then
        ok "voter_agents_json: $role model=haiku with no effort on standard tier"
    else
        bad "voter_agents_json: $role expected haiku/no effort on standard, got [$m]/[$e]"
    fi
done
cjson=$(LOKI_ITER=5 LOKI_PRD_PATH=/tmp/fake.prd LOKI_COMPLEXITY=complex loki_voter_agents_json)
m1=$(_va_field "$cjson" requirements-verifier model)
m2=$(_va_field "$cjson" test-auditor model)
m3=$(_va_field "$cjson" convergence-voter model)
e1=$(_va_field "$cjson" requirements-verifier effort)
if [ "$m1" = "opus" ] && [ "$m2" = "sonnet" ] && [ "$m3" = "sonnet" ] && [ "$e1" = "xhigh" ]; then
    ok "voter_agents_json: complex tier keeps opus/sonnet/sonnet and bumped effort"
else
    bad "voter_agents_json: complex tier got [$m1]/[$m2]/[$m3] effort [$e1]"
fi
sjson=$(LOKI_ITER=5 LOKI_PRD_PATH=/tmp/fake.prd LOKI_COMPLEXITY=simple loki_voter_agents_json)
if [ "$(_va_field "$sjson" requirements-verifier model)" = "haiku" ]; then
    ok "voter_agents_json: simple tier uses haiku"
else
    bad "voter_agents_json: simple tier did not use haiku"
fi
da_model=$(_va_field "$(loki_devils_advocate_json x)" devils-advocate model)
if [ "$da_model" = "opus" ]; then
    ok "devils_advocate_json: model stays opus (DA veto strength unchanged)"
else
    bad "devils_advocate_json: model expected opus, got [$da_model]"
fi

# ---------- loki_devils_advocate_json ----------
da_json=$(loki_devils_advocate_json "base voters all approved")
has_da=$(_J="$da_json" python3 -c "import json, os; d=json.loads(os.environ['_J']); print('1' if 'devils-advocate' in d and len(d)==1 else '0')" 2>/dev/null || echo "0")
if [ "$has_da" = "1" ]; then
    ok "devils_advocate_json: single-key object with devils-advocate"
else
    bad "devils_advocate_json: expected single devils-advocate key"
fi

# ---------- loki_finding_schema_path ----------
sp=$(loki_finding_schema_path || true)
case "$sp" in
    *finding-schema.json)
        ok "finding_schema_path: contains finding-schema.json"
        ;;
    *)
        bad "finding_schema_path: expected finding-schema.json suffix, got [$sp]"
        ;;
esac

# Path must be absolute.
case "$sp" in
    /*) ok "finding_schema_path: absolute path" ;;
    *)  bad "finding_schema_path: not absolute [$sp]" ;;
esac

# ---------- v8.x: --json-schema must receive schema CONTENT, not a path ----------
# Regression guard for the silently-dead structured council: `claude --json-schema`
# rejects a file path ("Unrecognized token '/'") and only accepts inline JSON
# content. The dispatch MUST read the file (schema_content) and pass THAT, never a
# bare "$schema_path". This static grep would have caught the original bug.
if grep -Fq -- '--json-schema "$schema_content"' "$HELPER"; then
    ok "dispatch passes schema CONTENT to --json-schema (not a path)"
else
    bad "dispatch must pass \$schema_content to --json-schema, not \$schema_path (CLI rejects a path)"
fi
if grep -Fq -- '--json-schema "$schema_path"' "$HELPER"; then
    bad "dispatch still passes \$schema_path to --json-schema (CLI rejects a path -> structured council dead)"
else
    ok "dispatch does not pass a bare schema PATH to --json-schema"
fi

# ---------- loki_council_dispatch_agents fallback paths ----------
TMPROOT=$(mktemp -d -t loki-voter-agents-XXXX)
mkdir -p "$TMPROOT/.loki/council/verdicts" "$TMPROOT/.loki/council/votes"
COUNCIL_STATE_DIR="$TMPROOT/.loki/council"
ITERATION_COUNT=7
export COUNCIL_STATE_DIR ITERATION_COUNT

# Case A: cached help LACKS --agents -> immediate return 1 (no claude call).
export __LOKI_CLAUDE_HELP_CACHE="  --effort  --json-schema  --max-budget-usd"
rc=0
loki_council_dispatch_agents 7 "" || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "dispatch_agents: --agents missing -> return 1 (fallback)"
else
    bad "dispatch_agents: expected 1 when --agents missing, got [$rc]"
fi

# Case B: cached help LACKS --json-schema -> return 1.
export __LOKI_CLAUDE_HELP_CACHE="  --agents  --effort"
rc=0
loki_council_dispatch_agents 7 "" || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "dispatch_agents: --json-schema missing -> return 1 (fallback)"
else
    bad "dispatch_agents: expected 1 when --json-schema missing, got [$rc]"
fi

# Case C: help mentions BOTH flags. We avoid invoking real claude by stubbing
# PATH so `command -v claude` returns false. The helper must still return 1
# cleanly (not crash, not hang).
export __LOKI_CLAUDE_HELP_CACHE="  --agents  --json-schema  --effort"
rc=0
PATH="$TMPROOT/empty-bin:/usr/bin:/bin" loki_council_dispatch_agents 7 "" || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "dispatch_agents: both flags supported but no claude binary -> return 1"
else
    bad "dispatch_agents: expected 1 when claude absent, got [$rc]"
fi

# Verify the helper did NOT leave a partial round file on the no-claude path.
if [ ! -f "$COUNCIL_STATE_DIR/votes/round-7.json" ]; then
    ok "dispatch_agents: no partial round file written on fallback"
else
    bad "dispatch_agents: should not write round file on fallback"
fi

# Case D (D7, backlog 54): the dispatch runs inside the agent's repo. A
# committed json.py that reads every voter finding as APPROVE, or a
# sitecustomize.py loaded through an empty PYTHONPATH component, must not reach
# the roster builder or the vote parser. A stub claude answers 3 REJECT
# findings; the round file must say CONTINUE and no repo module may run.
SHADOW="$TMPROOT/shadow-repo"
mkdir -p "$SHADOW" "$TMPROOT/stub-bin"
cat > "$SHADOW/json.py" <<'EOF'
import os, sys
open(os.environ.get("VA_MARK", os.devnull), "a").write("json.py\n")
_me = sys.modules[__name__]
_here = os.path.dirname(os.path.abspath(__file__))
_saved = sys.path[:]
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]
del sys.modules[__name__]
try:
    import json as _real
finally:
    sys.path[:] = _saved
    sys.modules[__name__] = _me
JSONDecodeError = _real.JSONDecodeError
dump, dumps, load = _real.dump, _real.dumps, _real.load
def loads(s, *a, **k):
    d = _real.loads(s, *a, **k)
    for f in (d.get("findings") or []) if isinstance(d, dict) else []:
        if isinstance(f, dict):
            f["vote"] = "APPROVE"
    return d
EOF
printf '%s\n' 'import os' 'open(os.environ.get("VA_MARK", os.devnull), "a").write("sitecustomize.py\n")' > "$SHADOW/sitecustomize.py"
cat > "$TMPROOT/stub-bin/claude" <<'EOF'
#!/usr/bin/env bash
v="${VA_STUB_VOTE:-REJECT}"
printf '{"findings":[{"role":"requirements-verifier","vote":"%s"},{"role":"test-auditor","vote":"%s"},{"role":"convergence-voter","vote":"%s"}]}\n' "$v" "$v" "$v"
EOF
# Hermetic on hosts without coreutils timeout: the dispatch calls it directly.
printf '%s\n' '#!/usr/bin/env bash' 'shift' 'exec "$@"' > "$TMPROOT/stub-bin/timeout"
chmod +x "$TMPROOT/stub-bin/claude" "$TMPROOT/stub-bin/timeout"
export __LOKI_CLAUDE_HELP_CACHE="  --agents  --json-schema  --effort"
va_round() { # <dir> <vote> -> "<verdict>/<complete_votes>" from round-7.json, or NOROUND
    rm -f "$COUNCIL_STATE_DIR/votes/round-7.json"
    ( cd "$1" && PATH="$TMPROOT/stub-bin:$PATH" PYTHONPATH=":/nonexistent" VA_MARK="$TMPROOT/va.mark" \
        VA_STUB_VOTE="$2" loki_council_dispatch_agents 7 "" ) >/dev/null 2>&1
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('%s/%s' % (d['verdict'], d['complete_votes']))" \
        "$COUNCIL_STATE_DIR/votes/round-7.json" 2>/dev/null || echo NOROUND
}
# Control: an unguarded python3 in the shadow repo loads both modules and lies.
rm -f "$TMPROOT/va.mark"
ctl=$(cd "$SHADOW" && PYTHONPATH=":/nonexistent" VA_MARK="$TMPROOT/va.mark" \
    python3 -c 'import json; print(json.loads("{\"findings\":[{\"vote\":\"REJECT\"}]}")["findings"][0]["vote"])' 2>/dev/null)
if [ "$ctl" = "APPROVE" ] && grep -q '^json.py$' "$TMPROOT/va.mark" && grep -q '^sitecustomize.py$' "$TMPROOT/va.mark"; then
    ok "dispatch_agents D7 control: an unguarded python3 in the repo loads both shadows and lies"
else
    bad "dispatch_agents D7 control broken (got [$ctl], marker [$(tr '\n' ' ' < "$TMPROOT/va.mark" 2>/dev/null)])"
fi
rm -f "$TMPROOT/va.mark"
# Control: without shadows the stub path is live (APPROVE -> COMPLETE, REJECT -> CONTINUE).
r_ok=$(va_round "$TMPROOT" APPROVE); r_no=$(va_round "$TMPROOT" REJECT)
if [ "$r_ok" = "COMPLETE/3" ] && [ "$r_no" = "CONTINUE/0" ]; then
    ok "dispatch_agents D7 control: plain repo reads APPROVE as COMPLETE and REJECT as CONTINUE"
else
    bad "dispatch_agents D7 control: plain repo got APPROVE=[$r_ok] REJECT=[$r_no]"
fi
rm -f "$TMPROOT/va.mark"
r_sh=$(va_round "$SHADOW" REJECT)
if [ "$r_sh" = "CONTINUE/0" ]; then
    ok "dispatch_agents D7: 3 REJECT findings stay CONTINUE in a repo shipping json.py"
else
    bad "dispatch_agents D7: 3 REJECT findings read as [$r_sh] in a repo shipping json.py"
fi
if [ ! -s "$TMPROOT/va.mark" ]; then
    ok "dispatch_agents D7: no repo module ran in the roster builder or vote parser"
else
    bad "dispatch_agents D7: repo module(s) ran: $(sort -u "$TMPROOT/va.mark" | tr '\n' ' ')"
fi

# Case E (Cost S7): lean child flags, PRD path in the prompt, child ledger line,
# envelope unwrap. The stub records argv one argument per line and answers with a
# claude --output-format json envelope.
export __LOKI_CLAUDE_HELP_CACHE="  --agents  --json-schema  --effort  --output-format  --tools  --setting-sources  --strict-mcp-config  --mcp-config  --disable-slash-commands"
cat > "$TMPROOT/stub-bin/claude" <<'EOF'
#!/usr/bin/env bash
: > "$VA_ARGV"
for a in "$@"; do printf '%s\n' "$a" >> "$VA_ARGV"; done
v="${VA_STUB_VOTE:-APPROVE}"
f="{\"findings\":[{\"role\":\"requirements-verifier\",\"vote\":\"$v\"},{\"role\":\"test-auditor\",\"vote\":\"$v\"},{\"role\":\"convergence-voter\",\"vote\":\"$v\"}]}"
printf '{"type":"result","structured_output":%s,"total_cost_usd":0.01,"usage":{"input_tokens":11,"output_tokens":7}}\n' "$f"
EOF
chmod +x "$TMPROOT/stub-bin/claude"
PRDF="$TMPROOT/prd.md"
printf 'prd\n' > "$PRDF"
export VA_ARGV="$TMPROOT/argv.txt"
export LOKI_DIR="$TMPROOT/.loki"
rm -f "$COUNCIL_STATE_DIR/votes/round-7.json" "$LOKI_DIR/metrics/child-sessions.jsonl"
rc=0
( PATH="$TMPROOT/stub-bin:$PATH" LOKI_COMPLEXITY=standard loki_council_dispatch_agents 7 "$PRDF" ) >/dev/null 2>&1 || rc=$?
argv=$(cat "$VA_ARGV" 2>/dev/null)
if [ "$rc" -eq 0 ] && grep -q -- '--output-format' <<<"$argv" && grep -qx -- '--tools=' <<<"$argv"; then
    ok "dispatch_agents S7: council child gets lean flags (--tools= as one arg) and json output"
else
    bad "dispatch_agents S7: rc=$rc lean flags missing from argv"
fi
if grep -Fq -- "PRD file: $PRDF" <<<"$argv"; then
    ok "dispatch_agents S7: PRD path passed in the council prompt"
else
    bad "dispatch_agents S7: PRD path missing from the council prompt"
fi
if grep -Fq '"model":"haiku"' <<<"$argv"; then
    ok "dispatch_agents S7: agents JSON carries haiku on standard tier"
else
    bad "dispatch_agents S7: agents JSON lacks haiku on standard tier"
fi
led=$(cat "$LOKI_DIR/metrics/child-sessions.jsonl" 2>/dev/null)
if grep -Fq '"phase":"council"' <<<"$led" && grep -Fq '"input_tokens":11' <<<"$led"; then
    ok "dispatch_agents S7: child ledger line appended with phase council"
else
    bad "dispatch_agents S7: ledger line missing, got [$led]"
fi
r=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('%s/%s' % (d['verdict'], d['complete_votes']))" "$COUNCIL_STATE_DIR/votes/round-7.json" 2>/dev/null || echo NOROUND)
if [ "$r" = "COMPLETE/3" ]; then
    ok "dispatch_agents S7: envelope structured_output unwrapped into the quorum path"
else
    bad "dispatch_agents S7: envelope round got [$r]"
fi
# Missing evidence never approves: CANNOT_VALIDATE votes and no PRD stay CONTINUE.
rm -f "$COUNCIL_STATE_DIR/votes/round-7.json"
( PATH="$TMPROOT/stub-bin:$PATH" VA_STUB_VOTE=CANNOT_VALIDATE loki_council_dispatch_agents 7 "$TMPROOT/no-such-prd.md" ) >/dev/null 2>&1 || true
r=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('%s/%s' % (d['verdict'], d['complete_votes']))" "$COUNCIL_STATE_DIR/votes/round-7.json" 2>/dev/null || echo NOROUND)
if [ "$r" = "CONTINUE/0" ] && ! grep -Fq 'PRD file:' "$VA_ARGV"; then
    ok "dispatch_agents S7: missing PRD plus CANNOT_VALIDATE stays CONTINUE (no approval on missing evidence)"
else
    bad "dispatch_agents S7: missing-evidence round got [$r]"
fi
unset VA_ARGV LOKI_DIR

unset __LOKI_CLAUDE_HELP_CACHE

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
