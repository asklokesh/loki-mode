#!/usr/bin/env bash
# Test the welcome opener: the opt-in profile form + PostHog (submit-only,
# anonymous, no PII), the CLI command, terminal fallback, first-run wiring
# (defined AND called, not dead code), and packaging.
set -u

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

LOKI="$REPO_ROOT/autonomy/loki"
HTML="$REPO_ROOT/assets/welcome/welcome.html"

# Test 1: welcome.html exists.
if [ -f "$HTML" ]; then ok "welcome.html present"; else bad "welcome.html missing"; fi

# Test 2: EXACTLY ONE network call, targeting the PostHog capture endpoint.
fetch_count=$(grep -c "fetch(" "$HTML")
if [ "$fetch_count" = "1" ] && grep -q "/capture/" "$HTML"; then
    ok "welcome.html has exactly one network call (PostHog capture)"
else
    bad "welcome.html network calls: count=$fetch_count (expected 1 to /capture/)"
fi

# Test 3: the single fetch is inside the submit click handler, NOT on load.
# We assert the fetch appears after the submitBtn click listener in the file.
click_line=$(grep -n 'submitBtn.addEventListener("click"' "$HTML" | head -1 | cut -d: -f1)
fetch_line=$(grep -n "fetch(" "$HTML" | head -1 | cut -d: -f1)
if [ -n "$click_line" ] && [ -n "$fetch_line" ] && [ "$fetch_line" -gt "$click_line" ]; then
    ok "the network call is inside the submit handler (not on page load)"
else
    bad "network call not gated behind submit (click=$click_line fetch=$fetch_line)"
fi

# Test 4: payload carries NO prompt/PRD/code/path/identity content. Inspect
# the actual `properties: { ... }` block (the payload), not the surrounding
# safety comment which legitimately names the excluded fields. Extract the
# properties object and assert it only mentions the allowed keys.
props=$(awk '/properties: \{/{f=1} f{print} /^[[:space:]]*\}/{if(f)exit}' "$HTML" \
        | grep -v "//")
if grep -q "Deliberately NO prompt" "$HTML" \
   && ! printf '%s' "$props" | grep -qiE "prompt|prd|filepath|file_path|projectpath|cwd|hostname|email|fullname|real_name"; then
    ok "payload object excludes prompts/PRDs/code/paths/identity (allowed keys only)"
else
    bad "payload object may leak project or identity content"
fi

# Test 5: reuses the existing PostHog ingest key.
if grep -q "phc_ya0vGBru41AJWtGNfZZ8H9W4yjoZy4KON0nnayS7s87" "$HTML"; then
    ok "welcome.html reuses the existing PostHog ingest key"
else
    bad "welcome.html does not use the existing PostHog key"
fi

# Test 6: opt-out via ?telemetry=off disables the form and returns before any
# submit handler binds (no capture possible).
if grep -q 'telemetry") === "off"' "$HTML" && grep -q "telemetryOff" "$HTML"; then
    ok "welcome.html honors ?telemetry=off (form disabled, no capture)"
else
    bad "welcome.html missing telemetry opt-out handling"
fi

# Test 7: design fidelity (loki dashboard tokens + dark mode).
if grep -q "#553DE9" "$HTML" && grep -q "DM Serif Display" "$HTML" \
   && grep -q "prefers-color-scheme: dark" "$HTML"; then
    ok "welcome.html uses dashboard design tokens + dark mode"
else
    bad "welcome.html design tokens incomplete"
fi

# Test 8: CLI `loki welcome` prints the terminal welcome.
OUT=$(bash "$LOKI" welcome 2>&1)
if echo "$OUT" | grep -q "Describe it. Walk away." \
   && echo "$OUT" | grep -q "autonomi.dev/docs"; then
    ok "loki welcome prints terminal welcome with docs link"
else
    bad "loki welcome terminal output incomplete"
fi

# Test 9: opt-out env flips the terminal consent line.
OUT_OFF=$(LOKI_TELEMETRY_DISABLED=true bash "$LOKI" welcome 2>&1)
OUT_DNT=$(DO_NOT_TRACK=1 bash "$LOKI" welcome 2>&1)
if echo "$OUT_OFF" | grep -qi "Analytics are off" \
   && echo "$OUT_DNT" | grep -qi "Analytics are off"; then
    ok "loki welcome honors LOKI_TELEMETRY_DISABLED and DO_NOT_TRACK"
else
    bad "loki welcome ignores an opt-out env var"
fi

# Test 10: first-run hook is DEFINED and actually CALLED (not dead code).
firstrun_refs=$(grep -c "cmd_welcome_maybe_firstrun" "$LOKI")
if grep -q "^cmd_welcome_maybe_firstrun()" "$LOKI" \
   && [ "$firstrun_refs" -ge 2 ] \
   && grep -q "WELCOME_MARKER" "$LOKI" \
   && grep -q "        welcome)" "$LOKI"; then
    ok "first-run hook defined AND called; dispatch wired (refs=$firstrun_refs)"
else
    bad "first-run hook dead or dispatch missing (refs=$firstrun_refs)"
fi

# Test 10b: the first-run call sits inside cmd_start (call line after cmd_start,
# and the standalone definition is elsewhere).
start_line=$(grep -n "^cmd_start()" "$LOKI" | head -1 | cut -d: -f1)
call_line=$(grep -n "^[[:space:]]\{1,\}cmd_welcome_maybe_firstrun 2>" "$LOKI" | head -1 | cut -d: -f1)
def_line=$(grep -n "^cmd_welcome_maybe_firstrun()" "$LOKI" | head -1 | cut -d: -f1)
if [ -n "$start_line" ] && [ -n "$call_line" ] && [ -n "$def_line" ] \
   && [ "$call_line" -gt "$start_line" ] && [ "$def_line" -gt "$call_line" ]; then
    ok "first-run call is inside cmd_start (call $call_line, cmd_start $start_line, def $def_line)"
else
    bad "first-run call not inside cmd_start (start=$start_line call=$call_line def=$def_line)"
fi

# Test 11: packaging. assets/ ships to npm (npm pack writes to stderr -> 2>&1)
# and both Dockerfiles COPY it.
if npm pack --dry-run 2>&1 | grep -q "assets/welcome/welcome.html"; then
    ok "welcome.html present in npm tarball"
else
    bad "welcome.html missing from npm tarball"
fi
if grep -q "COPY .*assets/ ./assets/" docker/Dockerfile \
   && grep -q "COPY .*assets/ ./assets/" docker/Dockerfile.sandbox; then
    ok "Dockerfile + Dockerfile.sandbox COPY assets/"
else
    bad "a Dockerfile is missing COPY assets/"
fi

# Test 12: no em dashes in the new files.
if grep -lP '\xe2\x80\x94' "$HTML" tests/test-welcome-opener.sh >/dev/null 2>&1; then
    bad "em dash found in welcome files"
else
    ok "no em dashes in welcome files"
fi

rm -f loki-mode-*.tgz 2>/dev/null

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
