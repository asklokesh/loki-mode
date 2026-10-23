#!/usr/bin/env bash
# Test: CEO cockpit (tools/cockpit/server.py), headless. See tools/cockpit/SPEC.md section 8.
#
# Never opens a browser (LOKI_NO_BROWSER=1; the server imports no webbrowser).
# Everything lives under one run-owned temp dir; the server is stopped by the
# PID it printed and nothing is killed by name or pattern.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER="$REPO_ROOT/tools/cockpit/server.py"
export LOKI_NO_BROWSER=1

loki_run_tmp_create() {
    local temp_root marker

    if [ -n "${LOKI_RUN_TMP:-}" ]; then
        printf '%s\n' "LOKI_RUN_TMP is already set; refusing to replace it" >&2
        return 64
    fi

    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || {
        printf '%s\n' "Cannot resolve the temp root" >&2
        return 64
    }
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    marker="${LOKI_RUN_TMP}/.loki-run-owned"

    chmod 700 "$LOKI_RUN_TMP" || {
        rmdir "$LOKI_RUN_TMP" 2>/dev/null || true
        unset LOKI_RUN_TMP
        return 1
    }
    if ! printf '%s\n' "$LOKI_RUN_TMP" >"$marker" || ! chmod 600 "$marker"; then
        rm -f -- "$marker"
        rmdir "$LOKI_RUN_TMP" 2>/dev/null || true
        unset LOKI_RUN_TMP
        return 1
    fi
    export LOKI_RUN_TMP
}

loki_run_tmp_stat_field() {
    local gnu_fmt="$1" bsd_fmt="$2" target_path="$3" value

    value="$(stat -c "$gnu_fmt" -- "$target_path" 2>/dev/null)" || value=''
    case "$value" in
        '' | *[!0-9]*) value="$(stat -f "$bsd_fmt" -- "$target_path" 2>/dev/null)" || value='' ;;
    esac
    case "$value" in
        '' | *[!0-9]*) return 1 ;;
    esac
    printf '%s\n' "$value"
}

loki_run_tmp_cleanup() {
    local target temp_root marker marker_value target_real
    local target_uid marker_uid target_mode marker_mode current_uid

    target="${LOKI_RUN_TMP:-}"
    [ -n "$target" ] || return 0
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64

    case "$target" in
        "${temp_root}"/loki-run.*) ;;
        *)
            printf '%s\n' "Refusing cleanup outside the run-owned temp namespace: $target" >&2
            return 64
            ;;
    esac
    [ "$(dirname -- "$target")" = "$temp_root" ] || return 64
    [ -d "$target" ] && [ ! -L "$target" ] || return 64

    marker="${target}/.loki-run-owned"
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 64
    IFS= read -r marker_value <"$marker" || return 64
    [ "$marker_value" = "$target" ] || return 64

    current_uid="$(id -u)" || return 64
    target_uid="$(loki_run_tmp_stat_field '%u' '%u' "$target")" || return 64
    marker_uid="$(loki_run_tmp_stat_field '%u' '%u' "$marker")" || return 64
    [ "$target_uid" = "$current_uid" ] && [ "$marker_uid" = "$current_uid" ] || return 64

    target_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$target")" || return 64
    marker_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$marker")" || return 64
    target_mode="00${target_mode}"
    marker_mode="00${marker_mode}"
    [ "${target_mode#"${target_mode%???}"}" = "700" ] || return 64
    [ "${marker_mode#"${marker_mode%???}"}" = "600" ] || return 64

    target_real="$(cd "$target" 2>/dev/null && pwd -P)" || return 64
    [ "$target_real" = "$target" ] || return 64
    [ "$(dirname -- "$target_real")" = "$temp_root" ] || return 64

    if [ -e "${target}/.git" ] || [ -L "${target}/.git" ]; then
        printf '%s\n' "Refusing to remove a Git worktree: $target" >&2
        return 64
    fi

    rm -rf -- "$target"
    [ ! -e "$target" ] || return 1
    unset LOKI_RUN_TMP
}

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
check() { # check <name> <expected> <actual>
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

SERVER_PIDS=()
cleanup() {
    local p
    for p in "${SERVER_PIDS[@]:-}"; do
        [ -n "$p" ] && kill "$p" 2>/dev/null
    done
    loki_run_tmp_cleanup
}
trap cleanup EXIT

loki_run_tmp_create || { echo "cannot create run tmp"; exit 2; }
T="$LOKI_RUN_TMP"

# pj <json-file> <python expr over d>
pj() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$1" "$2" 2>&1; }

# ---------------------------------------------------------------- fixtures
FIX="$T/fix"
mkdir -p "$FIX/status" "$FIX/rt" "$FIX/sb"
NOW="2026-10-23T12:00:00Z"

{
    echo "# Board"
    echo
    echo "| ID | Owner | Branch @ SHA | File set (summary) | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|---|"
    for tok in ready building review review-blocked approved merged released blocked rejected parked; do
        echo "| ROW-$tok | owner-$tok | b @ abc | f | LOW | $tok@2026-10-23T11:30Z | note $tok |"
    done
    echo "| ROW-slow | owner-slow | b @ abc | f | LOW | building@2026-10-23T10:00Z | slow |"
    echo "| ROW-bad | owner | b @ abc | f | LOW | in progress someday | no token |"
} >"$FIX/BOARD.md"

cat >"$FIX/QUEUE.md" <<'EOF'
# Founder queue

| # | Date | Item | Why only you | Loop does meanwhile |
|---|---|---|---|---|
| 1 | 2026-09-25 | first item | money | waits |
| 2 | 2026-09-26 | second item | legal | waits |
| 7 | 2026-09-27 | seventh item | brand | waits |
EOF

cat >"$FIX/RETRO.md" <<'EOF'
# Retro

## 6. The 20 highest-leverage changes

1. Build the scoreboard. A longer sentence. Owner: Chief Scientist (research seat). Metric: scoreboard published daily.
2. Second item here. Owner: CTO. Metric: both green.

---

## 7. What to stop doing
EOF

stub() { # stub <name> <rc> <stdout-text>
    printf '#!/usr/bin/env bash\ncat <<'"'"'EOS'"'"'\n%s\nEOS\nexit %s\n' "$3" "$2" >"$FIX/sb/$1.sh"
}

stub npm 0 '{"dist-tags":{"latest":"11.18.0","next":"11.18.0"},"time":{"created":"2025-01-01T00:00:00Z","modified":"2026-10-23T11:00:00Z","11.17.0":"2026-10-23T03:00:00Z","11.17.1":"2026-10-23T11:30:00Z","11.0.0":"2026-01-01T00:00:00Z"}}'
VSHA="$(git -C "$REPO_ROOT" log -1 --format=%H -- VERSION 2>/dev/null)"
stub ghok 0 "[{\"databaseId\":1,\"status\":\"completed\",\"conclusion\":\"success\",\"headSha\":\"$VSHA\",\"createdAt\":\"2026-10-23T11:00:00Z\",\"displayTitle\":\"t\",\"url\":\"https://example.invalid/1\"}]"
stub ghfail 0 "[{\"databaseId\":2,\"status\":\"completed\",\"conclusion\":\"failure\",\"headSha\":\"$VSHA\",\"createdAt\":\"2026-10-23T11:00:00Z\",\"displayTitle\":\"t\",\"url\":\"https://example.invalid/2\"}]"
printf '#!/usr/bin/env bash\nsleep 30\n' >"$FIX/sb/ghslow.sh"
stub usage 0 '{"weekly":{"current_pct":10.0},"window":{"current_pct":2.0}}'
for rc in 0 1 2 7; do
    case "$rc" in
        1) body=$'=== v10-pulse status ===\nBOARD status counts: ready=1\n\n=== VIOLATIONS ===\nVIOLATION: TEST_ONE: boom' ;;
        2) body=$'=== v10-pulse status ===\nUNKNOWN metrics: main_ci, release_cadence' ;;
        *) body=$'=== v10-pulse status ===\nBOARD status counts: ready=1' ;;
    esac
    stub "pulse$rc" "$rc" "$body"
done
printf 'utc_time\twindow_percent\tweekly_percent\n2026-10-23T10:00:00Z\t5\t40\n' >"$FIX/readings.tsv"
printf '{"usd": 1.5, "measured": true}\n{"usd": null, "measured": false}\n{"usd": 2.5, "measured": true}\n' >"$FIX/cost-ok.jsonl"

# Executive-panel fixtures: a real git repo with dated commits, gh stubs,
# transcripts, a price table, a scoreboard and a leader file.
G="$FIX/gitrepo"
mkdir -p "$G"
git -C "$G" init -q
gc() { # gc <iso-date> <subject>
    echo "line $1" >>"$G/f.txt"
    git -C "$G" add f.txt
    GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git -C "$G" -c user.name=fixture -c user.email=fixture@example.invalid \
        -c commit.gpgsign=false commit -q -m "$2"
}
gc 2026-10-01T00:00:00Z "feat: outside the 15 day window"
gc 2026-10-14T10:00:00Z "fix: previous week"
gc 2026-10-20T10:00:00Z "docs: note"
gc 2026-10-22T10:00:00Z "Merge branch 'x'"
gc 2026-10-23T09:00:00Z "feat: add thing"
gc 2026-10-23T10:00:00Z "fix: repair thing"
gc 2026-10-23T11:25:00Z "release: v11.17.1"
RSHA="$(git -C "$G" log -1 --format=%H --grep='^release:')"
stub ghruns 0 "[{\"databaseId\":11,\"workflowName\":\"Release\",\"status\":\"completed\",\"conclusion\":\"success\",\"headSha\":\"$RSHA\",\"headBranch\":\"main\",\"createdAt\":\"2026-10-23T11:26:00Z\",\"event\":\"push\"},{\"databaseId\":12,\"workflowName\":\"Tests\",\"status\":\"completed\",\"conclusion\":\"failure\",\"headSha\":\"$RSHA\",\"headBranch\":\"main\",\"createdAt\":\"2026-10-23T11:26:00Z\",\"event\":\"push\"},{\"databaseId\":13,\"workflowName\":\"Tests\",\"status\":\"completed\",\"conclusion\":\"success\",\"headSha\":\"ffffffffffffffffffff\",\"headBranch\":\"main\",\"createdAt\":\"2026-10-22T11:00:00Z\",\"event\":\"push\"},{\"databaseId\":14,\"workflowName\":\"Release\",\"status\":\"completed\",\"conclusion\":\"success\",\"headSha\":\"eeeeeeeeeeeeeeeeeeee\",\"headBranch\":\"main\",\"createdAt\":\"2026-10-22T10:00:00Z\",\"event\":\"push\"}]"
stub ghissues 0 '[{"number":1,"title":"p0 crash","state":"OPEN","createdAt":"2026-10-22T08:00:00Z","closedAt":null,"labels":[{"name":"P0"}]},{"number":2,"title":"bug fixed","state":"CLOSED","createdAt":"2026-10-01T08:00:00Z","closedAt":"2026-10-21T08:00:00Z","labels":[{"name":"bug"}]},{"number":3,"title":"old open","state":"OPEN","createdAt":"2026-09-01T08:00:00Z","closedAt":null,"labels":[]}]'
# open-issues call (--state open --limit 1000): 3 open, one P0; ghissues above is the opened/closed window
stub ghopen 0 '[{"number":1,"title":"p0 crash","state":"OPEN","labels":[{"name":"P0"}]},{"number":3,"title":"old open","state":"OPEN","labels":[]},{"number":4,"title":"new open","state":"OPEN","labels":[{"name":"enhancement"}]}]'
stub ghprs 0 '[{"number":5,"title":"fix: x","mergedAt":"2026-10-22T08:00:00Z","author":{"login":"asklokesh"}},{"number":4,"title":"feat: y","mergedAt":"2026-10-10T08:00:00Z","author":{"login":"asklokesh"}}]'
stub capok 0 '{"state": "OK", "reason": "ok", "week_pct": 42.5, "ceiling": 90, "override": false, "reading_at": "2026-10-23T11:00:00Z", "cache_age_secs": 120}'
stub cappaused 0 '{"state": "PAUSED", "reason": "cap", "week_pct": 91.0, "ceiling": 90, "override": false, "reading_at": "2026-10-23T11:00:00Z", "cache_age_secs": 60, "message": "weekly cap reached"}'
stub capstale 0 '{"state": "PAUSED", "reason": "stale", "week_pct": 40.0, "ceiling": 90, "override": false, "reading_at": "2026-10-23T09:00:00Z", "cache_age_secs": 7200, "message": "reading older than 30 min"}'
stub capover 0 '{"state": "OK", "reason": "ok", "week_pct": 95.0, "ceiling": 90, "override": true, "reading_at": "2026-10-23T11:00:00Z", "cache_age_secs": 30}'
stub capfail 3 'boom'
stub capbad 0 'not json at all'
stub capodd 0 '{"state": "MAYBE"}'
printf '{"_updated":"2026-10-08","pricing":{"opus":{"input":4.0,"output":20.0,"cache_read":0.2,"cache_write":5},"sonnet":{"input":2.0,"output":10.0,"cache_read":0.1,"cache_write":2.5}}}\n' >"$FIX/pricing.json"
TX="$FIX/tx"
mkdir -p "$TX/sess1/subagents"
txrow() { # txrow <ts> <msg-id> <model> <input> <output>
    printf '{"timestamp":"%s","message":{"role":"assistant","id":"%s","model":"%s","usage":{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n' "$1" "$2" "$3" "$4" "$5"
}
{ txrow 2026-10-23T11:10:00Z m1 claude-opus-4-7 1000000 100000; txrow 2026-10-23T11:11:00Z m3 mystery-9 10 10; } >"$TX/main1.jsonl"
txrow 2026-10-23T11:20:00Z m2 claude-sonnet-4-6 1000000 100000 >"$TX/sess1/subagents/agent-a.jsonl"
{ printf '{"type":"agent-setting","agentSetting":"cto"}\n'; txrow 2026-10-23T11:30:00Z m4 claude-opus-4-7 500000 50000; } >"$TX/sess1/subagents/agent-b.jsonl"
mkdir -p "$FIX/sb-good"
printf '{"loki_pass": 7, "raw_pass": 5, "n": 10}\n' >"$FIX/sb-good/2026-10-23.json"
printf '%s 2026-10-23T11:00:00Z\n' "$$" >"$FIX/leader"

