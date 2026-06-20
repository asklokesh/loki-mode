#!/usr/bin/env bash
#===============================================================================
# Config-map no-yq YAML fallback tests (regression for two real bugs).
#
# The YAML parser in autonomy/lib/config-map.sh has two paths: a yq path (used
# when `yq` is on PATH) and a pure-shell fallback (used when it is not). yq is
# NOT guaranteed present, so the fallback is a live code path. Two bugs lived in
# it before this suite existed:
#
#   BUG 2 (same-last-segment collision): the old fallback matched only the LAST
#   dotted segment (key="${yaml_path##*.}") with `grep ... | head -1`, so
#   dashboard.enabled, notifications.enabled and completion.council.enabled all
#   resolved to the FIRST `enabled:` line in the file -- every same-suffix key
#   got one shared value.
#
#   BUG 3 (BSD sed \s): the fallback stripped the value with `sed -E 's/.*:\s*//'`.
#   BSD sed (macOS default) does NOT treat \s as whitespace, so a leading space
#   survived, the following quote-strip missed, and a quoted value like "true"
#   came out as the stray-quoted ` "true` instead of `true`.
#
# Both are now resolved by loki_yaml_fallback_extract (full nested-path descent
# by indentation, POSIX [[:space:]], awk-only so it is GNU/BSD portable). This
# suite forces the no-yq path (yq hidden from PATH) and proves both fixes.
#
# Strategy: source the side-effect-free lib in a subshell, hide yq, call the
# real YAML parser against crafted files, and read the resulting LOKI_* env.
# Every assertion is paired with a second value (flip) so a pass cannot be a
# default coincidence. Any case that cannot run emits a visible FAIL.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_MAP_LIB="$PROJECT_DIR/autonomy/lib/config-map.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  [PASS] $1"; }
fail() {
    FAIL=$((FAIL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-cfgmap.XXXXXX")"
cleanup() { rm -rf "$WORKROOT" 2>/dev/null || true; }
trap cleanup EXIT

if [ ! -f "$CONFIG_MAP_LIB" ]; then
    echo "  [FAIL] config-map lib not found: $CONFIG_MAP_LIB"
    echo ""
    echo "Config-map fallback: 0 passed, 1 failed"
    exit 1
fi

# Build a PATH with yq removed so the fallback path is forced even on a box that
# has yq installed. We construct a clean bin dir holding only the tools the
# fallback needs (awk, grep, sed, head, tr, cat, env, bash) symlinked from the
# real ones, then point PATH at it. This guarantees `command -v yq` fails.
FAKEBIN="$WORKROOT/bin"
mkdir -p "$FAKEBIN"
for tool in awk grep sed head tr cat env bash dirname mktemp rm cut printf; do
    real="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$real" ] && ln -sf "$real" "$FAKEBIN/$tool"
done

# Confirm yq really is absent under the fake PATH (the precondition of this suite).
if PATH="$FAKEBIN" command -v yq >/dev/null 2>&1; then
    fail "precondition: yq must be hidden from PATH for the fallback path" \
         "yq is still resolvable under FAKEBIN -- the test would exercise the yq path, not the fallback"
fi

# Helper: parse a YAML file via the REAL no-yq fallback and echo one LOKI_ var.
# Runs in a subshell with the yq-free PATH so the export cannot leak between
# cases and `have_yq` resolves to 0 inside loki_parse_yaml_file.
parse_yaml_var() {
    local file="$1" var="$2"
    PATH="$FAKEBIN" bash -c '
        set -uo pipefail
        source "'"$CONFIG_MAP_LIB"'"
        loki_parse_yaml_file "'"$file"'" 1 >/dev/null 2>&1
        printf "%s" "${'"$var"':-<unset>}"
    '
}

#-------------------------------------------------------------------------------
# Case 1 (BUG 2): same-last-segment keys must NOT collide.
# dashboard.enabled=true, notifications.enabled=false, completion.council.enabled=true
# all share the leaf "enabled". Each must resolve to ITS OWN value.
#-------------------------------------------------------------------------------
echo "[Case 1] BUG 2: same-last-segment keys resolve independently"
cat > "$WORKROOT/collide.yaml" <<'EOF'
dashboard:
  enabled: true
notifications:
  enabled: false
completion:
  council:
    enabled: true
EOF
V_DASH="$(parse_yaml_var "$WORKROOT/collide.yaml" LOKI_DASHBOARD)"
V_NOTIF="$(parse_yaml_var "$WORKROOT/collide.yaml" LOKI_NOTIFICATIONS)"
V_COUNCIL="$(parse_yaml_var "$WORKROOT/collide.yaml" LOKI_COUNCIL_ENABLED)"
if [ "$V_DASH" = "true" ] && [ "$V_NOTIF" = "false" ] && [ "$V_COUNCIL" = "true" ]; then
    pass "distinct values: dashboard=$V_DASH notifications=$V_NOTIF council=$V_COUNCIL"
else
    fail "same-last-segment collision" \
         "dashboard=$V_DASH (want true) notifications=$V_NOTIF (want false) council=$V_COUNCIL (want true)"
fi

# Flip: swap so the collision, if present, would now produce the OTHER value.
cat > "$WORKROOT/collide-flip.yaml" <<'EOF'
dashboard:
  enabled: false
notifications:
  enabled: true
EOF
V_DASH2="$(parse_yaml_var "$WORKROOT/collide-flip.yaml" LOKI_DASHBOARD)"
V_NOTIF2="$(parse_yaml_var "$WORKROOT/collide-flip.yaml" LOKI_NOTIFICATIONS)"
if [ "$V_DASH2" = "false" ] && [ "$V_NOTIF2" = "true" ]; then
    pass "flip confirms independence: dashboard=$V_DASH2 notifications=$V_NOTIF2"
else
    fail "flip collision" "dashboard=$V_DASH2 (want false) notifications=$V_NOTIF2 (want true)"
fi

#-------------------------------------------------------------------------------
# Case 2 (BUG 3): a quoted value must come out clean (no stray leading quote).
# On BSD sed the old `\s` left a leading space so the value was ` "true`.
#-------------------------------------------------------------------------------
echo "[Case 2] BUG 3: quoted value has no stray leading quote"
cat > "$WORKROOT/quoted.yaml" <<'EOF'
dashboard:
  enabled: "true"
EOF
V_Q="$(parse_yaml_var "$WORKROOT/quoted.yaml" LOKI_DASHBOARD)"
if [ "$V_Q" = "true" ]; then
    pass "quoted value clean: [$V_Q]"
else
    fail "stray quote / whitespace in quoted value" "got [$V_Q], want [true]"
fi

# Flip: single quotes must also strip clean.
cat > "$WORKROOT/quoted-single.yaml" <<'EOF'
dashboard:
  enabled: 'false'
EOF
V_QS="$(parse_yaml_var "$WORKROOT/quoted-single.yaml" LOKI_DASHBOARD)"
if [ "$V_QS" = "false" ]; then
    pass "single-quoted value clean: [$V_QS]"
else
    fail "stray quote in single-quoted value" "got [$V_QS], want [false]"
fi

#-------------------------------------------------------------------------------
# Case 3: inline comment after a value is dropped (unquoted and quoted).
#-------------------------------------------------------------------------------
echo "[Case 3] inline comment is stripped from the value"
cat > "$WORKROOT/comment.yaml" <<'EOF'
dashboard:
  port: 8080   # the web UI port
EOF
V_PORT="$(parse_yaml_var "$WORKROOT/comment.yaml" LOKI_DASHBOARD_PORT)"
if [ "$V_PORT" = "8080" ]; then
    pass "unquoted value strips trailing comment: [$V_PORT]"
else
    fail "trailing comment not stripped" "got [$V_PORT], want [8080]"
fi

# A '#' INSIDE a quoted scalar must be preserved (not treated as a comment).
cat > "$WORKROOT/hash.yaml" <<'EOF'
completion:
  promise: "build #5 is complete"
EOF
V_PROMISE="$(parse_yaml_var "$WORKROOT/hash.yaml" LOKI_COMPLETION_PROMISE)"
if [ "$V_PROMISE" = "build #5 is complete" ]; then
    pass "hash inside quoted scalar preserved: [$V_PROMISE]"
else
    fail "hash inside quotes mishandled" "got [$V_PROMISE], want [build #5 is complete]"
fi

#-------------------------------------------------------------------------------
# Case 4: an absent key resolves to unset (no spurious value from a sibling).
#-------------------------------------------------------------------------------
echo "[Case 4] absent key stays unset"
cat > "$WORKROOT/absent.yaml" <<'EOF'
dashboard:
  enabled: true
EOF
V_ABSENT="$(parse_yaml_var "$WORKROOT/absent.yaml" LOKI_DASHBOARD_PORT)"
if [ "$V_ABSENT" = "<unset>" ]; then
    pass "absent key is unset (no sibling bleed)"
else
    fail "absent key picked up a value" "LOKI_DASHBOARD_PORT=[$V_ABSENT], want <unset>"
fi

#-------------------------------------------------------------------------------
# Summary
#-------------------------------------------------------------------------------
echo ""
echo "Config-map fallback: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
