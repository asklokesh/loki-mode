# shellcheck shell=bash
# D51-B15: 10x metric, PRs per wall-clock hour and per attention minute.
# Sourced by tests/test-workspace.sh, which provides ok() and bad() and REPO_ROOT.

_ws95_tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-ws95.XXXXXX")"
_ws95_met="$REPO_ROOT/autonomy/lib/workspace_metrics.py"
_ws95_py="$REPO_ROOT/autonomy/lib/workspace.py"

# Hand-computed: two ok repos, first starts at t=1000, last ends at t=4600,
# so wall clock is 3600s = 1h and the rate is 2.00 PRs/hour; 30 attention
# minutes gives 2/30 = 0.0667 PRs per attention minute.
cat > "$_ws95_tmp/timed.json" <<'JSON'
{"status": "passed", "outcomes": {"a/api": "ok", "a/web": "ok"},
 "timing": {"a/api": {"started_at": 1000, "finished_at": 2800},
            "a/web": {"started_at": 1000, "finished_at": 4600}}}
JSON
# An old run: no timing key at all.
cat > "$_ws95_tmp/old.json" <<'JSON'
{"status": "passed", "outcomes": {"a/api": "ok", "a/web": "ok"}}
JSON
# A failed repo is not a PR and must not inflate the count.
cat > "$_ws95_tmp/mixed.json" <<'JSON'
{"outcomes": {"a/api": "ok", "a/web": "FAILED: exit 1"},
 "timing": {"a/api": {"started_at": 0, "finished_at": 3600},
            "a/web": {"started_at": 0, "finished_at": 100}}}
JSON

_ws95_run() { timeout -k 5 60 python3 "$_ws95_met" "$@" 2>&1; }
_ws95_has() { printf '%s\n' "$1" | grep -qx "$2"; }

_ws95_out="$(_ws95_run "$_ws95_tmp/timed.json" --attention-min 30)"
if _ws95_has "$_ws95_out" 'prs_per_hour: 2.00' && _ws95_has "$_ws95_out" 'prs_per_attention_minute: 0.0667'; then
    ok "B15 fixture run gives the hand-computed rates"
else
    bad "B15 fixture rates wrong: $_ws95_out"
fi

_ws95_out="$(_ws95_run "$_ws95_tmp/timed.json")"
if _ws95_has "$_ws95_out" 'prs_per_hour: 2.00' && _ws95_has "$_ws95_out" 'prs_per_attention_minute: unmeasured'; then
    ok "B15 attention minutes not supplied is unmeasured, not zero"
else
    bad "B15 missing attention not unmeasured: $_ws95_out"
fi

_ws95_out="$(_ws95_run "$_ws95_tmp/old.json" --attention-min 30)"
if _ws95_has "$_ws95_out" 'prs_per_hour: unmeasured' && _ws95_has "$_ws95_out" 'prs_per_attention_minute: unmeasured' &&
    ! printf '%s\n' "$_ws95_out" | grep -Eq ': 0(\.0+)?$'; then
    ok "B15 old integration.json without timestamps is unmeasured, never zero"
else
    bad "B15 old run not unmeasured: $_ws95_out"
fi

_ws95_out="$(_ws95_run "$_ws95_tmp/mixed.json")"
if _ws95_has "$_ws95_out" 'prs: 1' && _ws95_has "$_ws95_out" 'prs_per_hour: 1.00'; then
    ok "B15 only ok repos count as PRs"
else
    bad "B15 mixed outcome count wrong: $_ws95_out"
fi

# End to end: a real run records started_at and finished_at per repo.
mkdir -p "$_ws95_tmp/api" "$_ws95_tmp/proj"
git -C "$_ws95_tmp/api" init -q
git -C "$_ws95_tmp/api" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
cat > "$_ws95_tmp/proj/loki.yaml" <<YAML
workspaces:
  m:
    repos:
      - {repo: acme/api, path: $_ws95_tmp/api}
YAML
printf '#!/bin/sh\nexit 0\n' > "$_ws95_tmp/ok.sh"
chmod +x "$_ws95_tmp/ok.sh"
(cd "$_ws95_tmp/proj" && env -u LOKI_WORKSPACES LOKI_NO_BROWSER=1 LOKI_WORKSPACE_COMMENT=0 \
    LOKI_WORKSPACE_LAUNCHER="$_ws95_tmp/ok.sh" timeout -k 5 120 python3 "$_ws95_py" run m acme/api#1 >/dev/null 2>&1)
_ws95_ev="$(find "$_ws95_tmp/proj/.loki/workspaces" -name integration.json 2>/dev/null | head -1)"
if [ -n "$_ws95_ev" ] && python3 - "$_ws95_ev" <<'PY'
import json, sys
t = json.load(open(sys.argv[1]))["timing"]["acme/api"]
sys.exit(0 if 0 < t["started_at"] <= t["finished_at"] else 1)
PY
then
    ok "B15 run records started_at and finished_at per repo in integration.json"
else
    bad "B15 integration.json has no per-repo timing"
fi

rm -rf "$_ws95_tmp"
