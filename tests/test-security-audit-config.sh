#!/usr/bin/env bash
# tests/test-security-audit-config.sh
#
# E-114: guards scripts/security-audit-gitleaks.sh, the command shape behind
# .github/workflows/security-audit.yml's "gitleaks scan (all reachable
# history)" step. THE BUG: `gitleaks git .` loads the checked-out tree's OWN
# .gitleaks.toml (gitleaks' own precedence: -c/--config, then env
# GITLEAKS_CONFIG, then env GITLEAKS_CONFIG_TOML, then <target path>/
# .gitleaks.toml, else its embedded default). A pushed commit that ships a
# zero-rule .gitleaks.toml (`title = "x"`) therefore disables secret scanning
# for that same push -- a reviewer reproduced this against the pre-push hook
# (E-110), and the CI step used the same no-`--config` shape.
#
# Drives the real script against disposable scratch repos with the real
# pinned gitleaks binary when one is on PATH (SKIP, never a silent pass,
# otherwise). Per CLAUDE.md, a test fixture that looks like a secret must be
# built at runtime by string concatenation so gitleaks never sees a literal
# in this file's own committed bytes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/security-audit-gitleaks.sh"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== security-audit.yml gitleaks config isolation (E-114) ==="

[ -f "$SCRIPT" ] || { echo "  FAIL: $SCRIPT missing"; exit 1; }
[ -x "$SCRIPT" ] || { echo "  FAIL: $SCRIPT is not executable"; exit 1; }

GITLEAKS_BIN="$(command -v gitleaks 2>/dev/null || true)"
if [ -z "$GITLEAKS_BIN" ]; then
  echo "  SKIP: no gitleaks binary on PATH -- live scenarios not run (not a pass)"
  echo
  echo "=== $PASS passed, $FAIL failed (live scenarios skipped) ==="
  exit 0
fi

_installed_version="$("$GITLEAKS_BIN" version 2>&1 | tr -d '[:space:]')"
echo "  NOTE: using installed gitleaks ($GITLEAKS_BIN, $_installed_version)."
echo "        security-audit.yml pins v8.30.0; this host has ${_installed_version#Version} -- close enough to exercise the same --config precedence, not a substitute for the pinned CI binary."

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-e114-test.XXXXXX")"
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

_new_repo() {
  local repo="$1"
  git init -q -b main "$repo" >/dev/null
  git -C "$repo" config user.email "e114-test@loki.local"
  git -C "$repo" config user.name "e114 test"
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config core.hooksPath /dev/null
  : > "$repo/.gitleaksignore"
  printf 'readme\n' > "$repo/README.md"
  git -C "$repo" add .gitleaksignore README.md
  git -C "$repo" commit -qm "baseline" --no-gpg-sign --no-verify
  # r2: the trusted base is now always the nearest release TAG, never a raw
  # commit -- every scratch repo needs at least one so `git describe` has
  # something to find (production main always has release tags too).
  git -C "$repo" tag v1.0.0
}

# Built by concatenation so this file's own committed bytes never carry a
# contiguous AKIA-shaped token.
_akia_prefix='AKIA'
_akia_rest='1234567890ABCDEF'

# --- Scenario A: zero-rule .gitleaks.toml + a real secret, in the range --
# Must be REFUSED, with a clear founder-review message, no automatic bypass.
REPO_A="$TMP_ROOT/repo-refused"
_new_repo "$REPO_A"
BASE_A="$(git -C "$REPO_A" rev-parse HEAD)"
printf 'title = "x"\n' > "$REPO_A/.gitleaks.toml"
printf '%s\n' "const key = \"${_akia_prefix}${_akia_rest}\";" > "$REPO_A/secret.js"
git -C "$REPO_A" add .gitleaks.toml secret.js
git -C "$REPO_A" commit -qm "add zero-rule config and a secret" --no-gpg-sign --no-verify
TIP_A="$(git -C "$REPO_A" rev-parse HEAD)"

# Red-first control: the OLD shape (`gitleaks git .` with no --config, from
# the checkout root) trusts the TIP's own .gitleaks.toml and finds nothing --
# this is the exact bypass E-114 closes.
_old_shape_rc=0
(cd "$REPO_A" && "$GITLEAKS_BIN" git . --log-opts="--all" \
  --gitleaks-ignore-path .gitleaksignore --no-banner --redact >/dev/null 2>&1) || _old_shape_rc=$?
if [ "$_old_shape_rc" -eq 0 ]; then
  ok "RED EVIDENCE: the pre-E-114 command shape (no --config) is bypassed by the tip's own zero-rule .gitleaks.toml"
else
  bad "could not reproduce the bypass with the old command shape -- fixture is not exercising the reported bug"
fi

REPORT_A="$TMP_ROOT/report-a.json"
_out_a="$(cd "$REPO_A" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_A" \
  GITLEAKS_TIP="$TIP_A" GITLEAKS_REPORT="$REPORT_A" "$SCRIPT" 2>&1)"
