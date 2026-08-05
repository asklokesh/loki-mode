#!/usr/bin/env bash
# Focused contract tests for the hosted simple-web execution policy.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$ROOT/autonomy/run.sh"
PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t loki-simple-web.XXXXXX)"
cleanup() { rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }
expect_success() { local label="$1"; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }
expect_failure() { local label="$1"; shift; if "$@"; then bad "$label"; else ok "$label"; fi; }

PREDICATE_CODE="$(awk '/^loki_is_supervised_simple_web\(\)/,/^\}/' "$RUN_SH")"
eval "$PREDICATE_CODE"
LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=other expect_failure \
    "predicate rejects supervised non-simple profile" loki_is_supervised_simple_web
LOKI_SUPERVISED_BUILD=0 LOKI_BUILD_PROFILE=simple-web expect_failure \
    "predicate rejects unsupervised simple profile" loki_is_supervised_simple_web
LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web expect_success \
    "predicate accepts exact conjunction" loki_is_supervised_simple_web

SPEC_BIND_CODE="$(awk '/^_loki_bind_supervised_spec_sha\(\)/,/^\}/' "$RUN_SH")"
eval "$SPEC_BIND_CODE"
log_error() { :; }
SPEC_FILE="$TMPROOT/spec.md"
printf 'Build the requested app.\n' > "$SPEC_FILE"
unset LOKI_SPEC_SHA256
LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
    expect_success "runner derives the immutable spec binding when an older supervisor omits it" \
    _loki_bind_supervised_spec_sha "$SPEC_FILE"
EXPECTED_SPEC_SHA="$(shasum -a 256 "$SPEC_FILE" | awk '{print $1}')"
[ "${LOKI_SPEC_SHA256:-}" = "$EXPECTED_SPEC_SHA" ] \
    && ok "derived spec binding matches the exact start bytes" \
    || bad "derived spec binding does not match the exact start bytes"
LOKI_SPEC_SHA256="$(printf '0%.0s' {1..64})"
LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
    expect_failure "runner rejects a conflicting supervisor spec binding" \
    _loki_bind_supervised_spec_sha "$SPEC_FILE"
unset LOKI_SPEC_SHA256

PROFILE_CODE="$(awk '/^loki_is_supervised_simple_web\(\)/,/^loki_apply_build_profile$/' "$RUN_SH")"
PROFILE_OUT="$(env -i PATH="$PATH" PROJECT_DIR="$ROOT" PROFILE_CODE="$PROFILE_CODE" \
    LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web LOKI_SESSION_MODEL=haiku \
    bash -c 'eval "$PROFILE_CODE"; for name in \
LOKI_SESSION_MODEL LOKI_MAX_TIER LOKI_MODEL_OVERRIDE LOKI_ADVISOR_MODEL \
LOKI_GRILL_MODEL LOKI_CLAUDE_MODEL_PLANNING LOKI_CLAUDE_MODEL_DEVELOPMENT \
LOKI_CLAUDE_MODEL_FAST LOKI_SDK_COUNCIL_MODEL LOKI_SDK_GRILL_MODEL \
LOKI_SDK_JUDGE_MODEL LOKI_SDK_PRD_ENRICH_MODEL LOKI_SDK_REVIEW_MODEL \
LOKI_MAX_ITERATIONS LOKI_MAX_RETRIES LOKI_PROVIDER_CALL_TIMEOUT \
LOKI_PROVIDER_IDLE_TIMEOUT \
LOKI_DRAFT_EFFORT LOKI_REVIEW_CALL_TIMEOUT LOKI_REVIEW_EFFORT LOKI_REVIEW_RETRY \
LOKI_REVIEW_JSON_SCHEMA LOKI_REVIEW_REQUIREMENTS_ONLY LOKI_GATE_DEVILS_ADVOCATE LOKI_GATE_TIMEOUT LOKI_CAVEMAN \
LOKI_DEPENDENCY_SETUP_TIMEOUT \
LOKI_CAVEMAN_AUTO_BOOTSTRAP LOKI_PRD_ENRICH LOKI_COUNCIL_MODEL_VOTERS \
LOKI_PHASE_UNIT_TESTS LOKI_PHASE_E2E_TESTS LOKI_PHASE_CODE_REVIEW \
LOKI_PHASE_SECURITY LOKI_PHASE_ACCESSIBILITY LOKI_EVIDENCE_GATE LOKI_PROOF_GATE; do \
printf "%s=%s\n" "$name" "${!name-}"; done')"
profile_value() { printf '%s\n' "$PROFILE_OUT" | awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}'; }
for name in LOKI_SESSION_MODEL LOKI_MAX_TIER LOKI_MODEL_OVERRIDE \
    LOKI_ADVISOR_MODEL LOKI_GRILL_MODEL LOKI_CLAUDE_MODEL_PLANNING \
    LOKI_CLAUDE_MODEL_DEVELOPMENT LOKI_CLAUDE_MODEL_FAST; do
    [ "$(profile_value "$name")" = "haiku" ] && ok "$name pinned to haiku" || bad "$name not pinned to haiku"
