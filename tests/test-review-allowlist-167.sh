#!/usr/bin/env bash
# tests/test-review-allowlist-167.sh -- EMBED 3b (v7.35.0, GitHub #167).
#
# Bash-route coverage for the positive --allowedTools least-privilege allowlist
# that complements the v7.33 --disallowedTools denylist on reviewer / adversarial
# / council subcalls. Mirrors the structure of tests/test-cli-embeds-v733.sh.
#
# Asserts:
#   - loki_review_allowlist_enabled predicate gating: DEFAULT OFF, opt-in
#     LOKI_REVIEW_ALLOWLIST=1, gated on --allowedTools CLI support.
#   - loki_review_allowlist token content: read/inspect tools only (Read, Grep,
#     Glob, read-only git), NEVER Edit/Write/NotebookEdit or git mutation forms.
#   - graceful degrade: no --allowedTools in `claude --help` -> predicate OFF.
#   - call sites (run.sh reviewer + adversarial) append --allowedTools after the
#     denylist via the guard helper, default-off so it stays opt-in.
#   - cross-route parity: the bash token string-equals the TS
#     REVIEW_ALLOWLIST_TOKEN in loki-ts/src/providers/claude_flags.ts.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FLAGS_SH="$REPO_ROOT/autonomy/lib/claude-flags.sh"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
TS_FLAGS="$REPO_ROOT/loki-ts/src/providers/claude_flags.ts"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "${GREEN}[PASS]${NC} $1"; }
bad() { FAIL=$((FAIL + 1)); echo "${RED}[FAIL]${NC} $1 -- ${2:-}"; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loki-allowlist-167-XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

# A stub `claude` whose --help advertises --allowedTools (and --disallowedTools)
# so the flag-support probe reports them available.
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/claude" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  --help)
    cat <<'HELP'
  --allowedTools, --allowed-tools <tools...>  allow list
  --disallowedTools, --disallowed-tools <tools...>  deny list
  --effort <level>  effort
HELP
    exit 0
    ;;
esac
exit 0
STUB
chmod +x "$STUB_BIN/claude"

# ---------------------------------------------------------------------------
# Section A: helper-predicate gating + token content (claude-flags.sh)
# ---------------------------------------------------------------------------
(
  PATH="$STUB_BIN:$PATH"
  unset __LOKI_CLAUDE_HELP_CACHE
  # shellcheck disable=SC1090
  . "$FLAGS_SH"

  # DEFAULT OFF: predicate must be OFF when LOKI_REVIEW_ALLOWLIST unset.
  unset LOKI_REVIEW_ALLOWLIST
  if loki_review_allowlist_enabled; then echo "B1_BAD"; else echo "B1_OK"; fi

  # ON: predicate enabled when =1 AND --allowedTools supported.
  if LOKI_REVIEW_ALLOWLIST=1 loki_review_allowlist_enabled; then echo "B2_OK"; else echo "B2_BAD"; fi

  # Token content: read/inspect tools present.
  al="$(loki_review_allowlist)"
  case "$al" in Read,*) echo "B3a_OK";; *) echo "B3a_BAD";; esac
  case "$al" in *Grep*) echo "B3b_OK";; *) echo "B3b_BAD";; esac
  case "$al" in *Glob*) echo "B3c_OK";; *) echo "B3c_BAD";; esac
  case "$al" in *"Bash(git diff:*)"*) echo "B3d_OK";; *) echo "B3d_BAD";; esac
  case "$al" in *"Bash(git log:*)"*) echo "B3e_OK";; *) echo "B3e_BAD";; esac
  case "$al" in *"Bash(git status:*)"*) echo "B3f_OK";; *) echo "B3f_BAD";; esac
  # NEVER mutators or git mutation forms in an ALLOW grant.
  case "$al" in *Edit*) echo "B4a_BAD";; *) echo "B4a_OK";; esac
  case "$al" in *Write*) echo "B4b_BAD";; *) echo "B4b_OK";; esac
  case "$al" in *NotebookEdit*) echo "B4c_BAD";; *) echo "B4c_OK";; esac
  case "$al" in *"git push"*) echo "B4d_BAD";; *) echo "B4d_OK";; esac
  case "$al" in *"git reset"*) echo "B4e_BAD";; *) echo "B4e_OK";; esac
  case "$al" in *"git commit"*) echo "B4f_BAD";; *) echo "B4f_OK";; esac
  # Single comma-separated token: no commas-adjacent issues and emitted on one
  # line (the call sites pass it quoted so the inner Bash(git diff:*) spaces do
  # not split argv). Assert the helper prints exactly one line.
  lines="$(loki_review_allowlist | wc -l | tr -d ' ')"
  # printf with no trailing newline => wc -l reports 0 lines (no newline char).
  if [ "$lines" = "0" ]; then echo "B5_OK"; else echo "B5_BAD"; fi
) > "$TMP/secA.out" 2>/dev/null

