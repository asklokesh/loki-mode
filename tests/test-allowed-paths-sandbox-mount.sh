#!/usr/bin/env bash
#==============================================================================
# A5+: workspace-mount ALLOWED_PATHS enforcement (HONESTLY SCOPED).
#
# Covers the workspace bind-mount enforcement added to start_sandbox in
# autonomy/sandbox.sh: when LOKI_ALLOWED_PATHS is set and the workspace
# ($PROJECT_DIR) is outside the allowlist, the sandbox refuses to start
# (fail-closed) rather than bind-mounting the project writable. The workspace
# mount is where provider-driven agent file writes actually land, so this is
# the real write surface (not just the custom --mount surface from A5).
#
# Enforcement mechanism under test: docker mount mode and which host path is
# bound are decided in start_sandbox BEFORE the container exists. We assert on
# the rendered `docker run` argv using a fake docker PATH stub that echoes its
# args -- no real container is created.
#
# Honesty boundary: this enforces the host->container mount the wrapper owns.
# It does NOT claim to constrain writes when sandbox mode is OFF (no container
# exists, so the host path is unmediated) -- that boundary is documented in the
# sandbox.sh comment and not asserted as enforced here.
#==============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SBX="$REPO/autonomy/sandbox.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-a5mount-XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"   # de-symlink for realpath comparisons
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ck(){ if [ "$1" = "$2" ]; then echo "  [PASS] $3"; pass=$((pass+1)); else echo "  [FAIL] $3 (got '$1' want '$2')"; fail=$((fail+1)); fi; }

echo "A5+: workspace-mount ALLOWED_PATHS enforcement"
echo "=============================================="

# Fake docker: a PATH stub that records its argv to a file and exits 0 so the
# detached-run path returns cleanly. `docker run` output (the container id) is
# echoed so start_sandbox's container_id capture is non-empty.
mkdir -p "$WORK/fakebin"
cat > "$WORK/fakebin/docker" <<'STUB'
#!/usr/bin/env bash
# Record full argv (newline-delimited) for assertion.
{ for a in "$@"; do printf '%s\n' "$a"; done; } >> "${FAKE_DOCKER_LOG:?}"
case "$1" in
    info)    exit 0 ;;                       # check_docker: daemon up
    image)   exit 0 ;;                       # ensure_image: inspect ok
    ps)      exit 0 ;;                        # not already running (no match)
    run)     echo "deadbeefcafe0000" ; exit 0 ;;  # container id
    rm)      exit 0 ;;
    *)       exit 0 ;;
esac
STUB
chmod +x "$WORK/fakebin/docker"

# Allowed workspace tree, plus a sibling that is NOT in the allowlist.
mkdir -p "$WORK/allowed/project" "$WORK/outside/project"

# run start_sandbox in a clean subshell with a fake docker on PATH.
# $1 = PROJECT_DIR, $2 = LOKI_ALLOWED_PATHS (empty = unset)
# Echoes: rc on first line, then the recorded docker argv.
run_start() {
    local proj="$1" allow="$2"
    local logf="$WORK/docker.log"
    : > "$logf"
    (
        export PATH="$WORK/fakebin:$PATH"
        export FAKE_DOCKER_LOG="$logf"
        export LOKI_PROJECT_DIR="$proj"
        export LOKI_DASHBOARD_PORT=0     # check_port_available: lsof/nc on :0 -> free
        if [ -n "${ALLOW_HOSTS_FOR_TEST:-}" ]; then export LOKI_SANDBOX_ALLOW_HOSTS="$ALLOW_HOSTS_FOR_TEST"; else unset LOKI_SANDBOX_ALLOW_HOSTS; fi
        if [ -n "$allow" ]; then export LOKI_ALLOWED_PATHS="$allow"; else unset LOKI_ALLOWED_PATHS; fi
        # Source with trailing `main "$@"` stripped so we can call start_sandbox directly.
        grep -v '^main "\$@"$' "${SBX_UNDER_TEST:-$SBX}" > "$WORK/sandbox_src.sh"
        # shellcheck disable=SC1090
        source "$WORK/sandbox_src.sh" >/dev/null 2>&1
        # Make the port check hermetic (no host network state involved).
        check_port_available() { return 0; }
        # sandbox.sh runs under `set -e`; a bare non-zero return from start_sandbox
        # (the fail-closed refusal path) would abort the subshell before we record
        # the rc. Disable errexit around the call so we capture the real rc.
        set +e
        start_sandbox >/dev/null 2>&1
        echo "RC=$?"
    )
    echo "----LOG----"
    cat "$logf"
}

# Helper: did a writable workspace mount get rendered? Looks for the exact
# `--volume <proj>:/workspace:rw` pair in the recorded argv.
has_writable_workspace() {
    local proj="$1" out="$2"
    # The stub records each argv element on its own line; --volume is immediately
    # followed by its value. Match the value line.
    echo "$out" | grep -qx -- "${proj}:/workspace:rw"
}