done
SDK_HAIKU="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["providers"]["claude"]["cli_aliases"]["haiku"])' "$ROOT/providers/model_catalog.json")"
for name in LOKI_SDK_COUNCIL_MODEL LOKI_SDK_GRILL_MODEL LOKI_SDK_JUDGE_MODEL \
    LOKI_SDK_PRD_ENRICH_MODEL LOKI_SDK_REVIEW_MODEL; do
    [ "$(profile_value "$name")" = "$SDK_HAIKU" ] && ok "$name pinned to Haiku ID" || bad "$name not pinned to Haiku ID"
done
for pair in LOKI_MAX_ITERATIONS=2 LOKI_MAX_RETRIES=2 LOKI_PROVIDER_CALL_TIMEOUT=240 \
    LOKI_PROVIDER_IDLE_TIMEOUT=60 \
    LOKI_DRAFT_EFFORT=medium \
    LOKI_REVIEW_CALL_TIMEOUT=90 LOKI_REVIEW_EFFORT=low LOKI_REVIEW_RETRY=0 \
    LOKI_REVIEW_JSON_SCHEMA=off LOKI_REVIEW_REQUIREMENTS_ONLY=1 LOKI_GATE_DEVILS_ADVOCATE=false \
    LOKI_GATE_TIMEOUT=60 LOKI_DEPENDENCY_SETUP_TIMEOUT=60 LOKI_CAVEMAN=0 \
    LOKI_CAVEMAN_AUTO_BOOTSTRAP=0 LOKI_PRD_ENRICH=0 LOKI_COUNCIL_MODEL_VOTERS=0 \
    LOKI_PHASE_UNIT_TESTS=true LOKI_PHASE_E2E_TESTS=true LOKI_PHASE_CODE_REVIEW=true \
    LOKI_PHASE_SECURITY=true LOKI_PHASE_ACCESSIBILITY=true LOKI_EVIDENCE_GATE=1 LOKI_PROOF_GATE=1; do
    name="${pair%%=*}"; expected="${pair#*=}"
    [ "$(profile_value "$name")" = "$expected" ] && ok "$pair" || bad "$pair"
done

POLICY_DIR="$TMPROOT/policy"
mkdir -p "$POLICY_DIR/.loki"
POLICY_CODE="$(awk '
    /^_loki_write_supervised_simple_web_policy\(\)/ { capture = 1 }
    /^# SDLC Phase Controls/ { capture = 0 }
    capture { print }
' "$RUN_SH")"
(
    TARGET_DIR="$POLICY_DIR"; LOKI_DIR="$POLICY_DIR/.loki"
    PROJECT_DIR="$ROOT"; SCRIPT_DIR="$ROOT/autonomy"
    LOKI_SUPERVISED_BUILD=1; LOKI_BUILD_PROFILE=simple-web; LOKI_SESSION_MODEL=haiku
    # The probe VERSION values are literal strings, not command output; quote
    # them so shellcheck does not read the bare word as the `test` builtin.
    _LOKI_NODE_PROBE_STATUS=available; _LOKI_NODE_PROBE_VERSION="test"
    _LOKI_NPM_PROBE_STATUS=available; _LOKI_NPM_PROBE_VERSION="test"
    log_info() { :; }
    eval "$PROFILE_CODE"
    eval "$POLICY_CODE"
    _loki_write_supervised_simple_web_policy
)
if python3 - "$POLICY_DIR/.loki/state/execution-policy.json" <<'PYEOF'
import json, sys
limits = json.load(open(sys.argv[1], encoding="utf-8"))["limits"]
assert limits["attempts"] == 2, limits
assert limits["provider_idle_seconds"] == 60, limits
assert limits["provider_hard_seconds"] == 240, limits
assert "retries" not in limits, limits
assert "provider_seconds" not in limits, limits
PYEOF
then
    ok "execution policy persists attempt, idle lease, and hard cap semantics"