# Environment for every cockpit invocation (pulse stub is replaced per call).
base_env() {
    export COCKPIT_NOW="$NOW" BOARD_MD="$FIX/BOARD.md" FOUNDER_QUEUE_MD="$FIX/QUEUE.md" \
        RETRO_MD="$FIX/RETRO.md" USAGE_READINGS_TSV="$FIX/readings.tsv" \
        COST_HISTORY_FILE="$FIX/missing-cost.jsonl" COCKPIT_STATUS_DIR="$FIX/status" \
        COCKPIT_OKRS_JSON="$FIX/missing-okrs.json" COCKPIT_SCOREBOARD_DIR="$FIX/missing-sb" \
        COCKPIT_COMPANY_DIR="$FIX/company" COCKPIT_SCHEDULES_JSON="$FIX/schedules.json" \
        COCKPIT_RUNTIME_DIR="$FIX/rt" COCKPIT_NPM_CMD="bash $FIX/sb/npm.sh" \
        COCKPIT_GH_CMD="bash $FIX/sb/ghok.sh" COCKPIT_PULSE_CMD="bash $FIX/sb/pulse0.sh" \
        COCKPIT_USAGE_CMD="bash $FIX/sb/usage.sh" COCKPIT_CMD_TIMEOUT=5 COCKPIT_FIRST_WAIT=20 \
        COCKPIT_GIT_ROOT="$G" COCKPIT_GH_RUNS_CMD="bash $FIX/sb/ghruns.sh" \
        COCKPIT_GH_ISSUES_CMD="bash $FIX/sb/ghissues.sh" COCKPIT_GH_OPEN_ISSUES_CMD="bash $FIX/sb/ghopen.sh" \
        COCKPIT_GH_PRS_CMD="bash $FIX/sb/ghprs.sh" \
        COCKPIT_TRANSCRIPT_ROOT="$TX" COCKPIT_TOKEN_CACHE="$FIX/rt/token-cache.json" \
        COCKPIT_PRICING_JSON="$FIX/pricing.json" COCKPIT_USAGE_CAP_CMD="bash $FIX/sb/capok.sh" \
        COCKPIT_LEADER_FILE="$FIX/leader"
}
base_env

echo "== syntax"
if python3 -m py_compile "$SERVER"; then ok "server.py compiles"; else bad "server.py compile"; fi

echo "== CLI refusals"
python3 "$SERVER" --host 0.0.0.0 >/dev/null 2>&1; check "--host 0.0.0.0 exits 64" 64 "$?"
python3 "$SERVER" --host 192.168.1.5 >/dev/null 2>&1; check "--host non-loopback exits 64" 64 "$?"

echo "== --once exit mapping follows the pulse stub"
for rc in 0 1 2 7; do
    want="$rc"; [ "$rc" = 7 ] && want=2
    COCKPIT_PULSE_CMD="bash $FIX/sb/pulse$rc.sh" python3 "$SERVER" --once --json --panel pulse >"$FIX/once$rc.json" 2>/dev/null
    check "pulse rc=$rc maps to exit $want" "$want" "$?"
done
check "pulse violation parsed" "TEST_ONE: boom" "$(pj "$FIX/once1.json" 'd["panels"]["pulse"]["data"]["violations"][0]')"
check "pulse rc=7 is UNKNOWN with reason" "UNKNOWN" "$(pj "$FIX/once7.json" 'd["panels"]["pulse"]["status"]')"
check "pulse unknown metrics listed" "['main_ci', 'release_cadence']" "$(pj "$FIX/once2.json" 'd["panels"]["pulse"]["data"]["unknown_metrics"]')"

echo "== full snapshot shape and degradation"
python3 "$SERVER" --once --json >"$FIX/full.json" 2>/dev/null
check "full snapshot parses and has 10 panels" "['agents', 'board', 'compare', 'health', 'okrs', 'pulse', 'queue', 'releases', 'roi', 'work']" "$(pj "$FIX/full.json" 'sorted(d["panels"])')"
check "every panel has the envelope keys" "True" "$(pj "$FIX/full.json" 'all(set(p)>={"status","as_of","source_cmd","data","error"} for p in d["panels"].values())')"
check "every panel names its source_cmd" "True" "$(pj "$FIX/full.json" 'all(p["source_cmd"] for p in d["panels"].values())')"
check "board counts: one row per token (building has 2)" "[1, 2, 1, 1, 1]" "$(pj "$FIX/full.json" '[d["panels"]["board"]["data"]["counts"][t] for t in ("ready","building","review","approved","merged")]')"
check "board unparsed row listed" "['ROW-bad']" "$(pj "$FIX/full.json" 'd["panels"]["board"]["data"]["unparsed"]')"
check "board slow row is over budget" "True" "$(pj "$FIX/full.json" '[r for r in d["panels"]["board"]["data"]["active"] if r["id"]=="ROW-slow"][0]["over_budget"]')"
check "board ready below 30 flagged" "True" "$(pj "$FIX/full.json" 'd["panels"]["board"]["data"]["ready_below_30"]')"
check "releases OK with stubs" "OK" "$(pj "$FIX/full.json" 'd["panels"]["releases"]["status"]')"
check "releases last hour counts 1" "1" "$(pj "$FIX/full.json" 'd["panels"]["releases"]["data"]["releases_last_hour"]')"
check "releases last 24h counts 2" "2" "$(pj "$FIX/full.json" 'd["panels"]["releases"]["data"]["releases_last_24h"]')"
check "missing status dir: agents UNKNOWN" "UNKNOWN" "$(pj "$FIX/full.json" 'd["panels"]["agents"]["status"]')"
check "missing cost history: metered UNMEASURED" "UNMEASURED" "$(pj "$FIX/full.json" 'd["panels"]["roi"]["data"]["cost"]["metered"]["state"]')"
check "no total_usd key when unmeasured (never 0)" "False" "$(pj "$FIX/full.json" '"total_usd" in d["panels"]["roi"]["data"]["cost"]["metered"]')"
check "ROI multiple withheld (None)" "None" "$(pj "$FIX/full.json" 'd["panels"]["roi"]["data"]["roi"]["multiple"]')"
check "human-equivalent value is None, not 0" "None" "$(pj "$FIX/full.json" 'd["panels"]["roi"]["data"]["value"]["human_equivalent_usd"]')"
check "cost labelled ESTIMATE without measured rows" "ESTIMATE" "$(pj "$FIX/full.json" 'd["panels"]["roi"]["data"]["cost"]["label"]')"
check "OKR with no value is UNMEASURED" "UNMEASURED" "$(pj "$FIX/full.json" 'd["panels"]["okrs"]["data"]["items"][0]["state"]')"
check "OKR owner parsed" "Chief Scientist (research seat)" "$(pj "$FIX/full.json" 'd["panels"]["okrs"]["data"]["items"][0]["owner"]')"
check "queue max number from fixture" "7" "$(pj "$FIX/full.json" 'd["panels"]["queue"]["data"]["max_number"]')"
check "agents slugs derived from .claude/agents" "True" "$(pj "$FIX/full.json" 'len(d["panels"]["agents"]["data"]["seats"])>=1')"

echo "== positive controls (the same probes find the value on a fixture that has it)"
printf '{"seat":"cto","model":"opus","doing":"x","slice":"S-1","since":"%s","next":"y","blocked_on":"decision","updated":"2026-10-23T11:50:00Z"}\n' "$NOW" >"$FIX/status/cto.json"
printf '{"1":{"value":5,"target":9,"status":"x","source_cmd":"cmd","as_of":"%s"},"2":{"value":3}}\n' "$NOW" >"$FIX/okrs.json"
python3 "$SERVER" --once --json --panel agents >"$FIX/pc-agents.json" 2>/dev/null
check "agent seat with a file is OK" "OK" "$(pj "$FIX/pc-agents.json" '[s for s in d["panels"]["agents"]["data"]["seats"] if s["slug"]=="cto"][0]["state"]')"
check "agent blocked_on flagged" "True" "$(pj "$FIX/pc-agents.json" '[s for s in d["panels"]["agents"]["data"]["seats"] if s["slug"]=="cto"][0]["blocked"]')"
# Company seat ticks: .loki/company/<seat>/last.json plus the seat's schedule
mkdir -p "$FIX/company/cto" "$FIX/company/security-lead" "$FIX/company/platform-lead"
printf '[{"name":"cto","cron_expr":"*/30 * * * *","action":"seat cto","enabled":true},{"name":"security-lead","cron_expr":"*/30 * * * *","action":"seat security-lead","enabled":true},{"name":"platform-lead","cron_expr":"*/30 * * * *","action":"seat platform-lead","enabled":true}]\n' >"$FIX/schedules.json"
printf '{"ts":"2026-10-23T11:50:00Z","seat":"cto","outcome":"dispatched 2 slices","actions":[],"evidence":"x"}\n' >"$FIX/company/cto/last.json"
printf '{"ts":"2026-10-23T10:30:00Z","seat":"security-lead","outcome":"clean","actions":[],"evidence":"x"}\n' >"$FIX/company/security-lead/last.json"
python3 "$SERVER" --once --json --panel agents >"$FIX/pc-tick.json" 2>/dev/null
seatq() { pj "$FIX/pc-tick.json" '[s for s in d["panels"]["agents"]["data"]["seats"] if s["slug"]=="'"$1"'"][0]'"$2"; }
check "tick: last tick time read from last.json" "2026-10-23T11:50:00Z" "$(seatq cto '["tick"]["last_tick"]')"
check "tick: outcome read from last.json" "dispatched 2 slices" "$(seatq cto '["tick"]["outcome"]')"
check "tick: interval from the seat schedule" "30" "$(seatq cto '["tick"]["interval_min"]')"
check "tick: next due is the next 30-minute mark" "2026-10-23T12:30:00Z" "$(seatq cto '["tick"]["next_due"]')"
check "tick: 10 min old with 30 min interval is OK" "OK" "$(seatq cto '["tick"]["state"]')"
check "tick: 90 min old with 30 min interval is STALE" "STALE" "$(seatq security-lead '["state"]')"
check "tick: seat that never ticked is NO-TICK, not STALE" "NO-TICK" "$(seatq platform-lead '["tick"]["state"]')"
COCKPIT_OKRS_JSON="$FIX/okrs.json" python3 "$SERVER" --once --json --panel okrs >"$FIX/pc-okrs.json" 2>/dev/null
check "OKR with cited value is MEASURED" "MEASURED" "$(pj "$FIX/pc-okrs.json" 'd["panels"]["okrs"]["data"]["items"][0]["state"]')"
check "OKR value without source_cmd is UNCITED" "UNCITED" "$(pj "$FIX/pc-okrs.json" 'd["panels"]["okrs"]["data"]["items"][1]["state"]')"
COST_HISTORY_FILE="$FIX/cost-ok.jsonl" python3 "$SERVER" --once --json --panel roi >"$FIX/pc-roi.json" 2>/dev/null
check "cost with measured rows is MEASURED" "MEASURED" "$(pj "$FIX/pc-roi.json" 'd["panels"]["roi"]["data"]["cost"]["metered"]["state"]')"
check "measured total is 4.0 with 1 unmeasured run" "[4.0, 1]" "$(pj "$FIX/pc-roi.json" '[d["panels"]["roi"]["data"]["cost"]["metered"]["total_usd"], d["panels"]["roi"]["data"]["cost"]["metered"]["unmeasured_runs"]]')"
COCKPIT_GH_CMD="bash $FIX/sb/ghfail.sh" python3 "$SERVER" --once --json --panel releases >"$FIX/pc-rel.json" 2>/dev/null
check "failed release run on the VERSION SHA is a VIOLATION" "VIOLATION" "$(pj "$FIX/pc-rel.json" 'd["panels"]["releases"]["status"]')"

