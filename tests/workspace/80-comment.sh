# shellcheck shell=bash
# D51-B11: integration result posted as one PR comment per repo PR.
# Sourced by tests/test-workspace.sh, which provides ok() and bad() and REPO_ROOT.

_ws80_tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-ws80.XXXXXX")"
_ws80_py="$REPO_ROOT/autonomy/lib/workspace.py"
_ws80_tok="ghp_FAKEtokenVALUE0123456789abcdefABCDEF"

_ws80_repo() {
    mkdir -p "$1" && git -C "$1" init -q &&
        git -C "$1" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
}
_ws80_repo "$_ws80_tmp/api"
_ws80_repo "$_ws80_tmp/web"
mkdir -p "$_ws80_tmp/proj" "$_ws80_tmp/bin"
_ws80_cfg() { # integration command, timeout
    cat > "$_ws80_tmp/proj/loki.yaml" <<YAML
workspaces:
  cm:
    repos:
      - {repo: acme/api, path: $_ws80_tmp/api}
      - {repo: acme/web, path: $_ws80_tmp/web}
    integration: {command: "$1", timeout_s: ${2:-30}}
YAML
}
printf '#!/bin/sh\nexit 0\n' > "$_ws80_tmp/ok.sh"
cat > "$_ws80_tmp/bin/gh" <<'SH'
#!/bin/sh
# Stub gh: records argv, answers pr list with PR 7 unless STUB_NOPR is set.
printf '%s\n' "$*" >> "$STUB_DIR/argv.log"
[ -n "${GH_TOKEN:-}" ] || echo "no-token-in-env" >> "$STUB_DIR/argv.log"
case "$1 $2" in
"pr list") [ -n "${STUB_NOPR:-}" ] || echo 7 ;;
"pr comment")
    n=$(ls "$STUB_DIR"/comment.* 2>/dev/null | wc -l | tr -d ' ')
    while [ $# -gt 0 ]; do
        [ "$1" = "--body-file" ] && cat "$2" > "$STUB_DIR/comment.$n"
        shift
    done ;;
esac
exit 0
SH
chmod +x "$_ws80_tmp/ok.sh" "$_ws80_tmp/bin/gh"

_ws80_run() { # env assignments...; fresh stub dir and run dir per call
    rm -rf "$_ws80_tmp/stub" "$_ws80_tmp/proj/.loki"
    mkdir -p "$_ws80_tmp/stub"
    (cd "$_ws80_tmp/proj" && env -u LOKI_WORKSPACES "$@" PATH="$_ws80_tmp/bin:$PATH" STUB_DIR="$_ws80_tmp/stub" \
        GH_TOKEN="$_ws80_tok" LOKI_NO_BROWSER=1 LOKI_WORKSPACE_LAUNCHER="$_ws80_tmp/ok.sh" \
        timeout -k 5 120 python3 "$_ws80_py" run cm acme/api#1 2>&1)
}
_ws80_count() { find "$_ws80_tmp/stub" -name 'comment.*' 2>/dev/null | wc -l | tr -d ' '; }

_ws80_cfg "true"
_ws80_out="$(_ws80_run X=1)"
_ws80_rc=$?
_ws80_n="$(_ws80_count)"
_ws80_sha="$(git -C "$_ws80_tmp/api" rev-parse HEAD)"
_ws80_posts="$(grep -c '^pr comment' "$_ws80_tmp/stub/argv.log" 2>/dev/null)"
if [ "$_ws80_rc" -eq 0 ] && [ "$_ws80_n" = 2 ] && [ "$_ws80_posts" = 2 ] &&
    grep -q "PASSED" "$_ws80_tmp/stub/comment.0" && grep -q "$_ws80_sha" "$_ws80_tmp/stub/comment.0"; then
    ok "workspace comment: exactly one comment per PR with status and SHAs"
else
    bad "workspace comment: one comment per PR (rc=$_ws80_rc comments=$_ws80_n posts=$_ws80_posts)"
fi

_ws80_leak="$(grep -rl -- "$_ws80_tok" "$_ws80_tmp/proj/.loki" "$_ws80_tmp/stub" 2>/dev/null | head -1)"
if [ -f "$_ws80_tmp/stub/argv.log" ] && [ -z "$_ws80_leak" ] && ! printf '%s' "$_ws80_out" | grep -q -- "$_ws80_tok" &&
    ! grep -q "no-token-in-env" "$_ws80_tmp/stub/argv.log"; then
    ok "workspace comment: GH_TOKEN reaches gh by env only, in no log and no argv"
else
    bad "workspace comment: token leaked or not passed by env ($_ws80_leak)"
fi

_ws80_cfg "false"
_ws80_run X=1 >/dev/null
if [ "$(_ws80_count)" = 2 ] && grep -q "FAILED" "$_ws80_tmp/stub/comment.0" &&
    ! grep -qi "PASSED" "$_ws80_tmp/stub/comment.0"; then
    ok "workspace comment: failed integration never rendered as passed"
else
    bad "workspace comment: failed integration rendering"
fi

_ws80_cfg "sleep 30" 1
_ws80_run X=1 >/dev/null
if [ "$(_ws80_count)" = 2 ] && grep -q "TIMEOUT" "$_ws80_tmp/stub/comment.0" &&
    ! grep -qi "PASSED" "$_ws80_tmp/stub/comment.0"; then
    ok "workspace comment: timeout never rendered as passed"
else
    bad "workspace comment: timeout rendering"
fi

_ws80_cfg "true"
_ws80_out="$(_ws80_run STUB_NOPR=1)"
_ws80_rc=$?
if [ "$_ws80_rc" -eq 0 ] && [ "$(_ws80_count)" = 0 ]; then
    ok "workspace comment: no PR for the run branch skips silently"
else
    bad "workspace comment: no-PR skip (rc=$_ws80_rc)"
fi

_ws80_run LOKI_WORKSPACE_COMMENT=1 >/dev/null
_ws80_on="$(_ws80_count)"
_ws80_leftover="$(find "$_ws80_tmp/proj/.loki" -name 'comment-*.md' | wc -l | tr -d ' ')"
if [ "$_ws80_on" = 2 ] && [ "$_ws80_leftover" = 0 ]; then
    ok "workspace comment: opt-out unset comments, and no comment-*.md body file remains"
else
    bad "workspace comment: unset opt-out (comments=$_ws80_on leftover=$_ws80_leftover)"
fi

_ws80_run LOKI_WORKSPACE_COMMENT=0 >/dev/null
if [ ! -f "$_ws80_tmp/stub/argv.log" ] && [ "$_ws80_on" = 2 ]; then
    ok "workspace comment: LOKI_WORKSPACE_COMMENT=0 never calls gh"
else
    bad "workspace comment: opt-out still called gh"
fi

printf '#!/bin/sh\nexit 1\n' > "$_ws80_tmp/bin/gh"
_ws80_out="$(_ws80_run X=1)"
_ws80_rc=$?
if [ "$_ws80_rc" -eq 0 ]; then
    ok "workspace comment: gh failure does not fail the run"
else
    bad "workspace comment: gh failure changed exit code (rc=$_ws80_rc)"
fi

rm -rf -- "$_ws80_tmp"
unset _ws80_tmp _ws80_py _ws80_tok _ws80_out _ws80_rc _ws80_n _ws80_sha _ws80_posts _ws80_leak _ws80_on _ws80_leftover