else
    bad "execution policy deadline semantics are incorrect"
fi

BRIEF_CODE="$(awk '/^_loki_supervised_actionable_brief\(\)/,/^\}/' "$RUN_SH")"
eval "$BRIEF_CODE"
BRIEF_PRD="$TMPROOT/actionable-prd.md"
INJECTION_MARKER="$TMPROOT/prd-shell-injection"
printf '%s\n' \
    '# DESIGN SYSTEM DIRECTIVE' \
    'Write DESIGN.md before touching UI.' \
    '--- END DESIGN SYSTEM DIRECTIVE ---' \
    '# Atlas Notes' \
    'Build the prompt-specific primary page first.' \
    "\$(touch \"$INJECTION_MARKER\")" > "$BRIEF_PRD"
ACTIONABLE_BRIEF="$(_loki_supervised_actionable_brief "$BRIEF_PRD")"
if grep -q 'Build the prompt-specific primary page first.' <<< "$ACTIONABLE_BRIEF" \
   && grep -qF "\$(touch \"$INJECTION_MARKER\")" <<< "$ACTIONABLE_BRIEF" \
   && ! grep -q 'Write DESIGN.md before touching UI.' <<< "$ACTIONABLE_BRIEF" \
   && [ ! -e "$INJECTION_MARKER" ]; then
    ok "actionable brief preserves post-directive user content without shell evaluation"
else
    bad "actionable brief included the design directive, altered user content, or evaluated shell text"
fi

SOURCE_HINTS_CODE="$(awk '/^_loki_supervised_source_hints\(\)/,/^\}/' "$RUN_SH")"
FAILURE_CONTEXT_CODE="$(awk '/^_loki_supervised_failure_context\(\)/,/^\}/' "$RUN_SH")"
PROMPT_CODE="$(awk '/^_loki_build_supervised_simple_web_prompt\(\)/,/^\}/' "$RUN_SH")"
eval "$SOURCE_HINTS_CODE"
eval "$FAILURE_CONTEXT_CODE"
eval "$PROMPT_CODE"
PROMPT_WORKSPACE="$TMPROOT/prompt-workspace"
mkdir -p "$PROMPT_WORKSPACE/src/views"
printf '{"scripts":{"build":"vite build"},"devDependencies":{"vite":"latest"}}\n' > "$PROMPT_WORKSPACE/package.json"
printf '<main id="root"></main><script type="module" src="/src/main.tsx"></script>\n' > "$PROMPT_WORKSPACE/index.html"
printf '%s\n' \
    'import { createRoot } from "react-dom/client";' \
    'import App from "./views/Home";' \
    'createRoot(document.getElementById("root")!).render(<App />);' > "$PROMPT_WORKSPACE/src/main.tsx"
printf '%s\n' \
    'import "./home.css";' \
    'export default function Home() { return <main>Reachable</main> }' > "$PROMPT_WORKSPACE/src/views/Home.tsx"
printf 'body { margin: 0; }\n' > "$PROMPT_WORKSPACE/src/views/home.css"
printf 'import Home from "./Home"; void Home;\n' > "$PROMPT_WORKSPACE/src/views/Home.test.tsx"
printf 'export default function App() { return <main>Stale decoy</main> }\n' > "$PROMPT_WORKSPACE/src/App.tsx"
printf 'body { color: red; }\n' > "$PROMPT_WORKSPACE/src/index.css"
SUPERVISED_PROMPT="$({ TARGET_DIR="$PROMPT_WORKSPACE"; _loki_build_supervised_simple_web_prompt 0 "$BRIEF_PRD" 1; })"
if grep -q 'primary_rendered_source=src/views/Home.tsx' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'primary_stylesheet=src/views/home.css' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'primary_test=src/views/Home.test.tsx' <<< "$SUPERVISED_PROMPT" \
   && ! grep -q 'primary_rendered_source=src/App.tsx' <<< "$SUPERVISED_PROMPT" \
   && ! grep -q 'primary_stylesheet=src/index.css' <<< "$SUPERVISED_PROMPT" \
   && grep -q '<actionable_user_brief>' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Build the prompt-specific primary page first.' <<< "$SUPERVISED_PROMPT" \
   && ! grep -q 'CONTINUITY' <<< "$SUPERVISED_PROMPT" \
   && ! grep -q 'generated-prd' <<< "$SUPERVISED_PROMPT" \
   && ! grep -q 'RALPH WIGGUM' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Source hints describe existing scaffold files but never authorize keeping one that conflicts with the user brief' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'valid style element when external stylesheets are disallowed' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'write no more than 4,000 characters of coherent responsive styles before replacing the rendered placeholder' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'write no more than 6,000 characters to the primary rendered source' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Empty translucent shapes, generic gradient blobs, and blank frames do not qualify' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'If primary_test is detected, read it now, update it once' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Implement every section and interaction explicitly named in the actionable user brief' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'give every visible button its stated effect' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'does not supply the commercial facts inside it' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Do not use real company names or realistic person names as placeholders' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Never start a watch-mode test process' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Do not install or upgrade dependencies' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'touch .loki/signals/COMPLETION_REQUESTED' <<< "$SUPERVISED_PROMPT" \
   && grep -q 'Do not launch a development server or browser' <<< "$SUPERVISED_PROMPT"; then
    ok "dedicated prompt supplies source hints without the generic discovery loop"
