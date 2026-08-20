#!/usr/bin/env bash
# Stub-only regression coverage for opencode start routing and dispatch.
# shellcheck disable=SC2016,SC2034

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-opencode-start.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
ok() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "=== opencode start routing and dispatch ==="

# Installed-package-shaped fixture around the real shim. The final Bash and
# Bun boundaries only record their route; neither runtime nor provider runs.
mkdir -p "$TMP/pkg/bin" "$TMP/pkg/autonomy" "$TMP/pkg/loki-ts/dist" "$TMP/fake-bin"
cp "$ROOT/bin/loki" "$TMP/pkg/bin/loki"
printf 'placeholder\n' > "$TMP/pkg/loki-ts/dist/loki.js"
cat > "$TMP/pkg/autonomy/loki" <<'EOF'
#!/usr/bin/env bash
printf 'BASH\n' > "$LOKI_ROUTE_CAPTURE"
EOF
cat > "$TMP/fake-bin/bun" <<'EOF'
#!/usr/bin/env bash
printf 'BUN\n' > "$LOKI_ROUTE_CAPTURE"
EOF
chmod +x "$TMP/pkg/bin/loki" "$TMP/pkg/autonomy/loki" "$TMP/fake-bin/bun"

route_assert() {
    local label="$1" work="$2"
    shift 2
    if (
        cd "$work" || exit 1
        "$@"
    ) >/dev/null 2>&1 && grep -qx BASH "$work/capture" 2>/dev/null; then
        ok "$label opencode selection routes start to Bash"
    else
        bad "$label opencode selection did not route start to Bash"
    fi
}

common_env=(env PATH="$TMP/fake-bin:$PATH" HOME="$TMP/home"
    LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_SDK_LOOP=1)

work="$TMP/cli"
mkdir -p "$work"
route_assert CLI "$work" "${common_env[@]}" LOKI_PROVIDER=claude \
    LOKI_ROUTE_CAPTURE="$work/capture" "$TMP/pkg/bin/loki" \
    start --provider opencode --yes ./prd.md

work="$TMP/env"
mkdir -p "$work"
route_assert environment "$work" "${common_env[@]}" LOKI_PROVIDER=opencode \
    LOKI_ROUTE_CAPTURE="$work/capture" "$TMP/pkg/bin/loki" \
    start --yes ./prd.md

work="$TMP/saved"
mkdir -p "$work/.loki/state"
printf 'opencode\n' > "$work/.loki/state/provider"
route_assert saved-provider "$work" env -u LOKI_PROVIDER \
    PATH="$TMP/fake-bin:$PATH" HOME="$TMP/home" \
    LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_SDK_LOOP=1 \
    LOKI_ROUTE_CAPTURE="$work/capture" "$TMP/pkg/bin/loki" \
    start --yes ./prd.md

# Source only the real dispatch helpers, not run.sh's executable entrypoint.
extract_function() {
    local name="$1" source_file="$2" output_file="$3" start end
    start="$(grep -n "^${name}()" "$source_file" | head -1 | cut -d: -f1)"
    end="$(awk -v s="$start" 'NR>s && /^}/{print NR; exit}' "$source_file")"
    sed -n "${start},${end}p" "$source_file" >> "$output_file"
}
HELPERS="$TMP/helpers.sh"
extract_function _loki_provider_pipeline_exit_code "$ROOT/autonomy/run.sh" "$HELPERS"
extract_function _loki_invoke_argv_provider "$ROOT/autonomy/run.sh" "$HELPERS"
# shellcheck source=/dev/null
source "$HELPERS"

# Execute the real provider case statement too. This prevents a helper-only
# test from staying green if the opencode arm is removed or falls through to
# the unknown-provider branch later.
dispatch_start="$(grep -n 'case "${PROVIDER_NAME:-claude}" in' "$ROOT/autonomy/run.sh" | tail -1 | cut -d: -f1)"
dispatch_end="$(awk -v s="$dispatch_start" 'NR>s && /^        esac$/{print NR; exit}' "$ROOT/autonomy/run.sh")"
DISPATCH_CASE="$TMP/dispatch-case.sh"
{
    printf 'run_real_dispatch_case() {\n'
    sed -n "${dispatch_start},${dispatch_end}p" "$ROOT/autonomy/run.sh"
    printf '}\n'
} > "$DISPATCH_CASE"
# shellcheck source=/dev/null
source "$DISPATCH_CASE"

export LOKI_OPENCODE_MODEL='fixture/model-v1'
# ROOT is resolved above; this is the real provider.
# shellcheck disable=SC1091
source "$ROOT/providers/opencode.sh"
log_error() { printf 'ERROR: %s\n' "$*" >&2; }
_loki_with_deadline() { shift; "$@"; }

cat > "$TMP/fake-bin/opencode" <<'EOF'
#!/usr/bin/env bash
python3 - "$OPENCODE_ARGV_CAPTURE" "$@" <<'PY'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(sys.argv[2:], handle)
PY
printf 'stub provider output\n'
exit "${OPENCODE_STUB_RC:-0}"
EOF
chmod +x "$TMP/fake-bin/opencode"
export PATH="$TMP/fake-bin:$PATH"

# Literal shell syntax is part of the prompt oracle.
# shellcheck disable=SC2016
prompt='keep  spaces; $HOME and "quotes" literal'
export OPENCODE_ARGV_CAPTURE="$TMP/argv.json" OPENCODE_STUB_RC=0
for f in provider.log agent.log iteration.log; do : > "$TMP/$f"; done
PROVIDER_NAME=opencode
CURRENT_TIER=development
log_file="$TMP/provider.log"
agent_log="$TMP/agent.log"
iter_output="$TMP/iteration.log"
exit_code=0
run_real_dispatch_case >/dev/null
if [ "$exit_code" -eq 0 ] && python3 - "$TMP/argv.json" "$prompt" <<'PY'
import json, sys
actual = json.load(open(sys.argv[1], encoding="utf-8"))
expected = ["run", "--auto", "--model", "fixture/model-v1", sys.argv[2]]
raise SystemExit(0 if actual == expected else 1)
PY
then
    ok "real main-loop arm preserves exact prompt, --auto, and model argv"
else
    bad "real main-loop arm changed opencode argv or returned $exit_code"
fi

if grep -qx 'stub provider output' "$TMP/provider.log" \
   && grep -qx 'stub provider output' "$TMP/agent.log" \
   && grep -qx 'stub provider output' "$TMP/iteration.log"; then
    ok "output is tee'd to every main-loop log"
else
    bad "output was not tee'd to every main-loop log"
fi

export OPENCODE_STUB_RC=37
CURRENT_TIER=fast
exit_code=0
run_real_dispatch_case >/dev/null
if [ "$exit_code" -eq 37 ]; then
    ok "provider-stage nonzero exit propagates through deadline and tee"
else
    bad "provider-stage exit 37 became $exit_code"
fi

printf '\n  Passed: %s   Failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
