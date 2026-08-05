#!/usr/bin/env bash
# The free on-ramp must stay wired, because it is the answer to "why try this".
#
# WHY IT MATTERS. Codex is the only free on-ramp left since Gemini's free tier
# ended on 2026-06-18. A keyless path that demonstrably completes a build is the
# strongest possible answer to "why would I install this", and it is the
# model-agnostic claim made concrete instead of architectural.
#
# A TIER LABEL IS NOT EVIDENCE. This project pinned codex at "Tier 3" on v0.98
# assumptions while the installed CLI had moved to 0.146.0. What actually
# matters is whether a build completes, so this asserts the WIRING that a real
# measured run depended on -- verified 2026-07-30: 72s, 55,889 tokens, $0 API
# spend, artifact correct, invoked through providers/codex.sh rather than as a
# direct CLI call.
#
# It deliberately does NOT invoke the provider. CI has no ChatGPT auth, and a
# test that needs a login would be skipped forever and rot. It checks the parts
# that break silently: the flags exist on the installed CLI, the provider layer
# exposes the entry point, and the recorded evidence keeps its scope limits.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
note() { echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }

echo "T1 -- the codex provider exposes a usable entry point"
out=$(PROVIDER_NAME=codex bash -c "
  source '$REPO_ROOT/providers/loader.sh' >/dev/null 2>&1 || true
  load_provider codex >/dev/null 2>&1 || true
  declare -f provider_invoke >/dev/null && echo HAVE_INVOKE
  printf 'FLAGS=%s\n' \"\${PROVIDER_AUTONOMOUS_FLAG:-}\"
" 2>/dev/null)
printf '%s' "$out" | grep -q HAVE_INVOKE \
  && ok "provider_invoke is defined after loading codex" \
  || bad "provider_invoke missing -- the free on-ramp cannot be driven"
printf '%s' "$out" | grep -q "FLAGS=exec" \
  && ok "autonomous flags are set (exec ...)" \
  || bad "PROVIDER_AUTONOMOUS_FLAG empty -- codex would run interactively"

echo
echo "T2 -- the flags we ship exist on the INSTALLED codex CLI"
# A pinned flag that the CLI dropped fails at build time, not here, which is the
# worst place to find out. This is why the provider is validated against the
# real binary rather than against documentation.
if command -v codex >/dev/null 2>&1; then
  h=$(codex exec --help 2>&1 || true)
  for f in --sandbox --model; do
    printf '%s' "$h" | grep -q -- "$f" \
      && ok "installed codex accepts $f" \
      || bad "installed codex does NOT accept $f -- provider flags are stale"
  done
else
  note "codex CLI not installed; flag validation skipped"
fi

echo
echo "T3 -- the recorded evidence keeps its scope limits"
A="$REPO_ROOT/benchmarks/results/free-onramp.json"
if [ -f "$A" ]; then
  python3 -c "
import json,sys
d=json.load(open('$A'))
r=d.get('run',{})
assert d.get('not_claimed'), 'missing not_claimed'
assert r.get('api_cost_usd') == 0.0, 'api_cost_usd should be 0.0'
assert r.get('artifact_verified'), 'no artifact verification recorded'
assert 'provider_invoke' in r.get('invoked_via',''), 'must record it went through the provider layer'
" 2>/dev/null \
    && ok "artifact records scope, zero API cost, artifact check, and the invocation path" \
    || bad "artifact lost a required field (scope limit, cost, artifact check, or path)"
  # A run recorded as going through the CLI directly would not prove OUR layer works.
  grep -q "not a direct CLI call" "$A" \
    && ok "records that it went through the provider layer, not the raw CLI" \
    || bad "does not distinguish provider-layer from raw-CLI invocation"
else
  note "free-onramp.json absent"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
