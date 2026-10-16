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
        python3 -c "import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get('status')=='passed' and d.get('exit_code') is not None and d.get('heads') and 'seal' not in d and 'note' not in d else 1)" "$_ws99_json"; then
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
const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", head_sha: head, events_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", time: { wall_s: 0, stages: {} }, not_proven: [] };
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
# The planner cases pin the verifier to engine10 source through this wrapper; the PATH cases below use the real bin/loki route.
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
if grep -q 'plan not used (plan.json names repos outside the workspace: acme/ghost)' <<<"$_ws99_out" &&
    grep -q '^Implement the change described by' <<<"$_ws99_l"; then
    ok "workspace planner: a malformed plan falls back to the generic task with a reason"
else
    bad "workspace planner: fallback lib=[$_ws99_l] out=$_ws99_out"
fi

_ws99_out="$(_ws99_plan_run "$_ws99_tmp/plan-ok.json" "NO_RECEIPT_FOR=acme__app")"
if grep -q 'composite not sealed: acme/app has no receipt' <<<"$_ws99_out" &&
    [ -z "$(find "$_ws99_tmp/proj/.loki/workspaces/planned" -name composite.json 2>/dev/null)" ]; then
    ok "workspace planner: an unsealed child blocks the composite and names the repo"
else
    bad "workspace planner: no-receipt out=$_ws99_out"
fi

