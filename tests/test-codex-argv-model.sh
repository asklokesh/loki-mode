#!/usr/bin/env bash
# provider_invoke_argv must not send an effort level as a model name.
#
# THE BUG THIS GUARDS. For Codex, provider_get_tier_param returns an EFFORT
# LEVEL (xhigh/high/low), not a model name -- the BUG-PROV-012 note in
# providers/codex.sh says so explicitly. provider_invoke_argv passed it to
# --model anyway, so every argv-based invocation sent `--model high` and the API
# rejected it outright:
#   400 invalid_request_error: The 'high' model is not supported when using
#   Codex with a ChatGPT account.
#
# WHY IT MATTERED MORE THAN A NORMAL BUG. provider_invoke() was fine, so the
# BROKEN path was the argv seam -- which exists precisely so a call can be
# wrapped in `timeout` (a shell function cannot be exec'd by timeout). A hung
# provider therefore could not be bounded without also breaking the invocation,
# and the failure was silent: five measured trials produced no artifact while
# looking like slow runs (96s/6s/5s/4s/5s).
#
# Runs offline. It inspects the constructed argv rather than invoking codex, so
# it needs no auth and cannot rot the way a login-dependent test would.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

_argv() {  # $1 = tier
  PROVIDER_NAME=codex bash -c "
    source '$REPO_ROOT/providers/loader.sh' >/dev/null 2>&1 || true
    load_provider codex >/dev/null 2>&1 || true
    provider_invoke_argv '$1' 'do a thing'
    printf '%s\n' \"\${_LOKI_INVOKE_ARGV[*]}\"
    printf 'EFFORT=%s\n' \"\${CODEX_MODEL_REASONING_EFFORT:-}\"
  " 2>/dev/null
}

echo "T1 -- an effort level never reaches --model"
for tier in planning development fast; do
  out=$(_argv "$tier")
  argv=$(printf '%s' "$out" | head -1)
  # The exact shape of the bug: `--model high`, `--model xhigh`, `--model low`.
  if printf '%s' "$argv" | grep -qE -- "--model (xhigh|high|low)\b"; then
    bad "tier=$tier sends an effort level as --model: $argv"
  else
    ok "tier=$tier does not pass an effort level to --model"
  fi
done

echo
echo "T2 -- effort travels in the environment instead"
# It must be EXPORTED, or it is lost across `timeout "\${_LOKI_INVOKE_ARGV[@]}"`,
# which is the only reason this seam exists.
out=$(_argv development)
printf '%s' "$out" | grep -q "EFFORT=high" \
  && ok "development tier exports CODEX_MODEL_REASONING_EFFORT=high" \
  || bad "effort not exported: $(printf '%s' "$out" | tail -1)"
out=$(_argv fast)
printf '%s' "$out" | grep -q "EFFORT=low" \
  && ok "fast tier exports effort=low" \
  || bad "fast tier effort wrong: $(printf '%s' "$out" | tail -1)"

echo
echo "T3 -- an empty model omits the flag rather than sending an empty string"
# CODEX_DEFAULT_MODEL is deliberately empty so codex uses its own current
# default instead of a pinned name that rots. `--model ""` would be a hard error.
argv=$(_argv development | head -1)
if printf '%s' "$argv" | grep -qE -- "--model( |$)" && ! printf '%s' "$argv" | grep -qE -- "--model [^ ]"; then
  bad "argv contains --model with an empty value: $argv"
else
  ok "no empty --model in argv"
fi

# Non-vacuity: the argv must still be a usable codex command, or every
# assertion above passes against an empty array.
printf '%s' "$argv" | grep -q "^codex exec" \
  && ok "non-vacuity: argv is a real codex exec command" \
  || bad "argv is not a codex command: $argv"

