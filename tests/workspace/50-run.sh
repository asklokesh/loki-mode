# shellcheck shell=bash
# C8 workspaces: parallel runs, budget exit 3, status/show, default-on flag.
# Sourced by tests/test-workspace.sh, which provides ok() and bad() and REPO_ROOT.

_ws50_tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-ws50.XXXXXX")"
_ws50_py="$REPO_ROOT/autonomy/lib/workspace.py"

_ws50_repo() {
    mkdir -p "$1" && git -C "$1" init -q &&
        git -C "$1" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
}
_ws50_repo "$_ws50_tmp/api"
_ws50_repo "$_ws50_tmp/web"
mkdir -p "$_ws50_tmp/proj"
cat > "$_ws50_tmp/proj/loki.yaml" <<YAML
workspaces:
  par:
    repos:
      - {repo: acme/api, path: $_ws50_tmp/api}
      - {repo: acme/web, path: $_ws50_tmp/web}
  dep:
    repos:
      - {repo: acme/api, path: $_ws50_tmp/api}
      - {repo: acme/web, path: $_ws50_tmp/web, after: [acme/api]}
YAML
cat > "$_ws50_tmp/stamp.sh" <<'SH'
#!/bin/sh
python3 -c "import time;print(time.time())" > start.txt
sleep 1
python3 -c "import time;print(time.time())" > end.txt
exit 0
SH
cat > "$_ws50_tmp/exit3.sh" <<'SH'
#!/bin/sh
exit 3
SH
chmod +x "$_ws50_tmp/stamp.sh" "$_ws50_tmp/exit3.sh"

_ws50_run() { # launcher workspace -> prints output, returns rc
    (cd "$_ws50_tmp/proj" && env -u LOKI_WORKSPACES LOKI_NO_BROWSER=1 \
        LOKI_WORKSPACE_LAUNCHER="$1" python3 "$_ws50_py" run "$2" acme/api#1 2>&1)
}

_ws50_out="$(_ws50_run "$_ws50_tmp/stamp.sh" par)"
_ws50_rc=$?
_ws50_dir="$(find "$_ws50_tmp/proj/.loki/workspaces/par" -mindepth 1 -maxdepth 1 -type d | head -1)"
_ws50_a="$(cat "$_ws50_dir/worktrees/acme__api/start.txt" 2>/dev/null)"
_ws50_ae="$(cat "$_ws50_dir/worktrees/acme__api/end.txt" 2>/dev/null)"
_ws50_w="$(cat "$_ws50_dir/worktrees/acme__web/start.txt" 2>/dev/null)"
if [ "$_ws50_rc" -eq 0 ] && [ -n "$_ws50_a" ] && [ -n "$_ws50_w" ] &&
    python3 -c "import sys;a,ae,w=map(float,sys.argv[1:]);sys.exit(0 if w<ae else 1)" "$_ws50_a" "$_ws50_ae" "$_ws50_w"; then
    ok "workspace: independent repos overlap in time (flag unset, default on)"
else
    bad "workspace: independent repos overlap in time (rc=$_ws50_rc)"
fi

_ws50_out="$(_ws50_run "$_ws50_tmp/exit3.sh" dep)"
_ws50_rc=$?
if [ "$_ws50_rc" -eq 3 ] && printf '%s' "$_ws50_out" | grep -q "SKIPPED"; then
    ok "workspace: child exit 3 gives group exit 3, dependent SKIPPED"
else
    bad "workspace: budget stops give exit 3 (rc=$_ws50_rc)"
fi

_ws50_out="$(cd "$_ws50_tmp/proj" && env -u LOKI_WORKSPACES python3 "$_ws50_py" status 2>&1)"
_ws50_rc=$?
if [ "$_ws50_rc" -eq 0 ] && printf '%s' "$_ws50_out" | grep -q "acme/api" && printf '%s' "$_ws50_out" | grep -q "acme/web"; then
    ok "workspace: status prints per-repo rows"
else
    bad "workspace: status prints per-repo rows (rc=$_ws50_rc)"
fi

_ws50_out="$(cd "$_ws50_tmp/proj" && env -u LOKI_WORKSPACES python3 "$_ws50_py" show dep 2>&1)"
_ws50_rc=$?
if [ "$_ws50_rc" -eq 0 ] && printf '%s' "$_ws50_out" | grep -q "after: acme/api"; then
    ok "workspace: show lists repos and after edges"
else
    bad "workspace: show lists repos and after edges (rc=$_ws50_rc)"
fi

(cd "$_ws50_tmp/proj" && LOKI_WORKSPACES=0 python3 "$_ws50_py" list >/dev/null 2>&1)
_ws50_rc=$?
if [ "$_ws50_rc" -eq 2 ]; then
    ok "workspace: LOKI_WORKSPACES=0 exits 2"
else
    bad "workspace: LOKI_WORKSPACES=0 exits 2 (rc=$_ws50_rc)"
fi

rm -rf -- "$_ws50_tmp"
unset _ws50_tmp _ws50_py _ws50_out _ws50_rc _ws50_dir _ws50_a _ws50_ae _ws50_w
