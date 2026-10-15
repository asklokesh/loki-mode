#!/usr/bin/env bash
# loki setup-skill --claude-code: register the Loki plugin with Claude Code.
#
# Merges into a Claude Code settings.json (user scope by default, project scope
# with --project). Existing keys are never overwritten: a missing key is added,
# an existing key is left as the user set it. Unparseable JSON is refused, not
# replaced. Idempotent: a second run changes nothing.
#
# Usage: claude-code-setup.sh [--print] [--project] [--stop-hook] [--settings FILE]

set -u

_ccs_snippet() {
    # $1 = "1" to include the opt-in Stop hook env
    python3 - "$1" <<'PY'
import json, sys
snippet = {
    "extraKnownMarketplaces": {
        "loki-mode": {"source": {"source": "github", "repo": "asklokesh/loki-mode"}}
    },
    "enabledPlugins": {"loki-mode@loki-mode": True},
}
if sys.argv[1] == "1":
    snippet["env"] = {"LOKI_STOP_VERIFY": "1"}
print(json.dumps(snippet, indent=2))
PY
}

_ccs_merge() {
    # $1 settings file, $2 stop-hook flag. Prints one line per decision.
    python3 - "$1" "$2" <<'PY'
import json, os, sys, tempfile
path, stop = sys.argv[1], sys.argv[2] == "1"
want = {
    "extraKnownMarketplaces": {
        "loki-mode": {"source": {"source": "github", "repo": "asklokesh/loki-mode"}}
    },
    "enabledPlugins": {"loki-mode@loki-mode": True},
}
if stop:
    want["env"] = {"LOKI_STOP_VERIFY": "1"}
cur = {}
if os.path.exists(path):
    try:
        raw = open(path).read()
        cur = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        print("REFUSED %s is not valid JSON (%s); fix or move it aside" % (path, e))
        sys.exit(3)
    if not isinstance(cur, dict):
        print("REFUSED %s top level is not an object" % path)
        sys.exit(3)
added = []
for top, kv in want.items():
    node = cur.get(top)
    if node is None:
        cur[top] = {}
        node = cur[top]
    elif not isinstance(node, dict):
        print("KEPT %s (existing value is not an object)" % top)
        continue
    for k, v in kv.items():
        if k in node:
            print("KEPT %s.%s" % (top, k))
        else:
            node[k] = v
            added.append("%s.%s" % (top, k))
            print("ADDED %s.%s" % (top, k))
if added:
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".settings.", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(cur, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
else:
    print("UNCHANGED %s" % path)
PY
}

cmd_claude_code_setup() {
    local print_only=0 project=0 stop=0 settings=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --print) print_only=1 ;;
            --project) project=1 ;;
            --stop-hook) stop=1 ;;
            --settings) settings="${2:-}"; shift ;;
            --help|-h)
                echo "Usage: loki setup-skill --claude-code [--print] [--project] [--stop-hook] [--settings FILE]"
                echo ""
                echo "Registers the Loki plugin marketplace and enables the plugin in Claude Code"
                echo "settings (default ~/.claude/settings.json; --project uses ./.claude/settings.json)."
                echo "Merges only: existing keys are kept, invalid JSON is refused."
                echo ""
                echo "  --print       Print the settings snippet and change nothing"
                echo "  --stop-hook   Also opt in to the Stop-hook fast verifier (LOKI_STOP_VERIFY=1)"
                return 0
                ;;
            *) echo "Unknown option: $1" >&2; return 2 ;;
        esac
        shift
    done
    command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; return 1; }
    if [ "$print_only" -eq 1 ]; then
        _ccs_snippet "$stop"
        return 0
    fi
    if [ -z "$settings" ]; then
        if [ "$project" -eq 1 ]; then
            settings="${TARGET_DIR:-.}/.claude/settings.json"
        else
            settings="$HOME/.claude/settings.json"
        fi
    fi
    local out rc
    out="$(_ccs_merge "$settings" "$stop")"
    rc=$?
    printf '%s\n' "$out"
    [ "$rc" -eq 0 ] || return "$rc"
    echo "Next: in Claude Code run /reload-plugins, then try /loki-mode:start, /loki-mode:verify, /loki-mode:handoff."
    return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    cmd_claude_code_setup "$@"
fi