echo
echo "T4 -- every provider defining the seam carries the right model flag"
# The codex bug above was a MODEL-FLAG bug, and every provider builds that flag
# independently. This asserts the property across all of them, so a new provider
# cannot regress the class that T1-T3 only guard for codex.
#
# Each entry: provider|expected argv[0]|model flag|how the model is sourced.
# codex is exercised by T1-T3 (its tier param is an effort level, not a model).
_argv_for() {  # $1 = provider, $2 = tier
  PROVIDER_NAME="$1" bash -c "
    source '$REPO_ROOT/providers/loader.sh' >/dev/null 2>&1 || true
    load_provider '$1' >/dev/null 2>&1 || true
    type provider_invoke_argv >/dev/null 2>&1 || { printf 'NOSEAM\n'; exit 0; }
    provider_invoke_argv '$2' 'do a thing'
    printf 'ARGV0=%s\n' \"\${_LOKI_INVOKE_ARGV[0]:-}\"
    # One element per line. Claude's --append-system-prompt value contains
    # NEWLINES, so a flattened \"\${arr[*]}\" gets truncated at the first one by
    # any line-oriented extraction -- which silently hid both the --model flag
    # and the prompt. Emit each element on its own record with a stable prefix.
    for _a in \"\${_LOKI_INVOKE_ARGV[@]}\"; do printf 'ELEM=%s\n' \"\$_a\"; done
    # Expected model comes from resolve_model_for_tier -- the provider's OWN
    # full resolver (base + tier routing + LOKI_MAX_TIER clamp), which is what
    # provider_invoke uses. Comparing against the raw provider_get_tier_param
    # would demand the UNCLAMPED model and thus actively forbid the cost ceiling
    # T4b requires. Providers without that resolver fall back to the tier param.
    if type resolve_model_for_tier >/dev/null 2>&1; then
      printf 'TIERMODEL=%s\n' \"\$(resolve_model_for_tier '$2' 2>/dev/null)\"
    else
      printf 'TIERMODEL=%s\n' \"\$(provider_get_tier_param '$2' 2>/dev/null)\"
    fi
  " 2>/dev/null
}

# Does argv contain <flag> immediately followed by <value>? Operates on the
# per-element ELEM= records, so a multi-line element cannot split a pair.
_argv_has_pair() {  # $1 = out, $2 = flag, $3 = value
  printf '%s\n' "$1" | grep -A1 -xF "ELEM=$2" 2>/dev/null | grep -qxF "ELEM=$3"
}

for spec in "claude|claude|--model" "opencode|opencode|--model" "aider|aider|--model" "cline|cline|-m"; do
  p="${spec%%|*}"; rest="${spec#*|}"; bin="${rest%%|*}"; flag="${rest#*|}"
  out=$(_argv_for "$p" development)

  if printf '%s' "$out" | grep -q '^NOSEAM$'; then
    bad "$p does not define provider_invoke_argv"
    continue
  fi

  argv0=$(printf '%s\n' "$out" | sed -n 's/^ARGV0=//p' | head -1)
  tiermodel=$(printf '%s\n' "$out" | sed -n 's/^TIERMODEL=//p' | head -1)

  # POSITIVE marker, not grep-absence: assert argv[0] is the exact CLI binary.
  # A seam that failed to populate the array yields an empty argv0, which fails
  # here rather than silently passing an "it does not contain X" check.
  [ "$argv0" = "$bin" ] \
    && ok "$p: argv[0] is the $bin binary" \
    || bad "$p: argv[0] is '$argv0', expected '$bin'"

  # The model flag must carry the value provider_get_tier_param resolves, so a
  # provider cannot quietly drop tier routing on the timeout-safe path.
  if [ -n "$tiermodel" ]; then
    _argv_has_pair "$out" "$flag" "$tiermodel" \
      && ok "$p: argv carries '$flag $tiermodel'" \
      || bad "$p: argv missing '$flag $tiermodel'"
  else
    # Empty model must omit the flag entirely; `--model ""` is a hard CLI error.
    printf '%s\n' "$out" | grep -qxF "ELEM=$flag" \
      && bad "$p: emits a bare '$flag' with no value" \
      || ok "$p: empty model omits '$flag'"
  fi

  # The prompt must survive into argv as its OWN element, or every check above
  # passes against an argv that would invoke the CLI with no work to do.
  printf '%s\n' "$out" | grep -qxF 'ELEM=do a thing' \
    && ok "$p: prompt is present in argv" \
    || bad "$p: prompt missing from argv"
done