echo "== a hung command yields UNKNOWN within the timeout, not a hang"
t0=$(date +%s)
COCKPIT_CMD_TIMEOUT=1 COCKPIT_GH_CMD="bash $FIX/sb/ghslow.sh" python3 "$SERVER" --once --json --panel releases >"$FIX/slow.json" 2>/dev/null
t1=$(date +%s)
check "slow gh: releases UNKNOWN" "UNKNOWN" "$(pj "$FIX/slow.json" 'd["panels"]["releases"]["status"]')"
check "slow gh: error says timed out" "True" "$(pj "$FIX/slow.json" '"timed out" in d["panels"]["releases"]["error"]')"
if [ $((t1 - t0)) -lt 20 ]; then ok "slow gh returned in $((t1 - t0))s (< 20s)"; else bad "slow gh took $((t1 - t0))s"; fi
COCKPIT_NPM_CMD="false" COCKPIT_GH_CMD="false" python3 "$SERVER" --once --json --panel releases >"$FIX/down.json" 2>/dev/null
check "failed npm and gh: UNKNOWN, no fabricated numbers" "None" "$(pj "$FIX/down.json" 'd["panels"]["releases"]["data"].get("latest")')"

echo "== executive panels on fixtures (positive controls)"
python3 "$SERVER" --once --json >"$FIX/ex.json" 2>/dev/null
exp() { pj "$FIX/ex.json" "$1"; }
check "work: OK on fixtures" "OK" "$(exp 'd["panels"]["work"]["status"]')"
check "work: commits last 24h" "3" "$(exp 'd["panels"]["work"]["data"]["commits"]["last_24h"]')"
check "work: commits last 7d (window excludes the 15d-old commit)" "5" "$(exp 'd["panels"]["work"]["data"]["commits"]["last_7d"]')"
check "work: commits previous 7d" "1" "$(exp 'd["panels"]["work"]["data"]["commits"]["prev_7d"]')"
check "work: commits by type" "{'docs': 1, 'feat': 1, 'fix': 1, 'merge': 1, 'release': 1}" "$(exp 'dict(sorted(d["panels"]["work"]["data"]["commits"]["by_type_7d"].items()))')"
check "work: lines added 7d from numstat" "5" "$(exp 'd["panels"]["work"]["data"]["commits"]["lines_added_7d"]')"
check "work: lines changed excludes release commits" "4" "$(exp 'd["panels"]["work"]["data"]["commits"]["lines_changed_excl_release_7d"]')"
check "work: slices released 7d from BOARD stamps" "1" "$(exp 'd["panels"]["work"]["data"]["slices"]["released_7d"]')"
check "work: PRs merged 7d (older PR excluded)" "1" "$(exp 'd["panels"]["work"]["data"]["pull_requests"]["merged_7d"]')"
check "work: PRs merged by type" "{'fix': 1}" "$(exp 'd["panels"]["work"]["data"]["pull_requests"]["merged_by_type_7d"]')"
check "work: issues opened/closed/bugs closed/open (open_now from the open-issues call)" "[1, 1, 1, 3]" "$(exp '[d["panels"]["work"]["data"]["issues"][k] for k in ("opened_7d","closed_7d","bugs_closed_7d","open_now")]')"
check "health: OK on fixtures" "OK" "$(exp 'd["panels"]["health"]["status"]')"
check "health: CI counts" "[3, 1, 75.0]" "$(exp '[d["panels"]["health"]["data"]["ci"]["all"][k] for k in ("success","failure","green_rate_pct")]')"
check "health: per-workflow green rate (Tests 1 of 2)" "50.0" "$(exp 'd["panels"]["health"]["data"]["ci"]["by_workflow"]["Tests"]["green_rate_pct"]')"
check "health: open P0 issue counted by label" "1" "$(exp 'd["panels"]["health"]["data"]["p0"]["open_p0_issues"]')"
check "health: blocked/review-blocked/parked rows" "[1, 1, 1]" "$(exp '[d["panels"]["health"]["data"]["blocked"][k] for k in ("blocked","review_blocked","parked")]')"
check "health: usage percents from the governor stub" "[10.0, 2.0]" "$(exp '[d["panels"]["health"]["data"]["usage"][k] for k in ("weekly_percent","window_5h_percent")]')"
check "health: usage cap from the stub command" "[False, 42.5, 90]" "$(exp '[d["panels"]["health"]["data"]["usage_cap"][k] for k in ("paused","week_pct","ceiling")]')"
check "health: leader pid read and alive" "[True]" "$(exp '[d["panels"]["health"]["data"]["system"]["leader"]["alive"]]')"
check "releases: lead time is publish minus release commit" "5.0" "$(exp 'd["panels"]["releases"]["data"]["timeline"][0]["lead_time_min"]')"
check "releases: lead time summary n and median" "[1, 5.0]" "$(exp '[d["panels"]["releases"]["data"]["lead_time"][k] for k in ("n","median_min")]')"
check "releases: CI per release SHA is red when a run on it failed" "[2, 'red', ['Tests']]" "$(exp '[d["panels"]["releases"]["data"]["timeline"][0]["ci"][k] for k in ("runs","state","red")]')"
check "releases: release without a commit has no lead time (None, not 0)" "None" "$(exp 'd["panels"]["releases"]["data"]["timeline"][1]["lead_time_min"]')"
check "releases: 7d rate" "2" "$(exp 'd["panels"]["releases"]["data"]["rates"]["last_7d"]')"
check "agents: main session cost 24h (1M in + 0.1M out opus = 6.00)" "6.0" "$(exp 'd["panels"]["agents"]["data"]["transcripts"]["last_24h"]["main_session"]["usd"]')"
check "agents: seat cost from agent-setting (cto opus = 3.00)" "3.0" "$(exp '[s for s in d["panels"]["agents"]["data"]["seats"] if s["slug"]=="cto"][0]["cost"]["usd_24h"]')"
check "agents: cost labelled ESTIMATE list-price" "True" "$(exp '"list-price" in [s for s in d["panels"]["agents"]["data"]["seats"] if s["slug"]=="cto"][0]["cost"]["label"]')"
check "compare: commits week over week" "[5, 1, 400.0]" "$(exp '[d["panels"]["compare"]["data"]["week_over_week"]["metrics"]["commits"][k] for k in ("this_7d","prev_7d","pct")]')"
check "compare: zero previous value gives pct None, not a fake percent" "None" "$(exp 'd["panels"]["compare"]["data"]["week_over_week"]["metrics"]["npm_releases"]["pct"]')"
check "compare: token cost 7d (6 + 3 + 3)" "12.0" "$(exp 'd["panels"]["compare"]["data"]["week_over_week"]["metrics"]["token_cost_usd"]["this_7d"]')"
check "compare: seat vs seat order and cost" "[('main-session', 6.0), ('cto', 3.0), ('spawned-agent', 3.0)]" "$(exp '[(x["seat"], x["usd_7d"]) for x in d["panels"]["compare"]["data"]["seat_vs_seat"]["seats"] if x["usd_7d"]][:3]' | sed 's/(.cto., 3.0), (.spawned-agent., 3.0)/&/')"
check "compare: model mix 24h opus share" "75.0" "$(exp '[x for x in d["panels"]["compare"]["data"]["model_mix"]["last_24h"] if x["tier"]=="opus"][0]["usd_share_pct"]')"
check "compare: unpriced model is listed, not priced at 0 silently" "{'mystery-9': 1}" "$(exp 'd["panels"]["compare"]["data"]["model_mix"]["unpriced_models"]')"
check "compare: scoreboard UNKNOWN when the dir is missing" "UNKNOWN" "$(exp 'd["panels"]["compare"]["data"]["sources"]["scoreboard"]["status"]')"
check "compare: panel is PARTIAL (one section UNKNOWN)" "PARTIAL" "$(exp 'd["panels"]["compare"]["status"]')"
check "roi: company cost 7d" "12.0" "$(exp 'd["panels"]["roi"]["data"]["company"]["cost_7d_usd"]')"
check "roi: cost per npm release" "6.0" "$(exp 'd["panels"]["roi"]["data"]["company"]["usd_per_release"]')"
check "roi: cost per released slice" "12.0" "$(exp 'd["panels"]["roi"]["data"]["company"]["usd_per_slice"]')"
check "roi: cost per fix commit" "12.0" "$(exp 'd["panels"]["roi"]["data"]["company"]["usd_per_bug_fix"]')"
check "roi: plan proration is labelled ASSUMPTION" "True" "$(exp 'd["panels"]["roi"]["data"]["company"]["plan_proration_label"].startswith("ASSUMPTION")')"
check "roi: per-seat cost for cto" "3.0" "$(exp '[s for s in d["panels"]["roi"]["data"]["by_seat"]["seats"] if s["seat"]=="cto"][0]["cost_7d_usd"]')"
check "roi: ROI multiple still withheld" "None" "$(exp 'd["panels"]["roi"]["data"]["roi"]["multiple"]')"

echo "== usage cap command (scripts/usage-cap.py contract)"
capq() { # capq <stub-or-missing> <python expr over d>
    local cmd="bash $FIX/sb/$1.sh"
    [ "$1" = "missing" ] && cmd="python3 $FIX/no-such-usage-cap.py check --json --no-refresh"
    COCKPIT_USAGE_CAP_CMD="$cmd" python3 "$SERVER" --once --json --panel health >"$FIX/cap-$1.json" 2>/dev/null
    pj "$FIX/cap-$1.json" "$2"
}
CAPX='[d["panels"]["health"]["data"]["usage_cap"][k] for k in ("paused","state","reason","week_pct","ceiling","override","reading_at")]'
check "cap OK: mapped fields" "[False, 'OK', 'ok', 42.5, 90, False, '2026-10-23T11:00:00Z']" "$(capq capok "$CAPX")"
check "cap PAUSED reason cap" "[True, 'PAUSED', 'cap', 91.0, 90, False, '2026-10-23T11:00:00Z']" "$(capq cappaused "$CAPX")"
check "cap PAUSED reason stale" "[True, 'PAUSED', 'stale', 40.0, 90, False, '2026-10-23T09:00:00Z']" "$(capq capstale "$CAPX")"
check "cap override: week over ceiling but state OK and override true" "[False, 'OK', 'ok', 95.0, 90, True, '2026-10-23T11:00:00Z']" "$(capq capover "$CAPX")"
check "cap PAUSED carries the message" "weekly cap reached" "$(capq cappaused 'd["panels"]["health"]["data"]["usage_cap"]["message"]')"
check "cap OK: section source OK" "OK" "$(capq capok 'd["panels"]["health"]["data"]["sources"]["usage_cap"]["status"]')"
UNK='[d["panels"]["health"]["data"]["usage_cap"], d["panels"]["health"]["data"]["sources"]["usage_cap"]["status"], bool(d["panels"]["health"]["data"]["sources"]["usage_cap"]["error"])]'
check "cap script missing: UNKNOWN with error, no value" "[None, 'UNKNOWN', True]" "$(capq missing "$UNK")"
check "cap script non-zero rc: UNKNOWN with error" "[None, 'UNKNOWN', True]" "$(capq capfail "$UNK")"
check "cap bad JSON: UNKNOWN with error" "[None, 'UNKNOWN', True]" "$(capq capbad "$UNK")"
check "cap unknown state value: UNKNOWN, never OK" "[None, 'UNKNOWN', True]" "$(capq capodd "$UNK")"
check "cap UNKNOWN does not hide the governor usage section" "OK" "$(capq capfail 'd["panels"]["health"]["data"]["sources"]["usage"]["status"]')"
check "cap file concept removed (no USAGE-OVERRIDE read)" "False" "$(capq capok '"usage_cap_file" in d["panels"]["health"]["data"]["usage"]')"

