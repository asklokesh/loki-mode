#!/usr/bin/env bash
# scripts/security-audit-gitleaks.sh
#
# E-114: the "gitleaks scan (all reachable history)" step of
# .github/workflows/security-audit.yml's secret-scan job, factored out so
# tests/test-security-audit-config.sh can drive it against disposable scratch
# repos with the real pinned gitleaks binary. The workflow step calls this
# script unchanged; nothing here is CI-only.
#
# THE BUG THIS CLOSES: `gitleaks git .` run from the checkout root auto-loads
# THAT CHECKOUT'S OWN .gitleaks.toml (gitleaks' documented precedence:
# -c/--config, then env GITLEAKS_CONFIG, then env GITLEAKS_CONFIG_TOML, then
# <target path>/.gitleaks.toml, else its embedded default). A pushed commit
# that ships a zero-rule .gitleaks.toml (`title = "x"`) therefore disables
# secret scanning for THAT SAME PUSH. A reviewer reproduced this against the
# pre-push hook (E-110); the same mechanism applies to CI, which loads the
# checkout's own .gitleaks.toml with no --config at all.
#
# Two independent controls, both fail-closed, neither auto-bypassable:
#   1. refuse the job outright if the pushed range touches .gitleaks.toml at
#      all -- that change needs founder review through a dedicated PR;
#   2. even so, never trust the TIP's .gitleaks.toml for the scan itself --
#      use the BASE commit's config, or gitleaks' built-in default rules if
#      the base has none, regardless of what the tip added or changed.
# A .gitleaksignore addition is not blocked (exact-fingerprint allowlisting
# after triage is the sanctioned path) but every added line is printed as a
# ::warning:: so a reviewer sees it.
set -euo pipefail

GITLEAKS_BIN="${GITLEAKS_BIN:-/tmp/gitleaks}"
GITLEAKS_BEFORE="${GITLEAKS_BEFORE:-}"
GITLEAKS_TIP="${GITLEAKS_TIP:-HEAD}"
GITLEAKS_REPORT="${GITLEAKS_REPORT:-/tmp/gitleaks-report.json}"

# FAIL CLOSED: an absent binary is not "no secrets found".
if [ ! -x "$GITLEAKS_BIN" ]; then
  echo "FAIL: gitleaks is not installed -- secret scan did NOT run"
  exit 1
fi

_tip="$(git rev-parse "$GITLEAKS_TIP")"

# --- resolve the base of the pushed range ---------------------------------
# github.event.before is 40 zeros on a new branch or a push with no common
# history GitHub will disclose. Fall back to the most recent release tag
# reachable from the tip's parent, then to origin/main~1.
_is_zero_sha() {
  case "$1" in
    '' | 0000000000000000000000000000000000000000) return 0 ;;
    *) return 1 ;;
  esac
}

_base=""
if ! _is_zero_sha "$GITLEAKS_BEFORE" && git cat-file -e "${GITLEAKS_BEFORE}^{commit}" 2>/dev/null; then
  _base="$GITLEAKS_BEFORE"
else
  _base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "${_tip}^" 2>/dev/null || true)"
  if [ -z "$_base" ] || ! git cat-file -e "${_base}^{commit}" 2>/dev/null; then
    _base="origin/main~1"
  fi
fi
if ! git cat-file -e "${_base}^{commit}" 2>/dev/null; then
  echo "FAIL: could not resolve a base commit for the pushed range -- refusing to scan with an unverified config" >&2
  exit 1
fi
_base_sha="$(git rev-parse "${_base}^{commit}")"

echo "gitleaks range: ${_base_sha} (base) .. ${_tip} (tip)"