echo
echo "T4b -- the argv path honours the LOKI_MAX_TIER cost ceiling"
# The argv seam must resolve models through the SAME resolver as provider_invoke.
# A seam that reproduces base+route but skips loki_apply_max_tier_clamp emits
# `--model opus` under LOKI_MAX_TIER=sonnet, silently ignoring the cost ceiling
# on precisely the path used when a call must be bounded. Same shape as the
# codex bug in T1: the timeout-safe seam being the broken one.
maxtier_out=$(PROVIDER_NAME=claude LOKI_MAX_TIER=sonnet bash -c "
  source '$REPO_ROOT/providers/loader.sh' >/dev/null 2>&1 || true
  load_provider claude >/dev/null 2>&1 || true
  provider_invoke_argv development 'do a thing'
  for i in \"\${!_LOKI_INVOKE_ARGV[@]}\"; do
    [ \"\${_LOKI_INVOKE_ARGV[\$i]}\" = '--model' ] && printf 'MODEL=%s\n' \"\${_LOKI_INVOKE_ARGV[\$((i+1))]}\"
  done
  printf 'EXPECT=%s\n' \"\$(resolve_model_for_tier development 2>/dev/null)\"
" 2>/dev/null)
got_model=$(printf '%s\n' "$maxtier_out" | sed -n 's/^MODEL=//p' | head -1)
want_model=$(printf '%s\n' "$maxtier_out" | sed -n 's/^EXPECT=//p' | head -1)
# POSITIVE assertion: a concrete clamped model must be present and must match the
# resolver. An empty got_model fails here rather than passing as "not opus".
if [ -n "$got_model" ] && [ "$got_model" = "$want_model" ]; then
  ok "claude: LOKI_MAX_TIER=sonnet clamps argv to '$got_model'"
else
  bad "claude: argv model is '$got_model', resolver says '$want_model' (max-tier clamp skipped)"
fi

echo
echo "T4c -- operator extra-flags reach the argv path too"
# LOKI_AIDER_FLAGS is a documented knob (CLI --aider-flags) honoured by
# provider_invoke. If the argv seam drops it, operator config applies on the
# normal path and silently vanishes on the timeout-bounded one.
flags_out=$(PROVIDER_NAME=aider LOKI_AIDER_FLAGS="--architect --no-git" bash -c "
  source '$REPO_ROOT/providers/loader.sh' >/dev/null 2>&1 || true
  load_provider aider >/dev/null 2>&1 || true
  provider_invoke_argv development 'do a thing'
  for _a in \"\${_LOKI_INVOKE_ARGV[@]}\"; do printf 'ELEM=%s\n' \"\$_a\"; done
" 2>/dev/null)
for f in --architect --no-git; do
  printf '%s\n' "$flags_out" | grep -qxF "ELEM=$f" \
    && ok "aider: argv carries operator flag '$f'" \
    || bad "aider: argv dropped operator flag '$f'"
done
# The flags must be SEPARATE elements, not one "--architect --no-git" string,
# or aider receives a single unparseable argument.
printf '%s\n' "$flags_out" | grep -qxF 'ELEM=--architect --no-git' \
  && bad "aider: extra flags collapsed into one argv element" \
  || ok "aider: extra flags are separate argv elements"

echo
echo "T5 -- the argv path is what emits, not a fallback exec"
# POSITIVE marker, never grep-absence: a stub CLI on PATH writes a sentinel file
# ONLY when reached via `timeout "${_LOKI_INVOKE_ARGV[@]}"`. If the seam built a
# broken argv, no marker is written and the assertion fails. Checking that
# nothing bad appeared would pass just as happily when the stub never ran.
for p in aider cline; do
  tmp=$(mktemp -d) || { bad "$p: mktemp failed"; continue; }
  bin="$tmp/bin"; mkdir -p "$bin"
  # The stub records its own name plus every argument it received.
  printf '#!/usr/bin/env bash\nprintf "MARKER:%%s ARGS:%%s\\n" "$(basename "$0")" "$*" > "%s/emitted"\n' "$tmp" > "$bin/$p"
  chmod +x "$bin/$p"

  PROVIDER_NAME="$p" PATH="$bin:$PATH" bash -c "
    source '$REPO_ROOT/providers/loader.sh' >/dev/null 2>&1 || true
    load_provider '$p' >/dev/null 2>&1 || true
    provider_invoke_argv fast 'sentinel prompt'
    timeout 10 \"\${_LOKI_INVOKE_ARGV[@]}\" >/dev/null 2>&1
  " >/dev/null 2>&1

  if [ -f "$tmp/emitted" ] && grep -q "MARKER:$p" "$tmp/emitted" 2>/dev/null; then
    ok "$p: argv path executed the real CLI (marker written)"
    grep -q 'sentinel prompt' "$tmp/emitted" \
      && ok "$p: the CLI received the prompt" \
      || bad "$p: CLI ran without the prompt: $(cat "$tmp/emitted")"
  else
    bad "$p: no marker -- argv never reached the CLI through timeout"
  fi
  rm -rf "$tmp"
done

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
