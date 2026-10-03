# shellcheck shell=bash
# D51-B16r: end-to-end through the real CLI routes (autonomy/loki and bin/loki).
# Sourced by tests/test-workspace.sh, which provides ok() and bad() and REPO_ROOT.

_ws99_tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-ws99.XXXXXX")"

_ws99_repo() {
    mkdir -p "$1" && git -C "$1" init -q &&
        git -C "$1" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
}
_ws99_repo "$_ws99_tmp/lib"
_ws99_repo "$_ws99_tmp/app"
mkdir -p "$_ws99_tmp/proj" "$_ws99_tmp/bin"
cat > "$_ws99_tmp/proj/loki.yaml" <<YAML
workspaces:
  e2e:
    repos:
      - {repo: acme/lib, path: $_ws99_tmp/lib}
      - {repo: acme/app, path: $_ws99_tmp/app, after: [acme/lib]}
    integration: {command: "true", timeout_s: 30}
YAML
printf '#!/bin/sh\nexit 0\n' > "$_ws99_tmp/launcher.sh"
cat > "$_ws99_tmp/bin/gh" <<'SH'
#!/bin/sh
case "$1 $2" in
"pr list") echo 7 ;;
"pr comment")
    n=$(ls "$STUB_DIR"/comment.* 2>/dev/null | wc -l | tr -d ' ')
    while [ $# -gt 0 ]; do
        [ "$1" = "--body-file" ] && cat "$2" > "$STUB_DIR/comment.$n"
        shift
    done ;;
esac
exit 0
SH
chmod +x "$_ws99_tmp/launcher.sh" "$_ws99_tmp/bin/gh"

_ws99_cli() { # entrypoint, then loki args; runs in the project dir
    local entry="$1"
    shift
    (cd "$_ws99_tmp/proj" && env -u LOKI_WORKSPACES PATH="$_ws99_tmp/bin:$PATH" STUB_DIR="$_ws99_tmp/stub" \
        GH_TOKEN=unused LOKI_NO_BROWSER=1 LOKI_WORKSPACE_LAUNCHER="$_ws99_tmp/launcher.sh" \
        timeout -k 5 120 bash "$entry" "$@" 2>&1)
}

for _ws99_entry in "$REPO_ROOT/autonomy/loki" "$REPO_ROOT/bin/loki"; do
    _ws99_name="${_ws99_entry#"$REPO_ROOT"/}"
    rm -rf "$_ws99_tmp/stub" "$_ws99_tmp/proj/.loki"
    mkdir -p "$_ws99_tmp/stub"

    _ws99_out="$(_ws99_cli "$_ws99_entry" workspace run e2e acme/lib#1)"
    _ws99_rc=$?
    _ws99_json="$(find "$_ws99_tmp/proj/.loki/workspaces/e2e" -name integration.json 2>/dev/null | head -1)"
    if [ "$_ws99_rc" -eq 0 ] && [ -n "$_ws99_json" ] &&
        python3 -c "import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get('status')=='passed' else 1)" "$_ws99_json"; then
        ok "workspace e2e ($_ws99_name): run exits 0 and integration status is passed"
    else
        bad "workspace e2e ($_ws99_name): run rc=$_ws99_rc json=${_ws99_json:-none}: $_ws99_out"
    fi

    _ws99_status="$(_ws99_cli "$_ws99_entry" workspace status)"
    _ws99_src=$?
    if [ "$_ws99_src" -eq 0 ] && printf '%s' "$_ws99_status" | grep -q "acme/lib" &&
        printf '%s' "$_ws99_status" | grep -q "acme/app"; then
        ok "workspace e2e ($_ws99_name): status prints a row per repo"
    else
        bad "workspace e2e ($_ws99_name): status rc=$_ws99_src: $_ws99_status"
    fi

    if [ -n "$_ws99_json" ]; then
        _ws99_met="$(timeout -k 5 60 python3 "$REPO_ROOT/autonomy/lib/workspace_metrics.py" "$(dirname "$_ws99_json")" --attention-min 30 2>&1)"
    else
        _ws99_met=""
    fi
    if printf '%s\n' "$_ws99_met" | grep -q '^prs: 2$' && printf '%s\n' "$_ws99_met" | grep -q '^prs_per_hour: [0-9]'; then
        ok "workspace e2e ($_ws99_name): metrics reports 2 PRs and a measured rate"
    else
        bad "workspace e2e ($_ws99_name): metrics output: $_ws99_met"
    fi

    _ws99_n="$(find "$_ws99_tmp/stub" -name 'comment.*' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$_ws99_n" = 2 ]; then
        ok "workspace e2e ($_ws99_name): exactly one comment per PR"
    else
        bad "workspace e2e ($_ws99_name): comments=$_ws99_n"
    fi

    (cd "$_ws99_tmp/proj" && LOKI_WORKSPACES=0 timeout -k 5 60 bash "$_ws99_entry" workspace list >/dev/null 2>&1)
    _ws99_rc=$?
    if [ "$_ws99_rc" -eq 2 ]; then
        ok "workspace e2e ($_ws99_name): LOKI_WORKSPACES=0 exits 2"
    else
        bad "workspace e2e ($_ws99_name): disabled rc=$_ws99_rc"
    fi
done

if grep -q '^## Verify a workspace run' "$REPO_ROOT/docs/WORKSPACES.md"; then
    ok "workspace e2e: docs/WORKSPACES.md has the verify section"
else
    bad "workspace e2e: docs/WORKSPACES.md lacks the verify section"
fi

rm -rf -- "$_ws99_tmp"
unset _ws99_tmp _ws99_entry _ws99_name _ws99_out _ws99_rc _ws99_json _ws99_status _ws99_src _ws99_met _ws99_n
