#!/usr/bin/env bash
# The deploy `error` field must survive from server to rendered UI.
#
# web-app/server.py returns {"connected": false, "error": "Token expired or
# revoked"} whenever a stored deploy token is rejected by the platform CLI. The
# React client had ZERO readers of that field, so an EXPIRED token rendered
# identically to one that was NEVER CONNECTED: a grey dot, "Not connected", and
# no path to fix it without leaving the screen.
#
# The blindness was structural, which is what this suite pins. `ConnectionStatus`
# is declared TWICE -- once in components/DeployConnections.tsx and once in
# types/api.ts -- and ConnectionCard is typed against the COMPONENT-LOCAL one.
# Under `strict: true` (web-app/tsconfig.json:15), reading status.error is a
# hard compile error unless that local declaration carries the field. Adding it
# only to types/api.ts compiles and changes nothing on screen.
#
# WHY THIS IS A STATIC SUITE AND NOT A PLAYWRIGHT SPEC. Three e2e attempts each
# died on a different environmental gate, none of them related to the feature:
#   1. pages/ConnectionsPage.tsx renders <DeployConnections/> but is an ORPHAN --
#      App.tsx imports it zero times (control: MetricsPage, twice). Navigating to
#      /connections hits the SPA catch-all, which returns 200 and renders
#      NotFoundPage, so every locator resolved to 0 elements and even the
#      NEGATIVE control failed.
#   2. The only reachable surface is ProjectWorkspace.tsx:2204 -> DeployPanel ->
#      DeployConnections, and it renders only when activeWorkspaceTab ==
#      'deploy'.
#   3. That app is mounted by dashboard/server.py:1434 at /lab behind
#      _MountAuthGuard(..., "read"), so a spec must hold a scoped token.
# Authenticating through a guarded mount and driving a tab, to assert a
# two-line conditional, is a harness far more fragile than what it guards. These
# assertions cannot be defeated by a missing server, and they fail for exactly
# one reason: someone dropped the field or the read.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

COMPONENT="web-app/src/components/DeployConnections.tsx"
TYPES="web-app/src/types/api.ts"
SERVER="web-app/server.py"

for f in "$COMPONENT" "$TYPES" "$SERVER"; do
    [ -f "$f" ] || { bad "missing required file: $f"; }
done
if [ "$FAIL" -ne 0 ]; then
    printf '\nTotal: %d  Passed: %d  Failed: %d\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
    exit 1
fi

# ---------------------------------------------------------------------------
# 1. The server still emits the field. If this ever stops being true, the UI
#    work below is dead weight and the suite should say so loudly rather than
#    keep asserting a contract the producer abandoned.
# ---------------------------------------------------------------------------
emit_count="$(grep -c 'Token expired or revoked' "$SERVER" 2>/dev/null || echo 0)"
if [ "$emit_count" -ge 1 ]; then
    ok "server emits the expiry error ($emit_count sites in $SERVER)"
else
    bad "no site in $SERVER emits \"Token expired or revoked\" -- the producer is gone"
fi

# ---------------------------------------------------------------------------
# 2. BOTH type homes declare `error`. Asserted individually, never as a count:
#    a count cannot say WHICH declaration regressed, and the component-local one
#    is the only one that unlocks the render.
# ---------------------------------------------------------------------------
# Extract just the ConnectionStatus interface body from each file.
iface_body() {
    awk '/^export interface ConnectionStatus \{/{flag=1} flag{print} flag&&/^\}/{exit}' "$1"
}

if iface_body "$COMPONENT" | grep -qE '^\s*error\?:\s*string'; then
    ok "component-local ConnectionStatus declares error?: string (the one ConnectionCard is typed against)"
else
    bad "$COMPONENT ConnectionStatus is missing error?: string -- reading status.error will not compile"
fi

if iface_body "$TYPES" | grep -qE '^\s*error\?:\s*string'; then
    ok "types/api.ts ConnectionStatus declares error?: string (wire shape stays honest)"
else
    bad "$TYPES ConnectionStatus is missing error?: string -- the two declarations have diverged again"
fi

# ---------------------------------------------------------------------------
# 3. The component actually READS it and acts on it. A declared-but-unread field
#    is precisely the state this fix replaced, so declaration alone is not
#    enough to pass.
# ---------------------------------------------------------------------------
if grep -q 'status\.error' "$COMPONENT"; then
    ok "ConnectionCard reads status.error"
else
    bad "$COMPONENT never reads status.error -- the field is declared but unused, which is the original bug"
fi

if grep -q 'Reconnect' "$COMPONENT"; then
    ok "an expired token offers Reconnect, distinct from Connect"
else
    bad "$COMPONENT has no Reconnect affordance -- an expired token still reads as never-connected"
fi

# ---------------------------------------------------------------------------
# 4. The built bundle carries it. web-app/dist is TRACKED IN GIT and is what npm
#    users receive, so a source-only change ships nothing. This is the packaged-
#    artifact blind spot CLAUDE.md documents, applied to the frontend.
#
#    grep -o, never grep -c: the bundle is minified onto very few lines, so a
#    line count cannot distinguish one occurrence from twenty.
# ---------------------------------------------------------------------------
bundle_hits=0
if ls web-app/dist/assets/*.js >/dev/null 2>&1; then
    bundle_hits="$(grep -rho 'Reconnect' web-app/dist/assets/*.js 2>/dev/null | wc -l | tr -d ' ')"
fi
if [ "${bundle_hits:-0}" -ge 1 ]; then
    ok "the built bundle carries the Reconnect affordance ($bundle_hits occurrences)"
else
    bad "web-app/dist carries no Reconnect -- dist is stale; run 'npm run build' in web-app/"
fi

# ---------------------------------------------------------------------------
# 5. NEGATIVE CONTROL. Without this, every assertion above would still pass if
#    the component rendered "Reconnect" unconditionally, which would mislabel a
#    platform the user never set up. The Connect path must survive.
# ---------------------------------------------------------------------------
if grep -q 'Connect \${platform.name}\|`Connect ${platform.name}`' "$COMPONENT"; then
    ok "the never-connected path still says Connect (negative control)"
else
    bad "$COMPONENT lost its plain Connect label -- a never-connected platform now reads as expired"
fi

printf '\nTotal: %d  Passed: %d  Failed: %d\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