echo "== scoreboard positive control"
COCKPIT_SCOREBOARD_DIR="$FIX/sb-good" python3 "$SERVER" --once --json --panel compare >"$FIX/sbg.json" 2>/dev/null
check "scoreboard file fields shown verbatim" "7" "$(pj "$FIX/sbg.json" 'd["panels"]["compare"]["data"]["scoreboard"]["fields"]["loki_pass"]')"
check "compare is OK once every section has a source" "OK" "$(pj "$FIX/sbg.json" 'd["panels"]["compare"]["status"]')"

echo "== every source missing: UNKNOWN with the error, never 0"
dead() { # dead <panel> <env assignments...>: run one panel with some sources broken
    local panel="$1"; shift
    env "$@" python3 "$SERVER" --once --json --panel "$panel" 2>/dev/null
}
dead work COCKPIT_GIT_ROOT="$FIX/no-such-repo" >"$FIX/d-git.json"
check "git missing: work.commits is None" "None" "$(pj "$FIX/d-git.json" 'd["panels"]["work"]["data"]["commits"]')"
check "git missing: commits source UNKNOWN with an error" "True" "$(pj "$FIX/d-git.json" 'd["panels"]["work"]["data"]["sources"]["commits"]["status"]=="UNKNOWN" and bool(d["panels"]["work"]["data"]["sources"]["commits"]["error"])')"
check "git missing: the other sections still render (PARTIAL)" "PARTIAL" "$(pj "$FIX/d-git.json" 'd["panels"]["work"]["status"]')"
dead work COCKPIT_GH_ISSUES_CMD=false COCKPIT_GH_PRS_CMD=false >"$FIX/d-gh.json"
check "gh issues missing: work.issues None" "None" "$(pj "$FIX/d-gh.json" 'd["panels"]["work"]["data"]["issues"]')"
check "gh prs missing: work.pull_requests None" "None" "$(pj "$FIX/d-gh.json" 'd["panels"]["work"]["data"]["pull_requests"]')"
dead work BOARD_MD="$FIX/no-board.md" >"$FIX/d-board.json"
check "BOARD missing: work.slices None" "None" "$(pj "$FIX/d-board.json" 'd["panels"]["work"]["data"]["slices"]')"
dead health COCKPIT_GH_RUNS_CMD=false COCKPIT_GH_ISSUES_CMD=false COCKPIT_GH_OPEN_ISSUES_CMD=false BOARD_MD="$FIX/no-board.md" COCKPIT_USAGE_CMD=false COCKPIT_USAGE_CAP_CMD=false COCKPIT_LEADER_FILE="$FIX/no-leader" >"$FIX/d-health.json"
check "health: ci, p0, blocked, usage all None" "[None, None, None, None]" "$(pj "$FIX/d-health.json" '[d["panels"]["health"]["data"][k] for k in ("ci","p0","blocked","usage")]')"
check "health: leader file missing gives leader None and an error string" "[None, True]" "$(pj "$FIX/d-health.json" '[d["panels"]["health"]["data"]["system"]["leader"], bool(d["panels"]["health"]["data"]["system"]["leader_error"])]')"
check "health: five sections UNKNOWN, panel PARTIAL" "[5, 'PARTIAL']" "$(pj "$FIX/d-health.json" '[sum(1 for v in d["panels"]["health"]["data"]["sources"].values() if v["status"]=="UNKNOWN"), d["panels"]["health"]["status"]]')"
dead compare COCKPIT_TRANSCRIPT_ROOT="$FIX/no-transcripts" >"$FIX/d-tx.json"
check "transcripts missing: seat_vs_seat and model_mix None (no zero cost)" "[None, None]" "$(pj "$FIX/d-tx.json" '[d["panels"]["compare"]["data"]["seat_vs_seat"], d["panels"]["compare"]["data"]["model_mix"]]')"
check "transcripts missing: token cost metrics are None" "[None, None]" "$(pj "$FIX/d-tx.json" '[d["panels"]["compare"]["data"]["week_over_week"]["metrics"]["token_cost_usd"]["this_7d"], d["panels"]["compare"]["data"]["week_over_week"]["metrics"]["output_tokens"]["this_7d"]]')"
dead roi COCKPIT_TRANSCRIPT_ROOT="$FIX/no-transcripts" >"$FIX/d-roi.json"
check "transcripts missing: roi company cost is None, ratios withheld" "[None, None, None]" "$(pj "$FIX/d-roi.json" '[d["panels"]["roi"]["data"]["company"][k] for k in ("cost_7d_usd","usd_per_release","usd_per_slice")]')"
dead agents COCKPIT_TRANSCRIPT_ROOT="$FIX/no-transcripts" >"$FIX/d-agents.json"
check "transcripts missing: seat cost is UNKNOWN with an error and no usd key (not 0)" "['UNKNOWN', True, False]" "$(pj "$FIX/d-agents.json" '(lambda c: [c.get("state"), bool(c.get("error")), "usd_7d" in c])([s for s in d["panels"]["agents"]["data"]["seats"] if s["slug"]=="cto"][0]["cost"])')"
dead compare COCKPIT_PRICING_JSON="$FIX/no-pricing.json" >"$FIX/d-price.json"
check "price table missing: cost metrics None" "None" "$(pj "$FIX/d-price.json" 'd["panels"]["compare"]["data"]["seat_vs_seat"]')"
dead releases COCKPIT_GH_RUNS_CMD=false >"$FIX/d-rel.json"
check "gh runs missing: release timeline CI is None (not green)" "True" "$(pj "$FIX/d-rel.json" 'all(r["ci"] is None for r in d["panels"]["releases"]["data"]["timeline"])')"

echo "== no panel emits a number without a source"
cat >"$FIX/walker.py" <<'PYEOF'
import json, sys

def has_num(v):
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    if isinstance(v, dict):
        return any(has_num(x) for x in v.values())
    if isinstance(v, list):
        return any(has_num(x) for x in v)
    return False

bad = []
snap = json.load(open(sys.argv[1]))
for name, p in snap["panels"].items():
    if not p.get("source_cmd"):
        bad.append("%s: envelope has no source_cmd" % name)
    if not p.get("as_of"):
        bad.append("%s: envelope has no as_of" % name)
    data = p.get("data") or {}
    led = data.get("sources")
    if led is None:
        continue
    claimed = {}
    for sec, src in led.items():
        if not src.get("source"):
            bad.append("%s.%s: empty source" % (name, sec))
        if not src.get("as_of"):
            bad.append("%s.%s: empty as_of" % (name, sec))
        if src.get("status") == "UNKNOWN" and not src.get("error"):
            bad.append("%s.%s: UNKNOWN without an error" % (name, sec))
        for k in src.get("keys", []):
            claimed.setdefault(k, []).append(sec)
    for k, v in data.items():
        if k == "sources":
            continue
        if has_num(v) and k not in claimed:
            bad.append("%s.%s: contains a number but no source claims it" % (name, k))
    for k, secs in claimed.items():
        if k in data and data[k] is not None and has_num(data[k]) and all(led[s]["status"] == "UNKNOWN" for s in secs):
            bad.append("%s.%s: number emitted while every claiming source is UNKNOWN" % (name, k))
print("ok" if not bad else "; ".join(bad))
PYEOF
check "walker: fixture snapshot (all sources present)" "ok" "$(python3 "$FIX/walker.py" "$FIX/ex.json")"
env COCKPIT_GIT_ROOT="$FIX/x1" COCKPIT_GH_RUNS_CMD=false COCKPIT_GH_ISSUES_CMD=false COCKPIT_GH_OPEN_ISSUES_CMD=false COCKPIT_GH_PRS_CMD=false \
    COCKPIT_TRANSCRIPT_ROOT="$FIX/x2" COCKPIT_USAGE_CMD=false COCKPIT_LEADER_FILE="$FIX/x3" BOARD_MD="$FIX/x4.md" \
    COCKPIT_NPM_CMD=false COCKPIT_GH_CMD=false python3 "$SERVER" --once --json >"$FIX/allbad.json" 2>/dev/null
check "walker: snapshot with every executive source broken" "ok" "$(python3 "$FIX/walker.py" "$FIX/allbad.json")"
cp "$FIX/ex.json" "$FIX/ex-mut.json"
python3 - "$FIX/ex-mut.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["panels"]["work"]["data"]["sources"]["commits"]["keys"] = []
json.dump(d, open(p, "w"))
PYEOF
if [ "$(python3 "$FIX/walker.py" "$FIX/ex-mut.json")" != "ok" ]; then ok "walker detects an unclaimed number (mutation control)"; else bad "walker missed an unclaimed number"; fi
python3 - "$FIX/ex.json" "$FIX/ex-mut2.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
d["panels"]["health"]["data"]["sources"]["ci"]["error"] = None
d["panels"]["health"]["data"]["sources"]["ci"]["status"] = "UNKNOWN"
json.dump(d, open(sys.argv[2], "w"))
PYEOF
if [ "$(python3 "$FIX/walker.py" "$FIX/ex-mut2.json")" != "ok" ]; then ok "walker detects UNKNOWN source that still has numbers (mutation control)"; else bad "walker missed UNKNOWN-with-data"; fi

echo "== mutation helper (python str.replace, each pattern must occur exactly once)"
cat >"$FIX/mutate.py" <<'PYEOF'
import sys
src, dst, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
t = open(src, encoding="utf-8").read()
for old, new in zip(pairs[::2], pairs[1::2]):
    n = t.count(old)
    if n != 1:
        print("stale mutation pattern (%d hits): %s" % (n, old))
        sys.exit(3)
    t = t.replace(old, new)