# --- (a) ALLOWED_PATHS set + workspace inside allowlist -> writable mount, no refusal
out="$(run_start "$WORK/allowed/project" "$WORK/allowed")"
rc="$(echo "$out" | grep -o 'RC=[0-9]*' | head -1 | cut -d= -f2)"
ck "$rc" "0" "(a) inside allowlist -> start_sandbox succeeds"
if has_writable_workspace "$WORK/allowed/project" "$out"; then
    ck "yes" "yes" "(a) inside allowlist -> workspace mounted writable (:rw)"
else
    ck "no" "yes" "(a) inside allowlist -> workspace mounted writable (:rw)"
fi

# --- (b) workspace outside allowlist -> refused (fail-closed), NO writable mount
out="$(run_start "$WORK/outside/project" "$WORK/allowed")"
rc="$(echo "$out" | grep -o 'RC=[0-9]*' | head -1 | cut -d= -f2)"
ck "$rc" "1" "(b) outside allowlist -> start_sandbox refuses (rc=1)"
if has_writable_workspace "$WORK/outside/project" "$out"; then
    ck "yes" "no" "(b) outside allowlist -> NO writable workspace mount rendered"
else
    ck "no" "no" "(b) outside allowlist -> NO writable workspace mount rendered"
fi
# Refusal must happen before `docker run` is ever invoked.
if echo "$out" | sed -n '/----LOG----/,$p' | grep -qx "run"; then
    ck "ran" "norun" "(b) outside allowlist -> docker run NOT invoked"
else
    ck "norun" "norun" "(b) outside allowlist -> docker run NOT invoked"
fi

# --- (c) ALLOWED_PATHS empty -> byte-identical to today (workspace still writable
#         even for a path that WOULD be outside any allowlist).
out="$(run_start "$WORK/outside/project" "")"
rc="$(echo "$out" | grep -o 'RC=[0-9]*' | head -1 | cut -d= -f2)"
ck "$rc" "0" "(c) empty allowlist -> start_sandbox succeeds (no new restriction)"
if has_writable_workspace "$WORK/outside/project" "$out"; then
    ck "yes" "yes" "(c) empty allowlist -> workspace mounted writable (unchanged)"
else
    ck "no" "yes" "(c) empty allowlist -> workspace mounted writable (unchanged)"
fi

# --- (d) sandbox OFF (no docker) -> the workspace enforcement is a no-op because
#         no mount/container is created. Honest boundary: with sandbox off there
#         is no host->container mediation to enforce. We assert that the guard
#         helper itself is a pure no-op when the allowlist is empty (the default
#         off-sandbox condition) and does not alter behavior. Source the helper
#         only and confirm the unset-allowlist branch allows unconditionally.
(
    unset LOKI_ALLOWED_PATHS
    grep -v '^main "\$@"$' "$SBX" > "$WORK/sandbox_src.sh"
    # shellcheck disable=SC1090
    source "$WORK/sandbox_src.sh" >/dev/null 2>&1
    _sandbox_path_within_allowed "$WORK/outside/project"
    echo "OFFRC=$?"
) | grep -q "OFFRC=0"
ck "$?" "0" "(d) sandbox off / empty allowlist -> path guard is a no-op (allows)"

# --- (e) egress allowlist unset -> docker argv byte-identical to the pre-change
#         sandbox.sh (regression: opt-in feature must not alter the default).
git -C "$REPO" show b33c8083e:autonomy/sandbox.sh > "$WORK/sandbox_base.sh" 2>/dev/null
if [ -s "$WORK/sandbox_base.sh" ]; then
    base_log="$(SBX_UNDER_TEST="$WORK/sandbox_base.sh" run_start "$WORK/allowed/project" "" | sed -n '/----LOG----/,$p')"
    new_log="$(run_start "$WORK/allowed/project" "" | sed -n '/----LOG----/,$p')"
    ck "$([ "$base_log" = "$new_log" ] && echo same || echo differ)" "same" "(e) allowlist unset -> docker argv byte-identical to base"
else
    echo "  [SKIP] (e) base sandbox.sh not available from git (shallow clone)"
fi

# --- (f) allowlist set -> internal network + proxy sidecar + proxy env, and the
#         sandbox container is NOT on plain bridge.
out="$(ALLOW_HOSTS_FOR_TEST="api.anthropic.com, github.com" run_start "$WORK/allowed/project" "")"
rc="$(echo "$out" | grep -o 'RC=[0-9]*' | head -1 | cut -d= -f2)"
ck "$rc" "0" "(f) allowlist set -> start_sandbox succeeds"
logonly="$(echo "$out" | sed -n '/----LOG----/,$p')"
echo "$logonly" | grep -qx -- "--internal"; ck "$?" "0" "(f) docker network create --internal issued"
echo "$logonly" | grep -qx -- "ALLOW_HOSTS=api.anthropic.com,github.com"; ck "$?" "0" "(f) proxy sidecar receives the normalized allowlist"
echo "$logonly" | grep -qE -- '^HTTPS_PROXY=http://loki-sandbox-.*-egress:3128$'; ck "$?" "0" "(f) sandbox container gets HTTPS_PROXY to the sidecar"
echo "$logonly" | grep -qE -- '^--network=loki-sandbox-.*-internal$'; ck "$?" "0" "(f) sandbox container joins the internal network"
echo "$logonly" | grep -qF -- "169.254.0.0/16"; ck "$?" "0" "(f) link-local range passed to the proxy block list"