else
    bad "dedicated prompt omitted source hints or retained generic discovery instructions"
fi

VITE_SEED="$TMPROOT/vite-seed"
mkdir -p "$VITE_SEED/src"
printf '{"scripts":{"build":"vite build"}}\n' > "$VITE_SEED/package.json"
printf '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n' > "$VITE_SEED/index.html"
printf '%s\n' 'import App from "./App";' 'createRoot(root).render(<App />);' > "$VITE_SEED/src/main.tsx"
printf '%s\n' 'import "./styles.css";' 'export default function App() { return <main /> }' > "$VITE_SEED/src/App.tsx"
printf 'main {}\n' > "$VITE_SEED/src/styles.css"
printf 'void 0;\n' > "$VITE_SEED/src/App.test.tsx"
VITE_HINTS="$({ TARGET_DIR="$VITE_SEED"; _loki_supervised_source_hints; })"
if grep -q '^primary_rendered_source=src/App.tsx$' <<< "$VITE_HINTS" \
   && grep -q '^primary_stylesheet=src/styles.css$' <<< "$VITE_HINTS" \
   && grep -q '^primary_test=src/App.test.tsx$' <<< "$VITE_HINTS"; then
    ok "source hints follow the seeded Vite HTML and main import chain"
else
    bad "source hints did not follow the seeded Vite HTML and main import chain"
fi

NEXT_APP="$TMPROOT/next-app"
mkdir -p "$NEXT_APP/app"
printf '{"dependencies":{"next":"latest"}}\n' > "$NEXT_APP/package.json"
printf 'export default function Page() { return <main /> }\n' > "$NEXT_APP/app/page.tsx"
printf '%s\n' 'import "./globals.css";' 'export default function Layout({ children }) { return children }' > "$NEXT_APP/app/layout.tsx"
printf 'body {}\n' > "$NEXT_APP/app/globals.css"
printf 'void 0;\n' > "$NEXT_APP/app/page.test.tsx"
NEXT_APP_HINTS="$({ TARGET_DIR="$NEXT_APP"; _loki_supervised_source_hints; })"
if grep -q '^primary_rendered_source=app/page.tsx$' <<< "$NEXT_APP_HINTS" \
   && grep -q '^primary_stylesheet=app/globals.css$' <<< "$NEXT_APP_HINTS" \
   && grep -q '^primary_test=app/page.test.tsx$' <<< "$NEXT_APP_HINTS"; then
    ok "source hints prove a Next app route through its declared framework and layout"
else
    bad "source hints did not prove the Next app route and layout stylesheet"
fi

NEXT_PAGES="$TMPROOT/next-pages"
mkdir -p "$NEXT_PAGES/pages"
printf '{"scripts":{"dev":"next dev"}}\n' > "$NEXT_PAGES/package.json"
printf 'export default function Index() { return <main /> }\n' > "$NEXT_PAGES/pages/index.jsx"
printf '%s\n' 'import "./global.css";' 'export default function App({ Component, pageProps }) { return <Component {...pageProps} /> }' > "$NEXT_PAGES/pages/_app.jsx"
printf 'body {}\n' > "$NEXT_PAGES/pages/global.css"
NEXT_PAGES_HINTS="$({ TARGET_DIR="$NEXT_PAGES"; _loki_supervised_source_hints; })"
if grep -q '^primary_rendered_source=pages/index.jsx$' <<< "$NEXT_PAGES_HINTS" \
   && grep -q '^primary_stylesheet=pages/global.css$' <<< "$NEXT_PAGES_HINTS"; then
    ok "source hints prove a Next pages route and its reachable app stylesheet"
