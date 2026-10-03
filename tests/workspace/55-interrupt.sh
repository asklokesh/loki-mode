# shellcheck shell=bash
# WS-INTERRUPT: SIGTERM records integration.json status=interrupted; status shows unreadable runs.
# Sourced by tests/test-workspace.sh, which provides ok() and bad() and REPO_ROOT.

_ws55_tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-ws55.XXXXXX")"
_ws55_py="$REPO_ROOT/autonomy/lib/workspace.py"
mkdir -p "$_ws55_tmp/api" "$_ws55_tmp/proj"
git -C "$_ws55_tmp/api" init -q &&
    git -C "$_ws55_tmp/api" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
cat > "$_ws55_tmp/proj/loki.yaml" <<YAML
workspaces:
  intr:
    repos:
      - {repo: acme/api, path: $_ws55_tmp/api}
YAML
cat > "$_ws55_tmp/sleeper.sh" <<'SH'
#!/bin/sh
sleep 30
SH
chmod +x "$_ws55_tmp/sleeper.sh"

(cd "$_ws55_tmp/proj" && exec env -u LOKI_WORKSPACES LOKI_NO_BROWSER=1 \
    LOKI_WORKSPACE_LAUNCHER="$_ws55_tmp/sleeper.sh" python3 "$_ws55_py" run intr acme/api#1 \
    > "$_ws55_tmp/run.out" 2>&1) &
_ws55_pid=$!
_ws55_i=0
while [ "$_ws55_i" -lt 150 ] && ! grep -q "acme/api running" "$_ws55_tmp/run.out" 2>/dev/null; do
    sleep 0.1
    _ws55_i=$((_ws55_i + 1))
done
kill -TERM "$_ws55_pid" 2>/dev/null
wait "$_ws55_pid"
_ws55_rc=$?
_ws55_json="$(find "$_ws55_tmp/proj/.loki/workspaces/intr" -name integration.json 2>/dev/null | head -1)"
if [ "$_ws55_rc" -eq 130 ] && [ -n "$_ws55_json" ] &&
    python3 -c "import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get('status')=='interrupted' and 'INTERRUPTED' in d['outcomes']['acme/api'] else 1)" "$_ws55_json"; then
    ok "workspace: SIGTERM writes integration.json status=interrupted, exit 130"
else
    bad "workspace: SIGTERM writes integration.json status=interrupted (rc=$_ws55_rc file=${_ws55_json:-none})"
fi

_ws55_out="$(cd "$_ws55_tmp/proj" && env -u LOKI_WORKSPACES python3 "$_ws55_py" status 2>&1)"
if printf '%s' "$_ws55_out" | grep -q "interrupted"; then
    ok "workspace: status shows the interrupted run"
else
    bad "workspace: status shows the interrupted run"
fi

_ws55_bad="$_ws55_tmp/proj/.loki/workspaces/intr/19990101T000000Z"
mkdir -p "$_ws55_bad"
printf '{not json' > "$_ws55_bad/integration.json"
_ws55_out="$(cd "$_ws55_tmp/proj" && env -u LOKI_WORKSPACES python3 "$_ws55_py" status 2>&1)"
if printf '%s' "$_ws55_out" | grep -q "19990101T000000Z" && printf '%s' "$_ws55_out" | grep -q "unreadable"; then
    ok "workspace: status lists an unreadable run as unreadable"
else
    bad "workspace: status lists an unreadable run as unreadable"
fi
rm -rf "$_ws55_tmp"