_rc_a=$?

if [ "$_rc_a" -ne 0 ]; then
  ok "the fixed script refuses the job (exit $_rc_a) when the range adds a zero-rule .gitleaks.toml"
else
  bad "the fixed script did NOT refuse a range that adds a zero-rule .gitleaks.toml"
fi
if printf '%s' "$_out_a" | grep -q 'founder review'; then
  ok "the refusal names the dedicated-PR founder-review path (no automatic bypass)"
else
  bad "the refusal message does not point to founder review through a dedicated PR"
fi
if [ -f "$REPORT_A" ]; then
  _n_a="$(python3 -c "import json; print(len(json.load(open('$REPORT_A'))))" 2>/dev/null || echo "-1")"
  if [ "$_n_a" -ge 1 ]; then
    ok "defense in depth: even ignoring the refusal, the trusted-base-config scan independently caught $_n_a finding(s) -- the tip's zero-rule config never got used"
  else
    bad "the trusted-base-config scan reported $_n_a findings for a range with a real secret -- --config isolation is not working"
  fi
else
  bad "no report was written for the refused range -- the Upload step would error"
fi

# --- Scenario B: a clean range must pass -----------------------------------
REPO_B="$TMP_ROOT/repo-clean"
_new_repo "$REPO_B"
BASE_B="$(git -C "$REPO_B" rev-parse HEAD)"
printf 'nothing secret here\n' > "$REPO_B/notes.md"
git -C "$REPO_B" add notes.md
git -C "$REPO_B" commit -qm "harmless change" --no-gpg-sign --no-verify
TIP_B="$(git -C "$REPO_B" rev-parse HEAD)"

REPORT_B="$TMP_ROOT/report-b.json"
_out_b="$(cd "$REPO_B" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_B" \
  GITLEAKS_TIP="$TIP_B" GITLEAKS_REPORT="$REPORT_B" "$SCRIPT" 2>&1)"
_rc_b=$?
if [ "$_rc_b" -eq 0 ]; then
  ok "a clean range (no config change, no secret) passes"
else
  bad "a clean range was refused (exit $_rc_b): $_out_b"
fi
if [ -f "$REPORT_B" ]; then
  _n_b="$(python3 -c "import json; print(len(json.load(open('$REPORT_B'))))" 2>/dev/null || echo "-1")"
  [ "$_n_b" -eq 0 ] && ok "the clean range's report has zero findings" \
    || bad "the clean range's report has $_n_b findings (expected 0)"
else
  bad "no report was written for the clean range"
fi

# --- Scenario C: a .gitleaksignore addition warns, never blocks ------------
REPO_C="$TMP_ROOT/repo-ignoreline"
_new_repo "$REPO_C"
BASE_C="$(git -C "$REPO_C" rev-parse HEAD)"
_added_line="deadbeefcafef00d1234567890abcdef12345678:test-rule:1"
printf '%s\n' "$_added_line" >> "$REPO_C/.gitleaksignore"
git -C "$REPO_C" add .gitleaksignore
git -C "$REPO_C" commit -qm "allowlist a reviewed fingerprint" --no-gpg-sign --no-verify
TIP_C="$(git -C "$REPO_C" rev-parse HEAD)"

REPORT_C="$TMP_ROOT/report-c.json"
_out_c="$(cd "$REPO_C" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_C" \
  GITLEAKS_TIP="$TIP_C" GITLEAKS_REPORT="$REPORT_C" "$SCRIPT" 2>&1)"
_rc_c=$?
if [ "$_rc_c" -eq 0 ]; then
  ok "a .gitleaksignore addition alone does not block the job"
else
  bad "a .gitleaksignore addition alone was blocked (exit $_rc_c) -- should only warn"
fi
if printf '%s' "$_out_c" | grep -qF "::warning::.gitleaksignore gained a line"; then
  ok "the step prints a ::warning:: annotation for the .gitleaksignore addition"
else
  bad "no ::warning:: annotation was printed for the .gitleaksignore addition"
fi
if printf '%s' "$_out_c" | grep -qF "$_added_line"; then
  ok "the warning quotes the exact added .gitleaksignore line"
else
  bad "the warning does not quote the exact added line"
fi