else
    bad "source hints did not prove the Next pages route and app stylesheet"
fi

STATIC_SITE="$TMPROOT/static-site"
mkdir -p "$STATIC_SITE/assets"
printf '<link rel="stylesheet" href="/assets/site.css"><main>Static</main>\n' > "$STATIC_SITE/index.html"
printf 'main {}\n' > "$STATIC_SITE/assets/site.css"
STATIC_HINTS="$({ TARGET_DIR="$STATIC_SITE"; _loki_supervised_source_hints; })"
if grep -q '^primary_rendered_source=index.html$' <<< "$STATIC_HINTS" \
   && grep -q '^primary_stylesheet=assets/site.css$' <<< "$STATIC_HINTS"; then
    ok "source hints prove a static HTML entrypoint and linked stylesheet"
else
    bad "source hints did not prove the static HTML entrypoint and stylesheet"
fi

UNPROVEN_SITE="$TMPROOT/unproven-site"
mkdir -p "$UNPROVEN_SITE/src"
printf '{"scripts":{"build":"vite build"}}\n' > "$UNPROVEN_SITE/package.json"
printf '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n' > "$UNPROVEN_SITE/index.html"
printf '%s\n' 'import App from "@/App";' 'createRoot(root).render(<App />);' > "$UNPROVEN_SITE/src/main.tsx"
printf 'export default function App() { return <main>Decoy</main> }\n' > "$UNPROVEN_SITE/src/App.tsx"
printf 'body {}\n' > "$UNPROVEN_SITE/src/index.css"
UNPROVEN_HINTS="$({ TARGET_DIR="$UNPROVEN_SITE"; _loki_supervised_source_hints; })"
if grep -q '^primary_rendered_source=not-detected$' <<< "$UNPROVEN_HINTS" \
   && grep -q '^primary_stylesheet=not-detected$' <<< "$UNPROVEN_HINTS" \
   && grep -q '^primary_test=not-detected$' <<< "$UNPROVEN_HINTS"; then
    ok "source hints fail closed instead of selecting stale decoy files"
else
    bad "source hints guessed stale files when render reachability was unproven"
fi

CURRENT_BRIEF_PRD="$TMPROOT/lokruit-prd.md"
python3 - "$CURRENT_BRIEF_PRD" <<'PYEOF'
import sys
from pathlib import Path

marker = "--- END AUTONOMI PRODUCT QUALITY CONTRACT ---\n"
contract = "# AUTONOMI PRODUCT QUALITY CONTRACT\n" + ("Contract padding.\n" * 420) + marker
brief = (
    "# Lokruit Forward-Deployed Talent\n"
    "Required sections: talent hero, operating model, candidate profiles, and contact.\n"
    "Required interactions: navigation, candidate filters, profile details, and contact form.\n"
)
last_requirement = "\nLokruit final requirement: preserve the complete contact flow at the end of the brief."
target_size = 12 * 1024
padding_size = target_size - len(contract + brief + last_requirement)
assert padding_size > 0
spec = contract + brief + ("x" * padding_size) + last_requirement
assert len(spec.encode("utf-8")) == target_size
Path(sys.argv[1]).write_text(spec, encoding="utf-8")
PYEOF
LOKRUIT_PROMPT="$({ TARGET_DIR="$PROMPT_WORKSPACE"; _loki_build_supervised_simple_web_prompt 0 "$CURRENT_BRIEF_PRD" 1; })"
if [ "$(wc -c < "$CURRENT_BRIEF_PRD" | tr -d ' ')" = "12288" ] \
   && grep -q 'Required sections: talent hero, operating model, candidate profiles, and contact.' <<< "$LOKRUIT_PROMPT" \
   && grep -q 'Required interactions: navigation, candidate filters, profile details, and contact form.' <<< "$LOKRUIT_PROMPT" \
   && grep -q 'Lokruit final requirement: preserve the complete contact flow at the end of the brief.' <<< "$LOKRUIT_PROMPT" \
   && ! grep -q 'Contract padding.' <<< "$LOKRUIT_PROMPT"; then
    ok "current 12 KiB SaaS spec reaches the Lokruit iteration prompt without truncation"