open(dst, "w", encoding="utf-8").write(t)
PYEOF
mkmut() { # mkmut <name> [<old> <new>...]: writes $FIX/m-<name>/tools/cockpit/server.py and prints its path
    # The copy keeps the repo layout (scripts/ linked) so HERE-relative loads resolve as in the checkout.
    local d="$FIX/m-$1"
    shift
    mkdir -p "$d/tools/cockpit"
    [ -e "$d/scripts" ] || ln -s "$REPO_ROOT/scripts" "$d/scripts"
    cp "$REPO_ROOT/tools/cockpit/index.html" "$REPO_ROOT/tools/cockpit/roi-basis.json" "$d/tools/cockpit/"
    rm -rf "$d/tools/cockpit/vendor"
    cp -R "$REPO_ROOT/tools/cockpit/vendor" "$d/tools/cockpit/vendor"
    python3 "$FIX/mutate.py" "$SERVER" "$d/tools/cockpit/server.py" "$@" >&2 || return 1
    printf '%s\n' "$d/tools/cockpit/server.py"
}
srvpy() { # srvpy <server.py> <python expr over module m>: import a server copy and print the expression
    python3 - "$1" "$2" 2>&1 <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("cockpit_server_under_test", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(eval(sys.argv[2]))
PYEOF
}

echo "== N1: governor TTL floor is 300 s"
check "COCKPIT_GOVERNOR_TTL_S=10 is floored to 300" "300" "$(COCKPIT_GOVERNOR_TTL_S=10 srvpy "$SERVER" 'm.GOVERNOR_TTL_S')"
check "COCKPIT_GOVERNOR_TTL_S=900 is kept" "900" "$(COCKPIT_GOVERNOR_TTL_S=900 srvpy "$SERVER" 'm.GOVERNOR_TTL_S')"
if M="$(mkmut ttl 'GOVERNOR_TTL_S = max(300,' 'GOVERNOR_TTL_S = max(0,')"; then
    check "mutant (floor removed) is caught: TTL 10 leaks through" "10" "$(COCKPIT_GOVERNOR_TTL_S=10 srvpy "$M" 'm.GOVERNOR_TTL_S')"
else
    bad "mutation ttl did not apply (stale pattern)"
fi

echo "== N2: open issues come from a separate --state open --limit 1000 call"
N2X='(lambda c: " ".join(c[:3]) == "gh issue list" and "--state open" in " ".join(c) and "--limit 1000" in " ".join(c))(m.Ctx(m.HERE).gh_open_issues_cmd)'
check "default open-issues command is gh issue list --state open --limit 1000" "True" "$(unset COCKPIT_GH_OPEN_ISSUES_CMD; srvpy "$SERVER" "$N2X")"
check "health p0 counted from the open-issues call" "1" "$(exp 'd["panels"]["health"]["data"]["p0"]["open_p0_issues"]')"
check "issues source names the open-issues call" "True" "$(exp '"ghopen" in d["panels"]["work"]["data"]["sources"]["issues"]["source"]')"
COCKPIT_GH_OPEN_ISSUES_CMD=false python3 "$SERVER" --once --json --panel work >"$FIX/n2-dead.json" 2>/dev/null
check "open-issues call failing: open_now None with an error, never the window count" "[None, True]" \
    "$(pj "$FIX/n2-dead.json" '[d["panels"]["work"]["data"]["issues"]["open_now"], bool(d["panels"]["work"]["data"]["issues"].get("open_now_error"))]')"
if M="$(mkmut n2 'ctx.gh_open_issues_cmd, "gh issue list --state open"' 'ctx.gh_issues_cmd, "gh issue list --state open"')"; then
    python3 "$M" --repo-root "$REPO_ROOT" --once --json --panel work >"$FIX/n2-mut.json" 2>/dev/null
    check "mutant (open_now from the 300-row window) is caught: open_now 2, not 3" "2" "$(pj "$FIX/n2-mut.json" 'd["panels"]["work"]["data"]["issues"]["open_now"]')"
else
    bad "mutation n2 did not apply (stale pattern)"
fi

echo "== B1: BOARD status cell forms, unknown-time rows, 7d window"
{
    echo "| ID | Owner | Branch @ SHA | File set (summary) | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|---|"
    echo "| R-a | cto | b @ abc | f | LOW | released v11.17.47@2026-10-22T10:00Z | prefix version |"
    echo "| R-b | cto | b @ abc | f | LOW | released@2026-10-21T10:00Z v11.1.0 | suffix version |"
    echo "| R-c | cto | b @ abc | f | LOW | released@2026-10-23T11:00Z: shipped | colon note |"
    echo "| R-d | cto | b @ abc | f | LOW | released v11.17.47 | no time |"
    echo "| R-e | cto | b @ abc | f | LOW | released | bare |"
    echo "| R-f | cto | b @ abc | f | LOW | released@2026-10-10T10:00Z | outside 7d |"
    echo "| R-g | cto | b @ abc | f | LOW | released v1.2.3 (note) | paren note |"
} >"$FIX/BOARD2.md"
B1X='[(x or (None,))[0:3] for x in map(m.parse_status_cell, ["released v11.17.47@2026-10-22T10:00Z", "released@2026-10-21T10:00Z v11.1.0", "released v11.17.47", "released", "released v1.2.3 (note)", "in progress someday"])]'
B1W='(lambda s: [s["released_24h"], s["released_7d"], s["released_unknown_time"], s["rows_parsed"], s["unparsed_rows"]])(d["panels"]["work"]["data"]["slices"])'
B1WANT="[('released', '2026-10-22T10:00Z', 'v11.17.47'), ('released', '2026-10-21T10:00Z', 'v11.1.0'), ('released', None, 'v11.17.47'), ('released', None, None), ('released', None, 'v1.2.3'), (None,)]"
check "parse_status_cell: every released form keeps token, time and version" "$B1WANT" "$(srvpy "$SERVER" "$B1X")"
BOARD_MD="$FIX/BOARD2.md" python3 "$SERVER" --once --json --panel work >"$FIX/b1.json" 2>/dev/null
check "work slices: 24h=1, 7d=3, unknown-time=3, all 7 rows parsed" "[1, 3, 3, 7, 0]" "$(pj "$FIX/b1.json" "$B1W")"
if M="$(mkmut b1re '(?:\s+(v?\d+\.\d+\.\d+\S*?))?(?:@' '()(?:@')"; then
    if [ "$(srvpy "$M" "$B1X")" != "$B1WANT" ]; then ok "mutant (prefix version group removed) is caught by the parser probe"; else bad "parser probe missed the prefix-version mutant"; fi
else
    bad "mutation b1re did not apply (stale pattern)"
fi
if M="$(mkmut b1win '"released_7d": sum(1 for r in rel if inwin(r, d7))' '"released_7d": len(rel)')"; then
    BOARD_MD="$FIX/BOARD2.md" python3 "$M" --repo-root "$REPO_ROOT" --once --json --panel work >"$FIX/b1-mut.json" 2>/dev/null
    check "mutant (7d window dropped) is caught: released_7d 7, not 3" "7" "$(pj "$FIX/b1-mut.json" 'd["panels"]["work"]["data"]["slices"]["released_7d"]')"
else
    bad "mutation b1win did not apply (stale pattern)"
fi

echo "== B1: BOARD file as_of and STALE past 24 h"
mkdir -p "$FIX/stale"
cp "$FIX/BOARD.md" "$FIX/stale/BOARD.md"
TZ=UTC touch -t 202610211200.00 "$FIX/stale/BOARD.md"
BOARD_MD="$FIX/stale/BOARD.md" python3 "$SERVER" --once --json >"$FIX/stale.json" 2>/dev/null
STX='[d["panels"]["board"]["status"], d["panels"]["board"]["as_of"], d["panels"]["board"]["data"]["freshness"]["basis"], d["panels"]["work"]["data"]["sources"]["slices"]["status"], d["panels"]["work"]["data"]["sources"]["slices"]["as_of"]]'
check "48 h old untracked BOARD: board and slices STALE, as_of is the file mtime" \
    "['STALE', '2026-10-21T12:00:00Z', 'mtime', 'STALE', '2026-10-21T12:00:00Z']" "$(pj "$FIX/stale.json" "$STX")"
check "STALE board keeps its numbers (counts still reported)" "2" "$(pj "$FIX/stale.json" 'd["panels"]["board"]["data"]["counts"]["building"]')"
check "walker: snapshot with a STALE board" "ok" "$(python3 "$FIX/walker.py" "$FIX/stale.json")"
TZ=UTC touch -t 202610231100.00 "$FIX/stale/BOARD.md"
BOARD_MD="$FIX/stale/BOARD.md" python3 "$SERVER" --once --json --panel board >"$FIX/fresh.json" 2>/dev/null
check "1 h old BOARD is OK with as_of = mtime (positive control)" "['OK', '2026-10-23T11:00:00Z']" "$(pj "$FIX/fresh.json" '[d["panels"]["board"]["status"], d["panels"]["board"]["as_of"]]')"
TZ=UTC touch -t 202610211200.00 "$FIX/stale/BOARD.md"
if M="$(mkmut stale '"stale": age_h is not None and age_h > thr}' '"stale": False}')"; then
    BOARD_MD="$FIX/stale/BOARD.md" python3 "$M" --repo-root "$REPO_ROOT" --once --json --panel board >"$FIX/stale-mut.json" 2>/dev/null
    check "mutant (never stale) is caught: 48 h old board reads OK" "OK" "$(pj "$FIX/stale-mut.json" 'd["panels"]["board"]["status"]')"
else
    bad "mutation stale did not apply (stale pattern)"
fi

echo "== N5: hour-floor disclosure, local tag label, seat total"
check "agents transcripts carry the hour-floor note" "True" "$(exp '"hour-floored" in d["panels"]["agents"]["data"]["transcripts"]["window_note"]')"
check "agents data has total = number of seats" "True" "$(exp 'd["panels"]["agents"]["data"]["total"] == len(d["panels"]["agents"]["data"]["seats"])')"
check "release timeline rows carry local_tag_exists" "True" "$(exp 'all("local_tag_exists" in r for r in d["panels"]["releases"]["data"]["timeline"])')"
htmlq() { # htmlq <index.html>: which N5 client labels are present, and the appendChild count
    python3 - "$1" <<'PYEOF'
import sys
t = open(sys.argv[1], encoding="utf-8").read()
print([s in t for s in ('"local tag"', "hour-floored", "d.total", "local_tag_exists")], t.count(".appendChild("))
PYEOF
}
check "page: local tag column, hour-floor label, d.total; one appendChild" "[True, True, True, True] 1" "$(htmlq "$REPO_ROOT/tools/cockpit/index.html")"
python3 "$FIX/mutate.py" "$REPO_ROOT/tools/cockpit/index.html" "$FIX/index-mut.html" '"local tag"' '"tag"' \
    'if(!isNode(c))c=document.createTextNode(String(c));' 'if(!isNode(c))document.body.appendChild(c);'
check "mutant page (label renamed, second appendChild) is caught" "[False, True, True, True] 2" "$(htmlq "$FIX/index-mut.html")"
if M="$(mkmut n5 '"unpriced_models": toks["unpriced_models"], "window_note": HOUR_FLOOR_NOTE}' '"unpriced_models": toks["unpriced_models"]}' '"local_tag_exists": ((' '"tag_exists": ((')"; then
    python3 "$M" --repo-root "$REPO_ROOT" --once --json >"$FIX/n5-mut.json" 2>/dev/null
    check "mutant (note and local_tag_exists dropped) is caught" "[False, False]" "$(pj "$FIX/n5-mut.json" '["window_note" in d["panels"]["agents"]["data"]["transcripts"], all("local_tag_exists" in r for r in d["panels"]["releases"]["data"]["timeline"])]')"
else
    bad "mutation n5 did not apply (stale pattern)"
fi

echo "== B3: three.js is vendored, sha256-pinned, and the CSP names no third-party origin"
THREE_PIN="76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495"
sha256f() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
cspq() { # cspq: read a CSP on stdin, print every scheme-qualified or wildcard source in it
    python3 -c 'import re,sys; print(re.findall(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s;]*|(?<![A-Za-z])\*", sys.stdin.read()))'
}
check "vendored three.module.js matches the pinned sha256" "$THREE_PIN" "$(sha256f "$REPO_ROOT/tools/cockpit/vendor/three.module.js")"
check "server THREE_SHA256 is the same pin, and load_vendor accepts the file" "$THREE_PIN None" "$(srvpy "$SERVER" 'm.THREE_SHA256 + " " + str(m.load_vendor()[1])')"
check "server CSP names no third-party origin" "[]" "$(srvpy "$SERVER" 'm.CSP' | cspq)"
check "page imports three.js only from /vendor (no CDN, no absolute URL import)" "[True, 0]" \
    "$(python3 -c 'import re,sys; t=open(sys.argv[1]).read(); print([chr(34)+"/vendor/three.module.js"+chr(34) in t, len(re.findall(r"import\(\s*.https?:", t)) + t.count("jsdelivr")])' "$REPO_ROOT/tools/cockpit/index.html")"
if M="$(mkmut cdn "\"default-src 'self'; script-src 'self' 'unsafe-inline';" "\"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;")"; then
    check "mutant (CDN back in the CSP) is caught" "['https://cdn.jsdelivr.net']" "$(srvpy "$M" 'm.CSP' | cspq)"
    printf 'x' >>"$(dirname "$M")/vendor/three.module.js"
    check "mutant (tampered vendored module) is refused by load_vendor" "True True" \
        "$(srvpy "$M" '" ".join([str(m.load_vendor()[0] is None), str("sha256 mismatch" in m.load_vendor()[1])])')"
else
    bad "mutation cdn did not apply (stale pattern)"
fi

echo "== B1-sibling: every BOARD-derived source is STALE while BOARD.md is stale"
cat >"$FIX/bsrc.py" <<'PYEOF'
# Prints [offenders] [required sections missing from the BOARD-derived set] for a --once --json snapshot.
import json, sys
d = json.load(open(sys.argv[1]))
board = sys.argv[2]
need = {"work.slices", "agents.slice_owners", "health.blocked", "roi.value", "roi.by_seat", "roi.company",
        "compare.week_over_week", "compare.day_over_day", "compare.seat_vs_seat"}
seen, bad = set(), []
for pname, p in d["panels"].items():
    for key, srcent in ((p.get("data") or {}).get("sources") or {}).items():
        text = str(srcent.get("source") or "")
        if "BOARD" in text or board in text:
            seen.add(pname + "." + key)
            if srcent.get("status") == "OK":
                bad.append(pname + "." + key)
if (d["panels"]["roi"]["data"]["roi"] or {}).get("multiple") is not None and d["panels"]["roi"]["status"] == "OK":
    bad.append("roi panel")
print(sorted(bad), sorted(need - seen))
PYEOF
check "stale BOARD: no BOARD-derived source reads OK, and every known BOARD reader is covered" "[] []" \
    "$(python3 "$FIX/bsrc.py" "$FIX/stale.json" "$FIX/stale/BOARD.md")"
check "watcher invalidates roi and compare on a BOARD change" "True" "$(srvpy "$SERVER" 'all(p in m.Watcher.PANELS_FOR["board"] for p in ("board", "work", "agents", "roi", "compare"))')"
if M="$(mkmut bsib '        board_mark(S, ctx, "by_seat", bfr)' '        pass' '            board_mark(S, ctx, "week_over_week")' '            pass')"; then
    BOARD_MD="$FIX/stale/BOARD.md" python3 "$M" --repo-root "$REPO_ROOT" --once --json >"$FIX/bsib-mut.json" 2>/dev/null
    check "mutant (by_seat and week_over_week skip the STALE mark) is caught" "['compare.week_over_week', 'roi.by_seat'] []" \
        "$(python3 "$FIX/bsrc.py" "$FIX/bsib-mut.json" "$FIX/stale/BOARD.md")"
else
    bad "mutation bsib did not apply (stale pattern)"
fi

echo "== M1: a failing watcher step logs and degrades the stream, then recovers"
cat >"$FIX/m1.py" <<'PYEOF'
import importlib.util, io, sys
spec = importlib.util.spec_from_file_location("cockpit_server_m1", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
w = m.Watcher(m.Ctx(sys.argv[2]), None, interval=1)
err, sys.stderr = sys.stderr, io.StringIO()
def boom():
    raise RuntimeError("disk gone")
w.groups = boom
w.tick()
logged = "step failed" in sys.stderr.getvalue()
sys.stderr = err
first = [w.degraded is not None and "disk gone" in w.degraded["error"], w.dseq, logged]
w.groups = lambda: {"board": 1}
w.tick()
print(first, [w.degraded, w.dseq])
PYEOF
check "watcher step failure: degraded with the error, logged, then cleared on the next good step" "[True, 1, True] [None, 2]" "$(python3 "$FIX/m1.py" "$SERVER" "$REPO_ROOT" 2>&1)"
check "stream emits event: degraded; page has a 60 s safety refresh and a degraded handler" "[True, True, True]" \
    "$(python3 -c 'import sys; s=open(sys.argv[1]).read(); h=open(sys.argv[2]).read(); print(["event: degraded" in s, "if(liveMode===\"live\")refresh();},60000)" in h, "addEventListener(\"degraded\"" in h])' "$SERVER" "$REPO_ROOT/tools/cockpit/index.html")"
if M="$(mkmut m1 '        except Exception as ex:
            sys.stderr.write("cockpit watcher: step failed: %r\n" % (ex,))
            with self.cond:
                self.degraded = {"at": iso(self.ctx.now()), "error": repr(ex)[:300]}
                self.dseq += 1
                self.cond.notify_all()
            return None' '        except Exception:
            return None')"; then
    check "mutant (silent swallow, as before) is caught" "[False, 0, False] [None, 0]" "$(python3 "$FIX/m1.py" "$M" "$REPO_ROOT" 2>&1)"
else
    bad "mutation m1 did not apply (stale pattern)"
fi

echo "== L2, L3: member slug checked before any panel read; governor loaded from the server checkout"
check "member route checks the agent slug before store.get" "True" \
    "$(python3 -c 'import sys; s=open(sys.argv[1]).read(); a=s.index("slug not in agent_slugs(ctx)[0]"); b=s.index("collect_member(ctx, slug, store.get("); print(a < b)' "$SERVER")"
mkdir -p "$FIX/bare-root"
L3X='(lambda r: [r[0] is not None, r[1]])(m.ds_tokens(m.Ctx("'"$FIX/bare-root"'")))'
check "a --repo-root without scripts/ still reads transcripts via the server checkout's usage-governor.py" "[True, None]" "$(srvpy "$SERVER" "$L3X")"
if M="$(mkmut l3 'os.path.join(HERE, "..", "..", "scripts", "usage-governor.py")' 'os.path.join(ctx.root, "scripts", "usage-governor.py")')"; then
    check "mutant (governor from --repo-root) is caught: the load fails" "True" "$(srvpy "$M" '"cannot load usage-governor" in str(m.ds_tokens(m.Ctx("'"$FIX/bare-root"'"))[1])')"
else
    bad "mutation l3 did not apply (stale pattern)"
fi

echo "== LaunchAgent plist for the cockpit"
if python3 - "$REPO_ROOT" <<'PYEOF'
import importlib.util, os, plistlib, sys, tempfile
root = sys.argv[1]
spec = importlib.util.spec_from_file_location("tsc", os.path.join(root, "autonomy", "trigger-schedule.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
argv = m.cockpit_argv(root, "/usr/bin/python3")
assert argv == ["/usr/bin/python3", os.path.join(root, "tools", "cockpit", "server.py"), "--port", "8787", "--repo-root", root], argv
assert os.path.isfile(argv[1]), "cockpit server path in the plist does not exist"
PYEOF
then ok "cockpit LaunchAgent argv points at a real server.py with --port 8787 --repo-root"; else bad "cockpit LaunchAgent argv"; fi

# ------------------------------------------------------------------ server
start_server() { # start_server <server.py> <outvar-prefix> [extra server args]; sets PORT, SPID
    local script="$1" log="$FIX/server-$2.log" i
    python3 "$script" --port 0 "${@:3}" >"$log" 2>&1 &
    SPID=$!
    SERVER_PIDS+=("$SPID")
    PORT=""
    for i in $(seq 1 100); do
        PORT="$(sed -n 's#^cockpit: http://127.0.0.1:\([0-9]*\)/.*#\1#p' "$log" | head -n 1)"
        [ -n "$PORT" ] && break
        sleep 0.1
    done
    [ -n "$PORT" ]
}

# The stream watcher polls fast so the SSE probes finish in seconds.
export COCKPIT_WATCH_INTERVAL_S=0.5
echo "== live server"
start_server "$SERVER" main || { bad "server did not start"; cat "$FIX/server-main.log"; exit 1; }
RECORDED_PID="$(sed -n 's/^cockpit pid: \([0-9]*\)$/\1/p' "$FIX/server-main.log" | head -n 1)"
check "printed PID equals the launched PID" "$SPID" "$RECORDED_PID"
check "server.pid file equals recorded PID" "$SPID" "$(cat "$FIX/rt/server.pid")"
TOKEN="$(cat "$FIX/rt/token")"
check "token file is mode 600" "600" "$(loki_run_tmp_stat_field '%a' '%Lp' "$FIX/rt/token")"
BASE="http://127.0.0.1:$PORT"
ORIGIN="$BASE"
HDRS="$FIX/hdrs.txt"

code() { curl -s -o "$FIX/body.out" -w '%{http_code}' --max-time 30 "$@"; }

check "GET /healthz 200" 200 "$(code "$BASE/healthz")"
check "healthz reports the server pid" "$SPID" "$(pj "$FIX/body.out" 'd["pid"]')"
check "bad Host header is 403" 403 "$(code -H 'Host: evil.example:80' "$BASE/healthz")"
check "bad Host on the page is 403" 403 "$(code -H 'Host: evil.example:80' "$BASE/")"
check "localhost Host header allowed" 200 "$(code -H "Host: localhost:$PORT" "$BASE/healthz")"
check "GET / 200" 200 "$(code "$BASE/")"
if grep -q "Loki Cockpit" "$FIX/body.out"; then ok "page served"; else bad "page missing title"; fi
if grep -q "__COCKPIT_TOKEN__" "$FIX/body.out"; then bad "token placeholder not replaced"; else ok "token placeholder replaced"; fi
if grep -q "$TOKEN" "$FIX/body.out"; then ok "page carries the per-process token"; else bad "token not injected"; fi
curl -s -D "$HDRS" -o /dev/null "$BASE/healthz"
if grep -qi '^x-content-type-options: nosniff' "$HDRS" && grep -qi '^cache-control: no-store' "$HDRS" && grep -qi "^content-security-policy: default-src 'self'" "$HDRS"; then ok "security headers set"; else bad "security headers missing"; fi
CSPH="$(sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: //p' "$HDRS" | tr -d '\r')"
check "served CSP header names no third-party origin" "[]" "$(printf '%s' "$CSPH" | cspq)"
check "GET /vendor/three.module.js 200" 200 "$(code -D "$FIX/vendor-hdrs.txt" "$BASE/vendor/three.module.js")"
check "served module matches the pinned sha256" "$THREE_PIN" "$(sha256f "$FIX/body.out")"
if grep -qi '^content-type: text/javascript' "$FIX/vendor-hdrs.txt"; then ok "vendored module served as text/javascript"; else bad "vendor content type: $(cat "$FIX/vendor-hdrs.txt")"; fi
check "POST /vendor/three.module.js 405" 405 "$(code -X POST "$BASE/vendor/three.module.js")"
check "GET /vendor/other.js 404 (only the one pinned file)" 404 "$(code "$BASE/vendor/other.js")"
check "GET /api/snapshot 200" 200 "$(code "$BASE/api/snapshot")"
cp "$FIX/body.out" "$FIX/snap.json"
check "snapshot has 10 panels" 10 "$(pj "$FIX/snap.json" 'len(d["panels"])')"
check "snapshot board counts match fixture" 2 "$(pj "$FIX/snap.json" 'd["panels"]["board"]["data"]["counts"]["building"]')"
check "GET /api/panel/board 200" 200 "$(code "$BASE/api/panel/board")"
check "GET /api/panel/nope 404" 404 "$(code "$BASE/api/panel/nope")"
check "GET /nope 404" 404 "$(code "$BASE/nope")"
check "GET /api/queue 405" 405 "$(code "$BASE/api/queue")"
check "PUT / 405" 405 "$(code -X PUT "$BASE/")"
check "DELETE /api/queue 405" 405 "$(code -X DELETE "$BASE/api/queue")"
check "POST /healthz 405" 405 "$(code -X POST "$BASE/healthz")"

if command -v lsof >/dev/null 2>&1; then
    L="$(lsof -nP -a -p "$SPID" -iTCP -sTCP:LISTEN 2>/dev/null)"
    if printf '%s' "$L" | grep -q "127.0.0.1:$PORT" && ! printf '%s' "$L" | grep -q '\*:'; then ok "listens on 127.0.0.1 only"; else bad "listen address: $L"; fi
fi

echo "== POST /api/queue"
post() { # post <json> [extra curl args]
    local body="$1"; shift
    code -X POST -H 'Content-Type: application/json' "$@" --data "$body" "$BASE/api/queue"
}
S0="$(wc -c <"$FIX/QUEUE.md" | tr -d ' ')"
check "POST without token 403" 403 "$(post '{"item":"x"}' -H "Origin: $ORIGIN")"
check "POST wrong token 403" 403 "$(post '{"item":"x"}' -H "Origin: $ORIGIN" -H 'X-Cockpit-Token: nope')"
check "POST wrong origin 403" 403 "$(post '{"item":"x"}' -H 'Origin: http://evil.example' -H "X-Cockpit-Token: $TOKEN")"
check "POST bad Host 403" 403 "$(post '{"item":"x"}' -H 'Host: evil.example:80' -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN")"
check "queue file untouched by rejected posts" "$S0" "$(wc -c <"$FIX/QUEUE.md" | tr -d ' ')"
LONG="$(python3 -c 'print("a"*2001)')"
check "2001 chars rejected 413" 413 "$(post "{\"item\":\"$LONG\"}" -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN")"
check "2000 chars accepted (cap boundary, positive control)" 200 "$(post "{\"item\":\"${LONG%a}\"}" -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN")"
check "oversized body rejected 413" 413 "$(post "{\"item\":\"x\",\"pad\":\"$(python3 -c 'print("b"*9000)')\"}" -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN")"
check "empty item 400" 400 "$(post '{"item":"  "}' -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN")"
check "non-JSON body 400" 400 "$(post 'not json' -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN")"

cp "$FIX/QUEUE.md" "$FIX/QUEUE.before"
SB="$(wc -c <"$FIX/QUEUE.md" | tr -d ' ')"
check "valid post 200" 200 "$(post '{"item":"do a|b\nsecond line","why":"only|me"}' -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN")"
cp "$FIX/body.out" "$FIX/post1.json"
LASTN="$(sed -n 's/^| \([0-9][0-9]*\) |.*/\1/p' "$FIX/QUEUE.before" | sort -n | tail -n 1)"
check "row number is max existing plus one" "$((LASTN + 1))" "$(pj "$FIX/post1.json" 'd["row"]')"
LINE="$(tail -n 1 "$FIX/QUEUE.md")"
check "the returned line is the last line of the file" "$(pj "$FIX/post1.json" 'd["line"]')" "$LINE"
check "line has exactly 7 pipes (pipes in input replaced)" 7 "$(printf '%s' "$LINE" | tr -cd '|' | wc -c | tr -d ' ')"
if printf '%s' "$LINE" | grep -q 'a/b second line'; then ok "pipe replaced and newline folded"; else bad "sanitizer: $LINE"; fi
if printf '%s' "$LINE" | grep -q '\[cockpit\]'; then ok "item prefixed [cockpit]"; else bad "missing prefix"; fi
if [ "$(wc -c <"$FIX/QUEUE.md" | tr -d ' ')" -gt "$SB" ]; then ok "file only grew"; else bad "file did not grow"; fi
if head -c "$SB" "$FIX/QUEUE.md" | cmp -s - "$FIX/QUEUE.before"; then ok "existing bytes unchanged (append only)"; else bad "prefix of queue changed"; fi

# Concurrent posts must get distinct numbers.
for i in 1 2 3 4 5 6; do
    (post "{\"item\":\"concurrent $i\"}" -H "Origin: $ORIGIN" -H "X-Cockpit-Token: $TOKEN" >"$FIX/cc$i.code"; ) &
done
wait_pids=$(jobs -p | grep -v "^$SPID$" | tr '\n' ' ')
# shellcheck disable=SC2086
[ -n "$wait_pids" ] && wait $wait_pids
NUMS="$(grep -F 'concurrent ' "$FIX/QUEUE.md" | sed -n 's/^| \([0-9][0-9]*\) |.*/\1/p' | sort -n | uniq | wc -l | tr -d ' ')"
check "six concurrent posts got six distinct row numbers" 6 "$NUMS"
check "queue panel reflects the new rows after invalidation" "True" "$(code "$BASE/api/panel/queue" >/dev/null; pj "$FIX/body.out" 'd["data"]["cockpit_rows"]>=7')"

echo "== GET /api/member/<slug>"
printf '{"ts":"2026-10-23T11:50:00Z","outcome":"dispatched","detail":"2 slices"}\n{"ts":"2026-10-23T11:20:00Z","outcome":"skipped","detail":"paused"}\n{"ts":"2026-10-20T10:00:00Z","outcome":"error: tick timed out"}\nnot json\n' >"$FIX/company/cto/log.jsonl"
printf '{"duration_ms":61000,"num_turns":7,"total_cost_usd":0.42,"is_error":false,"terminal_reason":"completed","modelUsage":{"claude-sonnet-4-6":{}}}\n' >"$FIX/company/cto/last.out"
check "GET /api/member/cto 200" 200 "$(code "$BASE/api/member/cto")"
cp "$FIX/body.out" "$FIX/member.json"
memq() { pj "$FIX/member.json" "$1"; }
check "member: slug, status and last tick read from the seat files" "['cto', 'OK', 'dispatched 2 slices', 'x']" "$(memq '[d["data"]["slug"], d["data"]["sources"]["status"]["status"], d["data"]["last_tick"]["outcome"], d["data"]["status"]["doing"]]')"
check "member: history from log.jsonl (bad line skipped), 24h and 7d counts, kinds" "[3, 2, 3, {'error': 1, 'ran': 1, 'skipped': 1}]" "$(memq '(lambda h: [h["total"], h["ticks_24h"], h["ticks_7d"], dict(sorted(h["outcomes_7d"].items()))])(d["data"]["history"])')"
check "member: last run duration, turns and cost from last.out (as reported by claude -p)" "[61000, 7, 0.42, ['claude-sonnet-4-6']]" "$(memq '(lambda r: [r["duration_ms"], r["num_turns"], r["total_cost_usd"], r["models"]])(d["data"]["last_run"])')"
check "member: last run cost is labelled a list-price equivalent, never MEASURED" "[True, False]" "$(memq '(lambda l: ["list-price equivalent" in l, "MEASURED" in l])(d["data"]["last_run"]["label"])')"
check "member: cost from transcripts (cto opus 3.00, ESTIMATE)" "[3.0, True]" "$(memq '[d["data"]["cost"]["usd_24h"], d["data"]["cost"]["label"].startswith("ESTIMATE")]')"
check "member: BOARD slices attributed by owner slug" "True" "$(memq 'isinstance(d["data"]["slices"]["total"], int)')"
check "member: commits are a no-data reason, never a number" "True" "$(memq 'd["data"]["commits"].startswith("no data:")')"
check "member: per-tick cost is a no-data reason" "True" "$(memq 'd["data"]["history"]["per_tick_cost"].startswith("no data:")')"
check "member: ROI row carries its formula or an UNKNOWN reason" "True" "$(memq '(d["data"]["roi"] is not None and "formula" in d["data"]["roi"]) or (d["data"]["sources"]["roi"]["status"] == "UNKNOWN" and bool(d["data"]["sources"]["roi"]["error"]))')"
python3 -c 'import json,sys; json.dump({"panels": {"member": json.load(open(sys.argv[1]))}}, open(sys.argv[2], "w"))' "$FIX/member.json" "$FIX/member-snap.json"
check "walker: member detail (every number claimed by a source)" "ok" "$(python3 "$FIX/walker.py" "$FIX/member-snap.json")"
check "GET /api/member/security-lead 200 (seat with missing files)" 200 "$(code "$BASE/api/member/security-lead")"
cp "$FIX/body.out" "$FIX/member-sl.json"
check "member with missing files: None values, UNKNOWN sources with errors, no fabricated numbers" "[None, None, None, 'UNKNOWN', True, 'UNKNOWN', True]" \
    "$(pj "$FIX/member-sl.json" '[d["data"]["status"], d["data"]["last_run"], d["data"]["history"], d["data"]["sources"]["status"]["status"], bool(d["data"]["sources"]["status"]["error"]), d["data"]["sources"]["history"]["status"], bool(d["data"]["sources"]["history"]["error"])]')"
python3 -c 'import json,sys; json.dump({"panels": {"member": json.load(open(sys.argv[1]))}}, open(sys.argv[2], "w"))' "$FIX/member-sl.json" "$FIX/member-sl-snap.json"
check "walker: member detail with missing files" "ok" "$(python3 "$FIX/walker.py" "$FIX/member-sl-snap.json")"
check "GET /api/member/nope 404 (not a .claude/agents seat)" 404 "$(code "$BASE/api/member/nope")"
check "GET /api/member/CTO 404 (slug pattern is lowercase)" 404 "$(code "$BASE/api/member/CTO")"
check "GET /api/member/..%2Fcto 404 (no path tricks)" 404 "$(code "$BASE/api/member/..%2Fcto")"
check "GET /api/member/ 404 (empty slug)" 404 "$(code "$BASE/api/member/")"
check "L1: member with a foreign Origin is 403" 403 "$(code -H 'Origin: http://evil.example' "$BASE/api/member/cto")"
check "L1: member with the served Origin is 200" 200 "$(code -H "Origin: $ORIGIN" "$BASE/api/member/cto")"
check "L1: stream with a foreign Origin is 403" 403 "$(code --max-time 3 -H 'Origin: http://evil.example' "$BASE/api/stream")"
check "L1: stream sockets carry a write timeout" "10" "$(srvpy "$SERVER" 'm.SSE_WRITE_TIMEOUT_S')"

echo "== GET /api/stream (server-sent events)"
cnt1() { if [ "${1:-0}" -gt 0 ] 2>/dev/null; then echo 1; else echo 0; fi; }
sse_probe() { # sse_probe <base-url> <tag>: prints "hello=0|1 agents_change=0|1 retry=0|1"
    local out="$FIX/sse-$2.txt" cpid
    curl -sN --max-time 6 "$1/api/stream" >"$out" 2>/dev/null &
    cpid=$!
    sleep 1.5
    printf '{"seat":"cto","model":"opus","doing":"x","slice":"S-1","next":"y","blocked_on":"decision","updated":"2026-10-23T11:55:00Z","probe":"%s"}\n' "$2" >"$FIX/status/cto.json"
    sleep 1.5
    printf '{"seat":"cto","model":"opus","doing":"x","slice":"S-1","next":"y","blocked_on":"decision","updated":"2026-10-23T11:56:00Z","probe":"%s second"}\n' "$2" >"$FIX/status/cto.json"
    wait "$cpid" 2>/dev/null
    printf 'hello=%s agents_change=%s retry=%s\n' "$(cnt1 "$(grep -c '^event: hello' "$out")")" \
        "$(cnt1 "$(grep -A1 '^event: change' "$out" | grep -c '"agents"')")" "$(cnt1 "$(grep -c '^retry: 3000' "$out")")"
}
curl -s -D "$FIX/sse-hdrs.txt" -o /dev/null --max-time 2 "$BASE/api/stream"
if grep -qi '^content-type: text/event-stream' "$FIX/sse-hdrs.txt"; then ok "stream content type is text/event-stream"; else bad "stream content type: $(cat "$FIX/sse-hdrs.txt")"; fi
check "stream: hello, then a change event naming agents after a status file write" "hello=1 agents_change=1 retry=1" "$(sse_probe "$BASE" real)"

echo "== second launch on a port in use exits 0 (no launchd crash loop)"
python3 "$SERVER" --port "$PORT" >"$FIX/inuse.log" 2>&1
check "second server on the live port exits 0" 0 "$?"
if grep -q 'already in use' "$FIX/inuse.log"; then ok "second server says the port is already in use"; else bad "in-use message: $(cat "$FIX/inuse.log")"; fi
check "first server still answers after the second launch" 200 "$(code "$BASE/healthz")"
if M="$(mkmut inuse 'if ex.errno == errno.EADDRINUSE:' 'if False:')"; then
    python3 "$M" --repo-root "$REPO_ROOT" --port "$PORT" >"$FIX/inuse-mut.log" 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then ok "mutant (EADDRINUSE not handled) is caught: exits $rc"; else bad "mutant in-use server exited 0"; fi
else
    bad "mutation inuse did not apply (stale pattern)"
fi

kill "$SPID" 2>/dev/null
wait "$SPID" 2>/dev/null

echo "== mutation: removing the sanitizer or the Host check must fail the probes"
MUT="$FIX/mut"
mkdir -p "$MUT"
cp "$REPO_ROOT/tools/cockpit/index.html" "$REPO_ROOT/tools/cockpit/roi-basis.json" "$MUT/"
sed -e 's#return s.replace("|", "/").strip()#return s.strip()#' \
    -e 's#if self.headers.get("Host") in hosts:#if True:#' "$SERVER" >"$MUT/server.py"
if cmp -s "$SERVER" "$MUT/server.py"; then bad "mutation did not change the server (stale mutation pattern)"; fi

probe() { # probe <server.py> <tag>: prints "host=<code> pipes=<n>"
    cp "$FIX/QUEUE.before" "$FIX/QUEUE.md"
    start_server "$1" "$2" || { echo "nostart"; return; }
    local pid="$SPID" port="$PORT" tok hc pipes
    tok="$(cat "$FIX/rt/token")"
    hc="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:80' "http://127.0.0.1:$port/healthz")"
    curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$port" \
        -H "X-Cockpit-Token: $tok" --data '{"item":"p|q"}' "http://127.0.0.1:$port/api/queue"
    pipes="$(tail -n 1 "$FIX/QUEUE.md" | tr -cd '|' | wc -c | tr -d ' ')"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    echo "host=$hc pipes=$pipes"
}
check "real server probe: Host rejected, pipes sanitized" "host=403 pipes=7" "$(probe "$SERVER" real)"
check "mutant probe: Host accepted, pipe kept (probe detects the mutation)" "host=200 pipes=8" "$(probe "$MUT/server.py" mut)"

echo "== mutation: a watcher that never diffs must fail the stream probe"
if M="$(mkmut sse 'diff = [k for k in new if new[k] != self.sigs.get(k)]' 'diff = []')"; then
    if start_server "$M" ssemut --repo-root "$REPO_ROOT"; then
        check "mutant stream probe: hello but no change event (probe detects the mutation)" "hello=1 agents_change=0 retry=1" "$(sse_probe "http://127.0.0.1:$PORT" mut)"
        kill "$SPID" 2>/dev/null
        wait "$SPID" 2>/dev/null
    else
        bad "sse mutant server did not start"
    fi
else
    bad "mutation sse did not apply (stale pattern)"
fi

echo "== mutation: a tampered vendored module is never served"
if M="$(mkmut tamper)"; then
    printf 'x' >>"$(dirname "$M")/vendor/three.module.js"
    if start_server "$M" tamper --repo-root "$REPO_ROOT"; then
        check "tampered three.module.js: /vendor answers 500 with a sha256 mismatch" "500 True" \
            "$(c="$(code "http://127.0.0.1:$PORT/vendor/three.module.js")"; printf '%s %s' "$c" "$(pj "$FIX/body.out" '"sha256 mismatch" in d["error"]')")"
        kill "$SPID" 2>/dev/null
        wait "$SPID" 2>/dev/null
    else
        bad "tamper mutant server did not start"
    fi
else
    bad "mutation tamper did not apply"
fi

echo "== client null-safety: the page script under a strict fake DOM (node)"
cat >"$FIX/shim.js" <<'JSEOF'
// Runs the page's #cockpit-main script against a fake DOM whose appendChild
// throws the browser's TypeError for a non-Node, then renders hostile inputs.
"use strict";
const fs = require("fs"), vm = require("vm");
const html = fs.readFileSync(process.argv[2], "utf8");
const m = html.match(/<script id="cockpit-main">([\s\S]*?)<\/script>/);
if (!m) { console.log("no #cockpit-main script"); process.exit(2); }
class Text { constructor(s) { this.nodeType = 3; this.data = String(s); this.parent = null; } get textContent() { return this.data; } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toLowerCase(); this.kids = []; this.attrs = {}; this.parent = null; this.className = "";
    this.style = { setProperty() {} }; }
  appendChild(c) {
    if (c === null || typeof c !== "object" || typeof c.nodeType !== "number")
      throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
    c.parent = this; this.kids.push(c); return c; }
  set textContent(v) { this.kids = v === "" ? [] : [new Text(v)]; }
  get textContent() { return this.kids.map((k) => k.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener() {}
  getContext() { return null; }
  closest(sel) { let n = this; while (n) { if (n.tagName === sel) return n; n = n.parent; } return null; }
  querySelector(sel) { const want = sel.split(" ").pop().replace(".", ""); const walk = (n) => { for (const k of n.kids || []) {
      if (k.nodeType === 1 && String(k.className).split(" ").indexOf(want) >= 0) return k; const r = walk(k); if (r) return r; } return null; };
    return walk(this); }
}
const ids = {};
const PANELS = ["pulse", "releases", "board", "agents", "work", "compare", "health", "okrs", "roi", "queue"];
for (const p of PANELS) {
  const sec = new El("section"), ph = new El("div"), chip = new El("span"), asof = new El("span"), body = new El("div");
  ph.className = "ph"; chip.className = "chip"; asof.className = "asof";
  ph.appendChild(chip); ph.appendChild(asof); sec.appendChild(ph); sec.appendChild(body); ids["p-" + p] = body;
}
for (const id of ["kpi", "dhead", "dbody", "drawer", "backdrop", "fail", "live", "livetxt", "tip"]) ids[id] = new El("div");
const warns = [];
const document = { createElement: (t) => new El(t), createElementNS: (_ns, t) => new El(t), createTextNode: (s) => new Text(s),
  getElementById: (id) => ids[id] || null, documentElement: new El("html"), body: new El("body"), hidden: true, addEventListener() {} };
const window = { __COCKPIT_TEST: 1, console: { warn: (...a) => warns.push(a.map(String).join(" ")), log() {}, error() {} },
  matchMedia: () => ({ matches: true }), requestAnimationFrame: () => 0, innerWidth: 1600, innerHeight: 1000 };
const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, setInterval, clearInterval });
vm.runInContext(m[1], ctx, { filename: "cockpit-main.js" });
const C = window.__cockpit;
const fails = [];
const txt = (id) => ids[id].textContent;
function step(label, fn, opts) {
  opts = opts || {};
  try { fn(); } catch (e) { fails.push(label + ": threw " + e.message); return; }
  for (const p of PANELS) {
    if (opts.panels === false) break;
    const t = txt("p-" + p);
    if (!t.trim()) fails.push(label + ": panel " + p + " rendered empty");
    if (opts.clean && t.indexOf("render error") >= 0) fails.push(label + ": " + t.slice(t.indexOf("render error"), t.indexOf("render error") + 160));
  }
}
const ex = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const mem = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
step("render(null)", () => C.render(null));
step("render(undefined)", () => C.render(undefined));
step("render({panels:{}})", () => C.render({ panels: {} }));
step("render(garbage)", () => C.render({ panels: { pulse: 5, releases: { status: "OK", data: { timeline: [null, 1, "x", { ci: 7 }] } },
  board: { status: "OK", data: { counts: "x", active: 5, freshness: null } }, agents: { status: "OK", data: { seats: [null, { slug: null }, 3] } },
  work: { status: "OK", data: "str" }, compare: [], health: { data: { usage_cap: 1 } }, okrs: { data: { items: [null] } }, roi: null, queue: { data: { last: [null] } } } }));
step("render(fixture snapshot)", () => { const n = C.render(ex); if (n !== 10) fails.push("fixture snapshot: " + n + " of 10 panels rendered"); }, { clean: true });
if (!txt("kpi").trim()) fails.push("KPI strip empty on the fixture snapshot");
const memStep = (label, p, needClean) => { try { C.renderMember(p, null); } catch (e) { fails.push(label + ": threw " + e.message); return; }
  const t = txt("dbody"); if (!t.trim()) fails.push(label + ": drawer body empty");
  if (needClean && t.indexOf("render error") >= 0) fails.push(label + ": " + t.slice(t.indexOf("render error"), t.indexOf("render error") + 160)); };
memStep("renderMember(null)", null);
memStep("renderMember({})", {});
memStep("renderMember({data:garbage})", { status: "OK", data: { history: { ticks: [null, 4] }, last_tick: { actions: "x", evidence: 5 }, slices: { rows: [null] } } });
memStep("renderMember(member.json)", mem, true);
const realBoard = C.R.board;
C.R.board = function () { throw new Error("boom"); };
step("isolation", () => { const n = C.render(ex); if (n !== 9) fails.push("isolation: " + n + " panels ok, want 9"); });
if (txt("p-board").indexOf("render error in board: boom") < 0) fails.push("isolation: board does not show its render error");
if (txt("p-releases").indexOf("render error") >= 0) fails.push("isolation: releases caught the board error");
C.R.board = realBoard;
window.location = { hash: "#member/%E0%A4%A" };
try { C.route(); } catch (e) { fails.push("route(malformed #member hash): threw " + e.message); }
delete window.location;
let disposed = 0;
class G { constructor(a, b) { this.children = []; this.position = { x: 0, y: 0, z: 0, set() {} }; this.rotation = { x: 0, y: 0, z: 0 };
    if (a && a.__geo) this.geometry = a; if (b && b.__mat) this.material = b; }
  add(c) { this.children.push(c); } traverse(f) { f(this); this.children.forEach((c) => c.traverse && c.traverse(f)); }
  lookAt() {} clone() { return this; } lerp() { return this; } getHex() { return 0; } dispose() { disposed++; } }
class Geo extends G { constructor() { super(); this.__geo = 1; } }
class Mat extends G { constructor() { super(); this.__mat = 1; } }
C.AV.three = new Proxy({}, { get: (_t, k) => typeof k !== "string" ? undefined : (k.endsWith("Geometry") ? Geo : (k.endsWith("Material") ? Mat : G)) });
try {
  const a = C.sceneFor("cto", "active"), b = C.sceneFor("cto", "active");
  if (a !== b) fails.push("sceneFor: same seat and mood rebuilt the scene instead of reusing it");
  if (disposed !== 0) fails.push("sceneFor: disposed " + disposed + " before any mood change");
  C.sceneFor("cto", "idle");
  if (disposed === 0) fails.push("sceneFor: mood change leaked the old scene (nothing disposed)");
} catch (e) { fails.push("sceneFor: threw " + e.message); }
C.AV.three = null;
console.log(fails.length ? fails.slice(0, 6).join(" | ") : "ok");
JSEOF
if command -v node >/dev/null 2>&1; then
    check "page script survives null, empty, garbage, fixture and member inputs; a panel error stays in its panel" "ok" \
        "$(node "$FIX/shim.js" "$REPO_ROOT/tools/cockpit/index.html" "$FIX/ex.json" "$FIX/member.json" 2>&1)"
    python3 "$FIX/mutate.py" "$REPO_ROOT/tools/cockpit/index.html" "$FIX/index-nonode.html" 'if(!isNode(c))c=document.createTextNode(String(c));' ''
    if [ "$(node "$FIX/shim.js" "$FIX/index-nonode.html" "$FIX/ex.json" "$FIX/member.json" 2>&1)" != "ok" ]; then
        ok "mutant page (text-node conversion removed) is caught by the fake DOM"
    else
        bad "fake DOM missed the removed text-node conversion"
    fi
    python3 "$FIX/mutate.py" "$REPO_ROOT/tools/cockpit/index.html" "$FIX/index-noiso.html" \
        '}catch(e){clear(sh.body);add(sh.body,h("div",{"class":"err"},"render error in "+name' '}catch(e){throw e;add(sh.body,h("div",{"class":"err"},"render error in "+name'
    if [ "$(node "$FIX/shim.js" "$FIX/index-noiso.html" "$FIX/ex.json" "$FIX/member.json" 2>&1)" != "ok" ]; then
        ok "mutant page (per-panel isolation removed) is caught"
    else
        bad "fake DOM missed the removed per-panel isolation"
    fi
    python3 "$FIX/mutate.py" "$REPO_ROOT/tools/cockpit/index.html" "$FIX/index-nolist.html" 'function list(title,items,mono){items=arr(items);' 'function list(title,items,mono){items=items||[];'
    if [ "$(node "$FIX/shim.js" "$FIX/index-nolist.html" "$FIX/ex.json" "$FIX/member.json" 2>&1)" != "ok" ]; then
        ok "mutant page (scalar seat list fed to .map) is caught by the member render"
    else
        bad "fake DOM missed a scalar evidence field breaking the member drawer"
    fi
    python3 "$FIX/mutate.py" "$REPO_ROOT/tools/cockpit/index.html" "$FIX/index-nodecode.html" \
        '{var sl=null;try{sl=decodeURIComponent(hs.slice(8));}catch(e){sl=null;}if(sl)loadMember(sl);else if(openSlug)closeMember();}' 'loadMember(decodeURIComponent(hs.slice(8)));'
    if node "$FIX/shim.js" "$FIX/index-nodecode.html" "$FIX/ex.json" "$FIX/member.json" 2>&1 | grep -q 'route(malformed #member hash): threw'; then
        ok "mutant page (unguarded decodeURIComponent) is caught"
    else
        bad "shim missed the unguarded decodeURIComponent"
    fi
    python3 "$FIX/mutate.py" "$REPO_ROOT/tools/cockpit/index.html" "$FIX/index-nodispose.html" 'if(c)disposeScene(c);' ''
    if node "$FIX/shim.js" "$FIX/index-nodispose.html" "$FIX/ex.json" "$FIX/member.json" 2>&1 | grep -q 'leaked the old scene'; then
        ok "mutant page (old scene not disposed) is caught"
    else
        bad "shim missed the scene leak"
    fi
else
    echo "SKIP: node not found; the client null-safety shim did not run (NOT a pass)"
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