check_tok() { # marker label
  if grep -qx "$1" "$TMP/secA.out"; then ok "$2"; else bad "$2" "marker $1 not found"; fi
}
check_tok B1_OK "EMBED3b predicate OFF by default (LOKI_REVIEW_ALLOWLIST unset)"
check_tok B2_OK "EMBED3b predicate ON when =1 and --allowedTools supported"
check_tok B3a_OK "EMBED3b allow list starts with Read"
check_tok B3b_OK "EMBED3b allow list contains Grep"
check_tok B3c_OK "EMBED3b allow list contains Glob"
check_tok B3d_OK "EMBED3b allow list contains Bash(git diff:*)"
check_tok B3e_OK "EMBED3b allow list contains Bash(git log:*)"
check_tok B3f_OK "EMBED3b allow list contains Bash(git status:*)"
check_tok B4a_OK "EMBED3b allow list does NOT grant Edit"
check_tok B4b_OK "EMBED3b allow list does NOT grant Write"
check_tok B4c_OK "EMBED3b allow list does NOT grant NotebookEdit"
check_tok B4d_OK "EMBED3b allow list does NOT grant git push"
check_tok B4e_OK "EMBED3b allow list does NOT grant git reset"
check_tok B4f_OK "EMBED3b allow list does NOT grant git commit"
check_tok B5_OK "EMBED3b allow list is emitted as a single line (one quoted argv token)"

# ---------------------------------------------------------------------------
# Section B: graceful degrade (no --allowedTools in help -> predicate OFF)
# ---------------------------------------------------------------------------
(
  DEGRADE_BIN="$TMP/degrade-bin"
  mkdir -p "$DEGRADE_BIN"
  cat > "$DEGRADE_BIN/claude" <<'DST'
#!/usr/bin/env bash
case "$1" in --help) printf '  --effort <level>  effort\n'; exit 0;; esac
exit 0
DST
  chmod +x "$DEGRADE_BIN/claude"
  PATH="$DEGRADE_BIN:$PATH"
  unset __LOKI_CLAUDE_HELP_CACHE LOKI_REVIEW_ALLOWLIST
  # shellcheck disable=SC1090
  . "$FLAGS_SH"
  if LOKI_REVIEW_ALLOWLIST=1 loki_review_allowlist_enabled; then echo "B6_BAD"; else echo "B6_OK"; fi
) > "$TMP/secB.out" 2>/dev/null
if grep -qx B6_OK "$TMP/secB.out"; then ok "EMBED3b degrades gracefully (no --allowedTools in help -> OFF even when =1)"; else bad "EMBED3b graceful degrade" "marker missing"; fi

# ---------------------------------------------------------------------------
# Section C: call-site wiring (run.sh reviewer + adversarial)
# ---------------------------------------------------------------------------
# Reviewer site: _rv_argv must append --allowedTools via the guard helper.
rv_block="$(awk '/_rv_argv=\("--dangerously-skip-permissions"\)/,/claude "\$\{_rv_argv\[@\]\}"/' "$RUN_SH")"
if printf '%s' "$rv_block" | grep -q 'loki_review_allowlist_enabled' \
   && printf '%s' "$rv_block" | grep -q '_rv_argv+=("--allowedTools" "$(loki_review_allowlist)")'; then
  ok "EMBED3b: reviewer council site appends --allowedTools via guard helper"
else
  bad "EMBED3b reviewer site" "missing --allowedTools append in _rv_argv block"
fi

# Adversarial site: _adv_argv must append --allowedTools via the guard helper.
adv_block="$(awk '/_adv_argv=\("--dangerously-skip-permissions"\)/,/claude "\$\{_adv_argv\[@\]\}"/' "$RUN_SH")"
if printf '%s' "$adv_block" | grep -q 'loki_review_allowlist_enabled' \
   && printf '%s' "$adv_block" | grep -q '_adv_argv+=("--allowedTools" "$(loki_review_allowlist)")'; then
  ok "EMBED3b: adversarial site appends --allowedTools via guard helper"
else
  bad "EMBED3b adversarial site" "missing --allowedTools append in _adv_argv block"
fi

# The append must come AFTER the denylist append at both sites (deny precedence
# is order-independent in claude, but we keep allow-after-deny for readability and
# to mirror the TS call site). Assert denylist line precedes allowlist line.
for tag in _rv_argv _adv_argv; do
  deny_ln=$(grep -n "${tag}+=(\"--disallowedTools\"" "$RUN_SH" | head -1 | cut -d: -f1)
  allow_ln=$(grep -n "${tag}+=(\"--allowedTools\"" "$RUN_SH" | head -1 | cut -d: -f1)
  if [ -n "$deny_ln" ] && [ -n "$allow_ln" ] && [ "$allow_ln" -gt "$deny_ln" ]; then
    ok "EMBED3b: ${tag} allowlist append follows the denylist append"
  else
    bad "EMBED3b ${tag} ordering" "deny_ln=$deny_ln allow_ln=$allow_ln"
  fi
done

# ---------------------------------------------------------------------------
# Section D: cross-route parity (bash token string-equals the TS token)
# ---------------------------------------------------------------------------
bash_token="$(PATH="$STUB_BIN:$PATH" bash -c '
  unset __LOKI_CLAUDE_HELP_CACHE
  # shellcheck disable=SC1090
  . "'"$FLAGS_SH"'"
  loki_review_allowlist
')"
# Extract the TS REVIEW_ALLOWLIST_TOKEN string literal.
ts_token="$(python3 - "$TS_FLAGS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'REVIEW_ALLOWLIST_TOKEN\s*=\s*"([^"]*)"', src)
print(m.group(1) if m else "__NO_MATCH__")
PY
)"
if [ -n "$bash_token" ] && [ "$bash_token" = "$ts_token" ]; then
  ok "EMBED3b cross-route parity: bash token string-equals TS REVIEW_ALLOWLIST_TOKEN"
else
  bad "EMBED3b cross-route parity" "bash='$bash_token' ts='$ts_token'"
fi

# ---------------------------------------------------------------------------
echo
echo "test-review-allowlist-167: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