else
    bad "current SaaS marker or brief cap dropped Lokruit requirements"
fi

mkdir -p "$PROMPT_WORKSPACE/.loki/quality/reviews/review-1"
printf '%s\n' 'code_review,' > "$PROMPT_WORKSPACE/.loki/quality/gate-failures.txt"
printf '%s\n' 'VERDICT: FAIL' 'FINDINGS:' '- [High] supported issue (src/App.tsx:1)' > "$PROMPT_WORKSPACE/.loki/quality/reviews/review-1/eng-frontend.txt"
RETRY_PROMPT="$({ TARGET_DIR="$PROMPT_WORKSPACE"; _loki_build_supervised_simple_web_prompt 0 "$BRIEF_PRD" 2; })"
if grep -q '<previous_gate_failures trust="untrusted-diagnostics">' <<< "$RETRY_PROMPT" \
   && grep -q 'code_review' <<< "$RETRY_PROMPT" \
   && grep -q 'supported issue' <<< "$RETRY_PROMPT" \
   && grep -q 'Verify every diagnostic against current source' <<< "$RETRY_PROMPT"; then
    ok "retry prompt receives bounded untrusted gate diagnostics"
else
    bad "retry prompt omitted prior gate diagnostics"
fi
if python3 - "$RUN_SH" <<'PYEOF'
import sys
source = open(sys.argv[1], encoding="utf-8").read()
start = source.index("    while [ $retry -lt $MAX_RETRIES ]; do")
end = source.index('        track_iteration_start "$ITERATION_COUNT"', start)
attempt = source[start:end]
assert attempt.index("if check_max_iterations; then") < attempt.index("((ITERATION_COUNT++))")
assert 'save_state "$retry" "max_iterations_reached" 20' in attempt
assert "return 20" in attempt
PYEOF
then
    ok "iteration ceiling permits both attempts and fails closed at the cap"
else
    bad "iteration ceiling stops before the second attempt"
fi

COMPLETION_CODE="$(awk '/^_loki_supervised_completion_gates_pass\(\)/,/^\}/' "$RUN_SH")"
completion_case() {
    local json="$1" marker="$2" failures="$3" dir="$TMPROOT/completion-$RANDOM"
    mkdir -p "$dir/.loki/quality"
    [ "$json" = missing ] || printf '%s\n' "$json" > "$dir/.loki/quality/test-results.json"
    [ "$marker" = missing ] || printf '%s\n' "$marker" > "$dir/.loki/quality/.test-results.iter"
    (
        TARGET_DIR="$dir"; ITERATION_COUNT=2; gate_failures="$failures"
        LOKI_SUPERVISED_BUILD=1; LOKI_BUILD_PROFILE=simple-web
        log_error() { :; }
        council_checklist_gate() { return 0; }
        council_heldout_gate() { return 0; }
        council_evidence_gate() { return 0; }
        council_assumption_ledger_gate() { return 0; }
        eval "$COMPLETION_CODE"
        _loki_supervised_completion_gates_pass "$failures"
    )
}
VALID_TESTS='{"runner":"vitest","pass":true,"command":"npm test","exit_code":0}'
expect_success "fresh real passing tests allow deterministic gates" completion_case "$VALID_TESTS" 2 ""
expect_failure "production build failure blocks deterministic completion" completion_case "$VALID_TESTS" 2 "production_build,"
expect_failure "static analysis failure blocks deterministic completion" completion_case "$VALID_TESTS" 2 "static_analysis,"
expect_failure "runner none blocks supervised completion" completion_case '{"runner":"none","pass":"inconclusive","command":null,"exit_code":null}' 2 ""
expect_failure "missing test command blocks supervised completion" completion_case '{"runner":"vitest","pass":true,"command":null,"exit_code":0}' 2 ""
expect_failure "nonzero test exit blocks supervised completion" completion_case '{"runner":"vitest","pass":true,"command":"npm test","exit_code":1}' 2 ""
expect_failure "stale test evidence blocks supervised completion" completion_case "$VALID_TESTS" 1 ""