# --- (g) IP literal in the allowlist -> refused before any docker run.
out="$(ALLOW_HOSTS_FOR_TEST="169.254.169.254" run_start "$WORK/allowed/project" "")"
rc="$(echo "$out" | grep -o 'RC=[0-9]*' | head -1 | cut -d= -f2)"
ck "$rc" "1" "(g) IP literal allowlist entry -> refused (rc=1)"
echo "$out" | sed -n '/----LOG----/,$p' | grep -qx "run"; ck "$?" "1" "(g) IP literal -> docker run NOT invoked"

# --- (h) proxy decision function: allowed host passes; link-local, private,
#         loopback, v6 link-local, unlisted host and rebinding are refused.
#         Resolver is injected, so no network is touched. A live egress probe
#         needs real docker + network and is not run here.
py_out="$(cd "$WORK" && source <(grep -v '^main "\$@"$' "$SBX") >/dev/null 2>&1; _sandbox_egress_proxy_source > "$WORK/proxy.py"
ALLOW_HOSTS="ok.example.com,meta.example.com" BLOCKED_CIDRS="" python3 -I - <<PY
import importlib.util
sp = importlib.util.spec_from_file_location("p", "$WORK/proxy.py"); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
def t(h, ip): return m.check_target(h, lambda _: [ip])[0]
print("allowed", t("ok.example.com", "93.184.216.34"))
print("metadata", t("meta.example.com", "169.254.169.254"))
print("private10", t("ok.example.com", "10.1.2.3"))
print("private172", t("ok.example.com", "172.20.0.5"))
print("private192", t("ok.example.com", "192.168.1.1"))
print("loopback", t("ok.example.com", "127.0.0.1"))
print("v6ll", t("ok.example.com", "fe80::1"))
print("mapped", t("ok.example.com", "::ffff:169.254.169.254"))
print("unlisted", t("evil.example.com", "93.184.216.34"))
print("cgnat", t("ok.example.com", "100.100.100.200"))
print("sitelocal6", t("ok.example.com", "fec0::1"))
print("port22", m.check_target("ok.example.com", lambda _: ["93.184.216.34"], 22)[0])
print("port443", m.check_target("ok.example.com", lambda _: ["93.184.216.34"], 443)[0])
print("literal", m.check_target("169.254.169.254", lambda _: ["169.254.169.254"])[0])
PY
)"
for k in "allowed True" "metadata False" "private10 False" "private172 False" "private192 False" "loopback False" "v6ll False" "mapped False" "unlisted False" "cgnat False" "sitelocal6 False" "port22 False" "port443 True" "literal False"; do
    echo "$py_out" | grep -qx "$k"; ck "$?" "0" "(h) proxy decision: $k"
done

# --- (i) teardown: a refusal after the egress proxy is up (workspace outside
#         the allowlist) returns 1 and the log shows the sidecar and network removed.
out="$(ALLOW_HOSTS_FOR_TEST="github.com" run_start "$WORK/outside/project" "$WORK/allowed")"
rc="$(echo "$out" | grep -o 'RC=[0-9]*' | head -1 | cut -d= -f2)"
ck "$rc" "1" "(i) refusal after egress up -> rc 1"
lg="$(echo "$out" | sed -n '/----LOG----/,$p')"
echo "$lg" | grep -qE '^loki-sandbox-.*-egress$'; ck "$?" "0" "(i) refusal -> sidecar named in an rm call"
echo "$lg" | awk 'prev=="network"&&$0=="create"{c=1} prev=="network"&&$0=="rm"&&c{f=1} {prev=$0} END{exit !f}'; ck "$?" "0" "(i) refusal -> docker network rm issued AFTER the create"

# --- (j) stop_sandbox with no running sandbox still tears the egress proxy down.
: > "$WORK/docker.log"
(
    export PATH="$WORK/fakebin:$PATH" FAKE_DOCKER_LOG="$WORK/docker.log" LOKI_PROJECT_DIR="$WORK/allowed/project"
    grep -v '^main "\$@"$' "$SBX" > "$WORK/sandbox_src.sh"
    # shellcheck disable=SC1090
    source "$WORK/sandbox_src.sh" >/dev/null 2>&1
    set +e; stop_sandbox >/dev/null 2>&1
)
grep -qx -- "-internal" "$WORK/docker.log" 2>/dev/null; true
grep -qE '^loki-sandbox-.*-internal$' "$WORK/docker.log"; ck "$?" "0" "(j) stop with nothing running -> internal network removed"
grep -qE '^loki-sandbox-.*-egress$' "$WORK/docker.log"; ck "$?" "0" "(j) stop with nothing running -> sidecar removed"

echo
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
