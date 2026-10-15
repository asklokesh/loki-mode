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

# PLANNER: per-repo plan, composite seal, tamper check. Stub launcher only; no provider, no network.
_ws99_tasks="$_ws99_tmp/tasks"
mkdir -p "$_ws99_tasks"
cat > "$_ws99_tmp/receipt.ts" <<TS
import { receiptSha256, signReceipt } from "$REPO_ROOT/loki-ts/src/engine10/stages/seal.ts";
import { mkdirSync, writeFileSync } from "node:fs";
const [dir, head, id] = process.argv.slice(2);
const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", head_sha: head, events_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", not_proven: [] };
const h = receiptSha256(body as never);
mkdirSync(dir + "/.loki/runs/" + id, { recursive: true });
writeFileSync(dir + "/.loki/runs/" + id + "/events.jsonl", "");
writeFileSync(dir + "/.loki/runs/" + id + "/receipt.json", JSON.stringify({ ...body, receipt_sha256: h, verification: signReceipt(id, h) }, null, 2) + "\n");
TS
cat > "$_ws99_tmp/plan-launcher.sh" <<SH
#!/bin/bash
if [ -n "\${LOKI_WORKSPACE_PLAN_OUT:-}" ]; then
    cp "\$PLAN_SRC" "\$LOKI_WORKSPACE_PLAN_OUT"
    exit 0
fi
printf '%s' "\${LOKI_E10_TASK_TEXT:-\$1}" > "$_ws99_tasks/\$(basename "\$PWD")"
[ "\${NO_RECEIPT_FOR:-}" = "\$(basename "\$PWD")" ] && exit 0
bun "$_ws99_tmp/receipt.ts" "\$PWD" "\$(git rev-parse HEAD)" "run-\$(basename "\$PWD")"
SH
chmod +x "$_ws99_tmp/plan-launcher.sh"
openssl genpkey -algorithm ed25519 -out "$_ws99_tmp/sign.pem" 2>/dev/null && chmod 600 "$_ws99_tmp/sign.pem"
cat > "$_ws99_tmp/proj/loki.yaml" <<YAML
workspaces:
  planned:
    plan: true
    repos:
      - {repo: acme/lib, path: $_ws99_tmp/lib}
      - {repo: acme/app, path: $_ws99_tmp/app, after: [acme/lib]}
    integration: {command: "true", timeout_s: 30}
YAML

_ws99_plan_run() { # plan source file, extra env assignment
    rm -rf "$_ws99_tmp/proj/.loki" "${_ws99_tasks:?}"/*
    (cd "$_ws99_tmp/proj" && env -u LOKI_WORKSPACES PLAN_SRC="$1" "$2" LOKI_NO_BROWSER=1 \
        LOKI_RECEIPT_SIGNING_KEY_FILE="$_ws99_tmp/sign.pem" LOKI_WORKSPACE_LAUNCHER="$_ws99_tmp/plan-launcher.sh" \
        LOKI_WORKSPACE_VERIFY="$_ws99_tmp/e10.sh" \
        timeout -k 5 200 python3 "$REPO_ROOT/autonomy/lib/workspace.py" run planned acme/lib#1 2>&1)
}
# bin/loki does not yet route `verify --seal-composite` or a composite path to engine10 (PATH slice), and dist is
# rebuilt only at train time, so the test runs engine10 verify from source through this wrapper.
printf '#!/bin/sh\nexec bun "%s/loki-ts/src/cli.ts" engine10 "$@"\n' "$REPO_ROOT" > "$_ws99_tmp/e10.sh"
chmod +x "$_ws99_tmp/e10.sh"
_ws99_verify() { LOKI_NO_BROWSER=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$_ws99_tmp/sign.pem" timeout -k 5 120 "$_ws99_tmp/e10.sh" verify "$1" 2>&1; }

echo '{"acme/lib": "Add the shared helper", "acme/app": "Use the shared helper"}' > "$_ws99_tmp/plan-ok.json"
_ws99_out="$(_ws99_plan_run "$_ws99_tmp/plan-ok.json" "X=1")"
_ws99_rc=$?
_ws99_l="$(cat "$_ws99_tasks/acme__lib" 2>/dev/null)"
_ws99_a="$(cat "$_ws99_tasks/acme__app" 2>/dev/null)"
if [ "$_ws99_rc" -eq 0 ] && [ "${_ws99_l#Add the shared helper}" != "$_ws99_l" ] && [ "${_ws99_a#Use the shared helper}" != "$_ws99_a" ]; then
    ok "workspace planner: a valid plan gives each repo its own task"
else
    bad "workspace planner: rc=$_ws99_rc lib=[$_ws99_l] app=[$_ws99_a] out=$_ws99_out"
fi
_ws99_comp="$(find "$_ws99_tmp/proj/.loki/workspaces/planned" -name composite.json 2>/dev/null | head -1)"
if [ -n "$_ws99_comp" ] && _ws99_vout="$(_ws99_verify "$_ws99_comp")"; then
    ok "workspace planner: composite sealed and engine10 verify exits 0"
else
    bad "workspace planner: composite=${_ws99_comp:-none} verify=${_ws99_vout:-} run=$_ws99_out"
fi
if [ -n "$_ws99_comp" ]; then
    _ws99_child="$(find "$(dirname "$_ws99_comp")/worktrees" -name receipt.json | head -1)"
    sed -i.bak 's/"VERIFIED"/"FAILED"/' "$_ws99_child"
    rm -f "$_ws99_child.bak"
    if _ws99_verify "$_ws99_comp" >/dev/null; then
        bad "workspace planner: tampered child still verified"
    else
        ok "workspace planner: a tampered child receipt makes verify exit non-zero"
    fi
fi

echo '{"acme/ghost": "x"}' > "$_ws99_tmp/plan-bad.json"
_ws99_out="$(_ws99_plan_run "$_ws99_tmp/plan-bad.json" "X=1")"
_ws99_l="$(cat "$_ws99_tasks/acme__app" 2>/dev/null)"
if printf '%s' "$_ws99_out" | grep -q 'plan not used (plan.json names repos outside the workspace: acme/ghost)' &&
    printf '%s' "$_ws99_l" | grep -q '^Implement the change described by'; then
    ok "workspace planner: a malformed plan falls back to the generic task with a reason"
else
    bad "workspace planner: fallback lib=[$_ws99_l] out=$_ws99_out"
fi

_ws99_out="$(_ws99_plan_run "$_ws99_tmp/plan-ok.json" "NO_RECEIPT_FOR=acme__app")"
if printf '%s' "$_ws99_out" | grep -q 'composite not sealed: acme/app has no receipt' &&
    [ -z "$(find "$_ws99_tmp/proj/.loki/workspaces/planned" -name composite.json 2>/dev/null)" ]; then
    ok "workspace planner: an unsealed child blocks the composite and names the repo"
else
    bad "workspace planner: no-receipt out=$_ws99_out"
fi

if grep -q '^## Verify a workspace run' "$REPO_ROOT/docs/WORKSPACES.md"; then
    ok "workspace e2e: docs/WORKSPACES.md has the verify section"
else
    bad "workspace e2e: docs/WORKSPACES.md lacks the verify section"
fi

rm -rf -- "$_ws99_tmp"
unset _ws99_tasks _ws99_l _ws99_a _ws99_comp _ws99_child _ws99_vout _ws99_tmp _ws99_entry _ws99_name _ws99_out _ws99_rc _ws99_json _ws99_status _ws99_src _ws99_met _ws99_n