# PATH: the primary path reaches the workspace runner, the composite verifier and the chat REPL.
# `loki start --workspace` (through bin/loki) runs the planned workspace and seals the composite with the real bin/loki verify
# route; `loki verify <composite.json>` then re-checks it offline with no wrapper.
_ws99_path_run() {
    rm -rf "$_ws99_tmp/proj/.loki" "${_ws99_tasks:?}"/*
    (cd "$_ws99_tmp/proj" && env -u LOKI_WORKSPACES PLAN_SRC="$_ws99_tmp/plan-ok.json" LOKI_NO_BROWSER=1 \
        LOKI_RECEIPT_SIGNING_KEY_FILE="$_ws99_tmp/sign.pem" LOKI_WORKSPACE_LAUNCHER="$_ws99_tmp/plan-launcher.sh" \
        timeout -k 5 200 bash "$REPO_ROOT/bin/loki" start --workspace planned "$@" 2>&1)
}

_ws99_out="$(_ws99_path_run acme/lib#1)"
_ws99_rc=$?
_ws99_comp="$(find "$_ws99_tmp/proj/.loki/workspaces/planned" -name composite.json 2>/dev/null | head -1)"
_ws99_l="$(cat "$_ws99_tasks/acme__lib" 2>/dev/null)"
if [ "$_ws99_rc" -eq 0 ] && [ -n "$_ws99_comp" ] && [ "${_ws99_l#Add the shared helper}" != "$_ws99_l" ]; then
    ok "start --workspace: runs the workspace (per-repo task) and seals a composite"
else
    bad "start --workspace: rc=$_ws99_rc composite=${_ws99_comp:-none} lib=[$_ws99_l] out=$_ws99_out"
fi
if [ -n "$_ws99_comp" ] &&
    (cd "$_ws99_tmp/proj" && LOKI_NO_BROWSER=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$_ws99_tmp/sign.pem" timeout -k 5 120 bash "$REPO_ROOT/bin/loki" verify "$_ws99_comp" >/dev/null 2>&1); then
    ok "loki verify <composite.json>: routes to the engine10 verifier and exits 0"
else
    bad "loki verify <composite.json>: composite=${_ws99_comp:-none} did not verify through bin/loki"
fi
# Value flags and --brief never leak into or vanish from the brief: the issue ref must arrive intact.
for _ws99_variant in "--isolation worktree acme/lib#1" "--model sonnet --max-cost 1 acme/lib#1" "--brief acme/lib#1"; do
    # shellcheck disable=SC2086
    _ws99_out="$(_ws99_path_run $_ws99_variant)"
    _ws99_rc=$?
    _ws99_l="$(cat "$_ws99_tasks/acme__lib" 2>/dev/null)"
    if [ "$_ws99_rc" -eq 0 ] && [ "${_ws99_l#Add the shared helper}" != "$_ws99_l" ]; then
        ok "start --workspace $_ws99_variant: brief collected intact"
    else
        bad "start --workspace $_ws99_variant: rc=$_ws99_rc lib=[$_ws99_l] out=$_ws99_out"
    fi
done
_ws99_out="$(cd "$_ws99_tmp/proj" && LOKI_NO_BROWSER=1 timeout -k 5 60 bash "$REPO_ROOT/bin/loki" start --health-url http://127.0.0.1:1/ x 2>&1)"
_ws99_rc=$?
if [ "$_ws99_rc" -eq 2 ] && grep -q 'apply only with --deploy' <<<"$_ws99_out"; then
    ok "start --health-url without --deploy exits 2"
else
    bad "start --health-url without --deploy: rc=$_ws99_rc out=$_ws99_out"
fi
_ws99_out="$(cd "$_ws99_tmp/proj" && LOKI_NO_BROWSER=1 timeout -k 5 60 bash "$REPO_ROOT/bin/loki" start --deploy --budget notanumber x 2>&1)"
_ws99_rc=$?
if [ "$_ws99_rc" -ne 0 ] && grep -q 'not deploying' <<<"$_ws99_out"; then
    ok "start --deploy: a failed start never reaches the deploy step"
else
    bad "start --deploy: rc=$_ws99_rc out=$_ws99_out"
fi

# chat smoke: a pty session; /workspace reaches the same start --workspace, /deploy cancels without y.
cat > "$_ws99_tmp/chat_smoke.py" <<'PY'
import os, pty, sys, time, select
loki, proj, extra = sys.argv[1], sys.argv[2], sys.argv[3:]
env = dict(os.environ)
for kv in extra:
    k, v = kv.split("=", 1)
    env[k] = v
pid, fd = pty.fork()
if pid == 0:
    os.chdir(proj)
    os.execvpe("bash", ["bash", loki, "chat"], env)
out = b""
def pump(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d:
                return
            out += d
pump(3)
for line in ["/workspace planned acme/lib#1", "/deploy", "n", "/exit"]:
    os.write(fd, (line + "\n").encode())
    pump(25 if line.startswith("/workspace") else 3)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
sys.stdout.write(out.decode("utf8", "replace"))
PY
rm -rf "$_ws99_tmp/proj/.loki" "${_ws99_tasks:?}"/*
_ws99_out="$(timeout -k 5 150 python3 "$_ws99_tmp/chat_smoke.py" "$REPO_ROOT/bin/loki" "$_ws99_tmp/proj" LOKI_NO_BROWSER=1 "PLAN_SRC=$_ws99_tmp/plan-ok.json" \
    "LOKI_RECEIPT_SIGNING_KEY_FILE=$_ws99_tmp/sign.pem" "LOKI_WORKSPACE_LAUNCHER=$_ws99_tmp/plan-launcher.sh" 2>&1)"
if grep -q 'workspace run finished, exit 0' <<<"$_ws99_out" && grep -q 'composite: ' <<<"$_ws99_out" &&
    grep -q 'Deploy cancelled' <<<"$_ws99_out"; then
    ok "loki chat: /workspace prints the composite verdict and /deploy cancels without confirmation"
else
    bad "loki chat smoke: $(printf '%s' "$_ws99_out" | tail -15)"
fi

if grep -q '^## Verify a workspace run' "$REPO_ROOT/docs/WORKSPACES.md"; then
    ok "workspace e2e: docs/WORKSPACES.md has the verify section"
else
    bad "workspace e2e: docs/WORKSPACES.md lacks the verify section"
fi

if grep -qi 'deployed-SHA binding is not implemented' "$REPO_ROOT/docs/WORKSPACES.md" &&
    ! grep -q 'stale-head child makes it TAMPERED or UNCHECKED' "$REPO_ROOT/docs/WORKSPACES.md"; then
    ok "workspace e2e: docs/WORKSPACES.md states what the composite Seal covers and the deploy gap"
else
    bad "workspace e2e: docs/WORKSPACES.md Seal coverage wording is stale"
fi

rm -rf -- "$_ws99_tmp"
unset _ws99_tasks _ws99_l _ws99_a _ws99_comp _ws99_child _ws99_vout _ws99_tmp _ws99_entry _ws99_name _ws99_out _ws99_rc _ws99_json _ws99_status _ws99_src _ws99_met _ws99_n
