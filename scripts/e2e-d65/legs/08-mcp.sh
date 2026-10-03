# shellcheck shell=bash
# Leg 8, MCP: python3 imports mcp.v10_tools from the INSTALLED package; v10_status then v10_verify on leg 6's repo.
leg_08_mcp() {
    local repo="$T/work/leg6" pkg="$T/prefix/node_modules/loki-mode" out rc
    if [ ! -d "$repo/.loki/runs" ]; then skip "leg 6 repo has no run (leg 6 not run)"; return; fi
    [ -f "$pkg/mcp/v10_tools.py" ] || { fail "installed package has no mcp/v10_tools.py"; return; }
    out="$(cd "$pkg" && cenv E2E_REPO="$repo" python3 - <<'PY' 2>&1
import os, json
from mcp import v10_tools as v
repo = os.environ["E2E_REPO"]
ident = lambda p: os.path.realpath(p)
s = v.v10_status("", repo, ident)
print("STATUS", json.dumps({k: s.get(k) for k in ("run_id", "phase", "done", "verdict", "error")}))
r = v.v10_verify("", repo, ident)
print("VERIFY", json.dumps({k: r.get(k) for k in ("exit_code", "verified", "error")}))
print("VERIFY_OUT", (r.get("output") or "").replace("\n", " | ")[:200])
PY
)"
    rc=$?
    note "python rc=$rc"
    while IFS= read -r l; do note "$l"; done <<< "$out"
    [ "$rc" -eq 0 ] || { fail "import or call failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; return; }
    case "$out" in *'STATUS {'*'"error": null'*) ;; *) fail "v10_status returned an error: $(printf '%s' "$out" | grep STATUS | head -c 200)"; return ;; esac
    case "$out" in *'"done": true'*) ;; *) fail "v10_status says the leg 6 run is not done"; return ;; esac
    case "$out" in *'VERIFY {'*'"error": null'*) ;; *) fail "v10_verify returned an error: $(printf '%s' "$out" | grep '^VERIFY ' | head -c 200)"; return ;; esac
    pass "v10_tools imported from the installed package; status done, verify answered"
}