# --- Scenario D: an ordinary train merge must NOT be a false positive ------
# base already has a real .gitleaks.toml. A side branch forked BEFORE that
# config existed is merged in AFTER it (this repo's own train-merge shape,
# e.g. f6c3add4). A per-commit `diff-tree -m` walk flags the merge itself,
# because the config looks "added" relative to the parent that forked before
# it -- even though base and tip carry the IDENTICAL config. This must pass
# clean: it also exercises the base-has-a-real-.gitleaks.toml --config path
# (scenarios A-C above all hit the no-base-config default-rules path only).
REPO_D="$TMP_ROOT/repo-merge"
_new_repo "$REPO_D"
git -C "$REPO_D" branch feature >/dev/null
printf '[extend]\nuseDefault = true\n' > "$REPO_D/.gitleaks.toml"
git -C "$REPO_D" add .gitleaks.toml
git -C "$REPO_D" commit -qm "add real gitleaks config" --no-gpg-sign --no-verify
BASE_D="$(git -C "$REPO_D" rev-parse HEAD)"
# This IS the release the merge should be measured against, not the older
# v1.0.0 baseline tag _new_repo already placed -- tag it v1.1.0 so
# `--abbrev=0` (nearest tag) finds this one.
git -C "$REPO_D" tag v1.1.0
git -C "$REPO_D" checkout -q feature
printf 'a harmless feature\n' > "$REPO_D/feature.txt"
git -C "$REPO_D" add feature.txt
git -C "$REPO_D" commit -qm "unrelated feature work" --no-gpg-sign --no-verify
git -C "$REPO_D" checkout -q main
git -C "$REPO_D" merge -q --no-edit --no-ff feature --no-gpg-sign
TIP_D="$(git -C "$REPO_D" rev-parse HEAD)"

REPORT_D="$TMP_ROOT/report-d.json"
_out_d="$(cd "$REPO_D" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$BASE_D" \
  GITLEAKS_TIP="$TIP_D" GITLEAKS_REPORT="$REPORT_D" "$SCRIPT" 2>&1)"
_rc_d=$?
if [ "$_rc_d" -eq 0 ]; then
  ok "an ordinary train merge of a branch forked before the config existed is not a false-positive config change"
else
  bad "a clean train merge was refused (exit $_rc_d) -- per-commit config detection false-positives on merges: $_out_d"
fi
if printf '%s' "$_out_d" | grep -q "base commit's .gitleaks.toml"; then
  ok "the merge scenario exercises the base-has-a-config --config path"
else
  bad "the merge scenario did not report using the base commit's .gitleaks.toml"
fi
if [ -f "$REPORT_D" ]; then
  _n_d="$(python3 -c "import json; print(len(json.load(open('$REPORT_D'))))" 2>/dev/null || echo "-1")"
  [ "$_n_d" -eq 0 ] && ok "the merge range's report has zero findings" \
    || bad "the merge range's report has $_n_d findings (expected 0)"
else
  bad "no report was written for the merge range"
fi

# --- Scenario E: the r2 opus-reject repro (two-push bypass) ---------------
# Main is unprotected and this workflow only runs on a VERSION push. Push A
# (no VERSION change) adds a zero-rule .gitleaks.toml and gets no audit at
# all. Push B (the VERSION bump, with a real secret) has before = A's own
# sha. r1 trusted A's tree directly via GITLEAKS_BEFORE and scanned itself
# clean -- reviewer's exact repro: tag v1.0.0, commit B1 = `title = "x"`
# .gitleaks.toml (unaudited, untagged), commit a leak, GITLEAKS_BEFORE=B1.
# This must now be REFUSED: GITLEAKS_BEFORE is only a search anchor, never
# a trusted tree, so the walk lands on v1.0.0 (no .gitleaks.toml there).
REPO_E="$TMP_ROOT/repo-r2-repro"
_new_repo "$REPO_E"
printf 'title = "x"\n' > "$REPO_E/.gitleaks.toml"
git -C "$REPO_E" add .gitleaks.toml
git -C "$REPO_E" commit -qm "push A: add zero-rule config, no VERSION change, no audit" --no-gpg-sign --no-verify
B1_E="$(git -C "$REPO_E" rev-parse HEAD)"
printf '%s\n' "const key = \"${_akia_prefix}${_akia_rest}\";" > "$REPO_E/secret.js"
git -C "$REPO_E" add secret.js
git -C "$REPO_E" commit -qm "push B: VERSION bump plus a real secret" --no-gpg-sign --no-verify
TIP_E="$(git -C "$REPO_E" rev-parse HEAD)"

REPORT_E="$TMP_ROOT/report-e.json"
_out_e="$(cd "$REPO_E" && GITLEAKS_BIN="$GITLEAKS_BIN" GITLEAKS_BEFORE="$B1_E" \
  GITLEAKS_TIP="$TIP_E" GITLEAKS_REPORT="$REPORT_E" "$SCRIPT" 2>&1)"
_rc_e=$?
if [ "$_rc_e" -ne 0 ]; then
  ok "r2 repro: refused even though GITLEAKS_BEFORE names the attacker's own unaudited weakened-config commit"
else
  bad "r2 repro: GITLEAKS_BEFORE=<unaudited commit> was trusted directly -- the two-push bypass is NOT closed"
fi
if printf '%s' "$_out_e" | grep -q 'founder review'; then
  ok "r2 repro: the refusal still names the founder-review path"
else
  bad "r2 repro: no founder-review message on refusal"
fi

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