# --- (1) detect a .gitleaks.toml change over the whole range -------------
# A NET two-endpoint diff (base tree vs tip tree), not a per-commit walk. A
# per-commit `diff-tree -m` walk over a MERGE commit compares the merge
# result against EACH parent separately, so it flags .gitleaks.toml as
# "added" against whichever parent forked before the config existed -- true
# of every ordinary train merge of a slice branch older than the config
# (this repo's own history, e.g. f6c3add4) -- even though nothing about the
# config actually changed net. Control (2) below never loads the tip's
# config regardless, so only a NET change between base and tip can affect
# what a later push trusts as its base; a config added then removed inside
# the same range nets to "unchanged" and is correctly not a concern here.
# The job is refused below, AFTER the scan runs (2) -- not here -- so a
# refused push still produces a report the Upload step can attach, and so
# the trusted-base-config scan gets to prove itself on the same range
# independently of this gate (defense in depth: even if this detection had
# a bug, (2) alone still never trusts the tip's config).
_config_touched=0
if ! git diff --quiet "${_base_sha}" "${_tip}" -- .gitleaks.toml 2>/dev/null; then
  _config_touched=1
  echo "::error::.gitleaks.toml differs between ${_base_sha} and ${_tip} -- this can silently weaken or disable secret scanning" >&2
  git diff --no-color -U0 "${_base_sha}" "${_tip}" -- .gitleaks.toml 2>/dev/null | sed 's/^/  /' >&2 || true
fi

# --- (3) warn, never block, on every .gitleaksignore line added ----------
git diff --no-color -U0 "${_base_sha}" "${_tip}" -- .gitleaksignore 2>/dev/null \
  | sed -n 's/^+\([^+].*\)$/\1/p' \
  | while IFS= read -r _line; do
      echo "::warning::.gitleaksignore gained a line (${_base_sha:0:12}..${_tip:0:12}): ${_line}"
    done

# --- (2) scan with an explicit, TRUSTED config -- never the tip's --------
# Precedence gitleaks documents: -c/--config, then env GITLEAKS_CONFIG, then
# env GITLEAKS_CONFIG_TOML, then <target path>/.gitleaks.toml, else its
# embedded default. Clear the env vars so nothing but our own --config (or
# its deliberate absence) decides this.
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML || true

_config_tmp=""
_tip_config_backup=""
_config_arg=()
if git cat-file -e "${_base_sha}:.gitleaks.toml" 2>/dev/null; then
  _config_tmp="$(mktemp "${TMPDIR:-/tmp}/loki-gitleaks-base-config.XXXXXX")"
  git show "${_base_sha}:.gitleaks.toml" > "$_config_tmp"
  _config_arg=(--config "$_config_tmp")
  echo "gitleaks config: the base commit's .gitleaks.toml (${_base_sha})"
else
  # No --config, and GUARANTEED no <target path>/.gitleaks.toml either: if
  # the checked-out tip added one, move it out of the way before scanning.
  # `gitleaks git` scans commit patches through git plumbing, not the
  # working tree, so this has zero effect on which commits get scanned --
  # only on gitleaks' own config auto-detection at startup, which reads
  # this path off disk regardless of subcommand.
  if [ -e ./.gitleaks.toml ]; then
    _tip_config_backup="$(mktemp "${TMPDIR:-/tmp}/loki-gitleaks-tip-config.XXXXXX")"
    mv ./.gitleaks.toml "$_tip_config_backup"
  fi
  echo "gitleaks config: the base commit has none -- using gitleaks' built-in default rules"
fi

_scan_rc=0
"$GITLEAKS_BIN" git . \
  "${_config_arg[@]+"${_config_arg[@]}"}" \
  --log-opts="--all" \
  --gitleaks-ignore-path .gitleaksignore \
  --report-format json \
  --report-path "$GITLEAKS_REPORT" \
  --redact \
  --no-banner || _scan_rc=$?

[ -z "$_config_tmp" ] || rm -f -- "$_config_tmp"
if [ -n "$_tip_config_backup" ]; then
  mv "$_tip_config_backup" ./.gitleaks.toml
fi

# --- (1), enforced: no automatic bypass regardless of the scan's own rc --
if [ "$_config_touched" -eq 1 ]; then
  echo "FAIL: the pushed range changes .gitleaks.toml -- this needs founder review through a dedicated PR, never an automatic pass or an automatic bypass" >&2
  if [ "$_scan_rc" -ne 0 ]; then
    exit "$_scan_rc"
  fi
  exit 1
fi

exit "$_scan_rc"
