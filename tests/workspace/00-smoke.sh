# shellcheck shell=bash
# D51 Phase B workspace harness smoke test (B01)
# One trivial assertion to verify the runner works.
#
# Sourced by tests/test-workspace.sh, which provides ok() and bad()

# Simple check: a trivial assertion to verify the test harness is working
if true; then
    ok "workspace harness smoke test"
else
    bad "workspace harness smoke test"
fi

# GRAPH: `workspace infer` suggests after: edges from manifests (print-only).
_ws00_tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-ws00.XXXXXX")"
mkdir -p "$_ws00_tmp/api" "$_ws00_tmp/web" "$_ws00_tmp/proj"
printf '{"name":"@acme/api","dependencies":{}}\n' > "$_ws00_tmp/api/package.json"
printf '{"name":"web","dependencies":{"@acme/api":"1.0.0"}}\n' > "$_ws00_tmp/web/package.json"
cat > "$_ws00_tmp/proj/loki.yaml" <<YAML
workspaces:
  shop:
    repos:
      - {repo: owner/api, path: $_ws00_tmp/api}
      - {repo: owner/web, path: $_ws00_tmp/web}
YAML
_ws00_out="$(cd "$_ws00_tmp/proj" && env -u LOKI_WORKSPACES python3 "$REPO_ROOT/autonomy/lib/workspace.py" infer shop 2>&1)"
_ws00_rc=$?
if [ "$_ws00_rc" -eq 0 ] && printf '%s' "$_ws00_out" | grep -q 'after: \[owner/api\]' &&
    ! grep -q 'after' "$_ws00_tmp/proj/loki.yaml"; then
    ok "workspace infer: web depends on api, prints after: [owner/api], print-only"
else
    bad "workspace infer: expected after: [owner/api] (rc=$_ws00_rc out=$_ws00_out)"
fi

# Mutual dependency is a cycle: refuse (exit 1), never print edges.
printf '{"name":"@acme/api","dependencies":{"web":"1"}}\n' > "$_ws00_tmp/api/package.json"
_ws00_out="$(cd "$_ws00_tmp/proj" && env -u LOKI_WORKSPACES python3 "$REPO_ROOT/autonomy/lib/workspace.py" infer shop 2>&1)"
_ws00_rc=$?
if [ "$_ws00_rc" -eq 1 ] && printf '%s' "$_ws00_out" | grep -q 'not usable'; then
    ok "workspace infer: cyclic inferred edges rejected"
else
    bad "workspace infer: cycle rejected (rc=$_ws00_rc)"
fi
rm -rf -- "$_ws00_tmp"
unset _ws00_tmp _ws00_out _ws00_rc