FAKE_BIN="$TMPROOT/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'FAKE'
#!/bin/sh
printf '%s\n' "$@" > "$FAKE_CLAUDE_ARGS"
printf 'VERDICT: PASS\nFINDINGS:\n'
FAKE
chmod +x "$FAKE_BIN/claude"
DISPATCH_CODE="$(awk '/^_dispatch_reviewer\(\)/,/^\}/' "$RUN_SH")"
(
    PATH="$FAKE_BIN:$PATH"; export PATH
    FAKE_CLAUDE_ARGS="$TMPROOT/claude-args"; export FAKE_CLAUDE_ARGS
    PROVIDER_NAME=claude; PROJECT_DIR="$TMPROOT"; SCRIPT_DIR="$ROOT/autonomy"
    LOKI_SUPERVISED_BUILD=1; LOKI_BUILD_PROFILE=simple-web
    LOKI_ADVISOR_MODEL=haiku; LOKI_REVIEW_JSON_SCHEMA=off
    LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}'
    _loki_supervised_claude_isolation_ready() { return 0; }
    loki_claude_flag_supported() { return 0; }
    loki_review_guard_enabled() { return 1; }
    loki_review_allowlist_enabled() { return 1; }
    _loki_with_deadline() { shift; "$@"; }
    _loki_with_deadline_stdin_text() {
        local _seconds="$1" _input="$2"
        shift 2
        printf '%s' "$_input" | "$@"
    }
    log_error() { :; }
    eval "$DISPATCH_CODE"
    _dispatch_reviewer "review" "$TMPROOT/review-output"
)
python3 - "$TMPROOT/claude-args" <<'PYEOF'
import sys
args = open(sys.argv[1], encoding="utf-8").read().splitlines()
def pair(flag, value):
    return any(args[i:i + 2] == [flag, value] for i in range(len(args) - 1))
assert pair("--model", "haiku")
assert pair("--effort", "medium")
assert pair("--settings", '{"hooks":{}}')
assert pair("--setting-sources", "")
assert "review" not in args
assert "-p" in args
assert "--safe-mode" not in args
assert "--bare" not in args
PYEOF
if [ "$?" -eq 0 ]; then ok "fake reviewer CLI receives isolated Haiku argv"; else bad "fake reviewer CLI argv is not isolated"; fi

grep -q '_loki_claude_argv+=("--setting-sources" "" "--disallowedTools" "Task")' "$RUN_SH" \
    && ok "main Claude argv isolates settings, preserves the trusted hook, and denies Task" || bad "main Claude isolation argv missing"
grep -q '_loki_build_supervised_simple_web_prompt "$retry" "$prd_path" "$ITERATION_COUNT"' "$RUN_SH" \
    && grep -q 'prompt=$(build_prompt "$retry" "$prd_path" "$ITERATION_COUNT")' "$RUN_SH" \
    && python3 - "$RUN_SH" <<'PYEOF'
import sys

source = open(sys.argv[1], encoding="utf-8").read()
start = source.index("        local prompt\n", source.index("# Main Autonomous Loop"))
end = source.index("\n\n        # P2-2", start)
block = source[start:end]
assert block.index("if loki_is_supervised_simple_web; then") < block.index("prompt=$(_loki_build_supervised_simple_web_prompt")
assert block.index("else") < block.index("prompt=$(build_prompt")
PYEOF
if [ "$?" -eq 0 ]; then
    ok "main loop replaces the generic prompt for supervised simple-web only"
else
    bad "main loop does not isolate the supervised prompt from generic discovery"
fi
grep -q '_loki_effort="${LOKI_DRAFT_EFFORT:-medium}"' "$RUN_SH" \
    && grep -q '_loki_codex_effort="${LOKI_DRAFT_EFFORT:-medium}"' "$RUN_SH" \
    && ok "supervised Claude and Codex use medium draft effort" || bad "provider draft effort override missing"

if python3 - "$RUN_SH" <<'PYEOF'
import sys

source = open(sys.argv[1], encoding="utf-8").read()
terminal = source.index(
    'Review verification remained unavailable after the bounded review-only retry.'
)
terminal = source.rfind('if [ "$_stg_ok" = "fail" ]', 0, terminal)
next_iteration = source.index('log_step "Starting next iteration..."', terminal)
block = source[terminal:next_iteration]
assert '"${_LOKI_REVIEW_FAILURE_KIND:-}" = "infrastructure_inconclusive"' in block
assert '"implementation_retry=false"' in block
assert 'save_state "$retry" "failed" 20' in block
assert "return 20" in block
PYEOF
then
    ok "review infrastructure exhaustion terminates before another implementation iteration"
else
    bad "review infrastructure exhaustion can still spend another implementation iteration"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
