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
# E-157: release.yml required-ci scans only PARENT..SHA (all commits reachable from
# SHA and not from PARENT, second parents of a merge included) before reusing the
# parent's audit verdict. Default stays the full-history scan.
# Set GITLEAKS_RANGE (e.g. PARENT..SHA) to scan only that range; empty = all history.
GITLEAKS_RANGE="${GITLEAKS_RANGE:-}"
_log_opts_arg=(--log-opts="--all")
[ -z "$GITLEAKS_RANGE" ] || _log_opts_arg=(--log-opts="$GITLEAKS_RANGE")

# FAIL CLOSED: an absent binary is not "no secrets found".
if [ ! -x "$GITLEAKS_BIN" ]; then
  echo "FAIL: gitleaks is not installed -- secret scan did NOT run"
  exit 1
fi

_tip="$(git rev-parse "$GITLEAKS_TIP")"

# --- resolve the TRUSTED base: the last released tag, NEVER event.before -
# r2 (opus REJECT of the r1 shape): main is unprotected and this workflow
# only runs on a VERSION push (a release). A push that does not touch
# VERSION gets no audit at all, so github.event.before (or a PR's
# base.sha) can name an UNAUDITED, attacker-controlled commit. r1 trusted
# that commit's own tree directly: push A adds a zero-rule .gitleaks.toml
# with no audit; push B (the VERSION bump, with a real secret) has
# before = A, and reading A's own .gitleaks.toml scanned the range clean.
# Reviewer's repro: tag v1.0.0; commit B1 = `title = "x"` .gitleaks.toml;
# commit a leak; GITLEAKS_BEFORE=B1 printed "no leaks found", exit 0.
#
# The only commits this workflow has ever actually scanned are tagged
# releases (vX.Y.Z, cut only after local-ci and this same audit pass) --
# never a raw push. So the trusted base is ALWAYS the nearest release tag,
# located by walking ancestry backward from an anchor. GITLEAKS_BEFORE's
# OWN TREE IS NEVER READ: it is only a place to start that walk (needed so
# a PR's base branch, not its unmerged head, is where the walk begins).
# Neither A nor any other untagged commit matches `--match 'v[0-9]*'`, so
# the walk always lands on the last real release no matter how many
# unaudited interim pushes sit in between -- or how many hops back it
# takes to find one, unlike a single `^` parent step.
_is_zero_sha() {
  case "$1" in
    '' | 0000000000000000000000000000000000000000) return 0 ;;
    *) return 1 ;;
  esac
}

_describe_from="${_tip}^"
if ! _is_zero_sha "$GITLEAKS_BEFORE" && git cat-file -e "${GITLEAKS_BEFORE}^{commit}" 2>/dev/null; then
  _describe_from="$GITLEAKS_BEFORE"
fi

_base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$_describe_from" 2>/dev/null || true)"
_base_sha=""
if [ -n "$_base" ] && git cat-file -e "${_base}^{commit}" 2>/dev/null; then
  _base_sha="$(git rev-parse "${_base}^{commit}")"
fi

# r3 (opus REJECT of the r2 shape): a fallback to origin/main~1 when no
# release tag exists is the SAME bug class -- that commit was never
# audited either, and using its .gitleaks.toml (or trusting a diff against
# it) can fail open exactly like trusting event.before did. There is no
# fallback: with no release tag, there is no trusted base, full stop.
if [ -z "$_base_sha" ]; then
  echo "gitleaks range: no release tag found -- no trusted base; refusing any .gitleaks.toml on the tip and scanning with default rules only"
else
  echo "gitleaks range: ${_base_sha} (base) .. ${_tip} (tip)"
fi

# --- (1) detect a .gitleaks.toml change over the whole range -------------
# r2 requirement 2: main carries no .gitleaks.toml today, so with the base
# now always resolved to a real release tag (above), this same byte-level
# diff already IS "refuse any tip .gitleaks.toml unless byte-identical to
# the file at the last release tag" -- today that file does not exist at
# the base, so ANY .gitleaks.toml on the tip differs and is refused.
#
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
if [ -z "$_base_sha" ]; then
  # r3: NO fallback base -- refuse outright if the tip has ANY .gitleaks.toml
  # at all, rather than diffing against something unaudited.
  if git cat-file -e "${_tip}:.gitleaks.toml" 2>/dev/null; then
    _config_touched=1
    echo "::error::no release tag exists to trust as a base, and the tip has a .gitleaks.toml -- refusing rather than trusting it or an unaudited fallback commit" >&2
  fi
elif ! git diff --quiet "${_base_sha}" "${_tip}" -- .gitleaks.toml 2>/dev/null; then
  _config_touched=1
  echo "::error::.gitleaks.toml differs between ${_base_sha} and ${_tip} -- this can silently weaken or disable secret scanning" >&2
  git diff --no-color -U0 "${_base_sha}" "${_tip}" -- .gitleaks.toml 2>/dev/null | sed 's/^/  /' >&2 || true
fi

# --- (3) warn, never block, on every .gitleaksignore line added ----------
if [ -n "$_base_sha" ]; then
  git diff --no-color -U0 "${_base_sha}" "${_tip}" -- .gitleaksignore 2>/dev/null \
    | sed -n 's/^+\([^+].*\)$/\1/p' \
    | while IFS= read -r _line; do
        echo "::warning::.gitleaksignore gained a line (${_base_sha:0:12}..${_tip:0:12}): ${_line}"
      done
fi

# --- (2) scan with an explicit, TRUSTED config -- never the tip's --------
# Precedence gitleaks documents: -c/--config, then env GITLEAKS_CONFIG, then
# env GITLEAKS_CONFIG_TOML, then <target path>/.gitleaks.toml, else its
# embedded default. Clear the env vars so nothing but our own --config (or
# its deliberate absence) decides this.
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML || true

_config_tmp=""
_tip_config_backup=""
_config_arg=()
if [ -n "$_base_sha" ] && git cat-file -e "${_base_sha}:.gitleaks.toml" 2>/dev/null; then
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
_revs="${GITLEAKS_RANGE:---all}"

# E-159 (b), FAIL OPEN closed: gitleaks 8.30.0 exits 0 when its own internal
# `git log` fails (an invalid range, HEAD~5 on a short repo) and scans nothing.
# Refuse unless git itself can walk the revisions first, and below also treat a
# "[git] fatal" line in the scanner's output as a failure.
# shellcheck disable=SC2086
if ! git rev-list $_revs >/dev/null 2>&1; then
  echo "FAIL: 'git rev-list ${_revs}' failed -- nothing would be scanned, refusing to report a clean scan" >&2
  _scan_rc=1
else
  _err_log="$(mktemp "${TMPDIR:-/tmp}/loki-gitleaks-stderr.XXXXXX")"
  "$GITLEAKS_BIN" git . \
    "${_config_arg[@]+"${_config_arg[@]}"}" \
    "${_log_opts_arg[@]}" \
    --gitleaks-ignore-path .gitleaksignore \
    --report-format json \
    --report-path "$GITLEAKS_REPORT" \
    --redact \
    --no-banner 2> >(tee "$_err_log" >&2) || _scan_rc=$?
  wait
  if [ "$_scan_rc" -eq 0 ] && grep -q '\[git\] fatal' "$_err_log" 2>/dev/null; then
    echo "FAIL: gitleaks reported a git fatal error yet exited 0 -- the scan did not cover the requested history" >&2
    _scan_rc=1
  fi

  # E-159 (a), evil merge: a merge commit's OWN added content (e.g. `merge -s ours
  # --no-commit` plus a token in the merge itself) is invisible to the per-commit
  # scan above, which diffs merges against nothing. `--cc` shows only hunks that
  # differ from ALL parents, so ordinary merges contribute nothing and an evil merge
  # contributes exactly its own content. Same trusted config as the main scan.
  if [ "$_scan_rc" -eq 0 ]; then
    _mrc=0
    # Scope: the explicit range, else everything since the last trusted release tag.
    # A merge scan over ALL history reports 36 historical findings that stdin mode cannot
    # baseline (no commit in the fingerprint), so older merges stay covered only by the
    # per-commit scan above; every merge since the trusted base is covered here.
    _mrevs="$_revs"
    if [ -z "$GITLEAKS_RANGE" ] && [ -n "$_base_sha" ]; then
      _mrevs="${_base_sha}..${_tip}"
    fi
    # shellcheck disable=SC2086
    git log --merges -p --cc $_mrevs 2>/dev/null \
      | "$GITLEAKS_BIN" stdin \
          "${_config_arg[@]+"${_config_arg[@]}"}" \
          --report-format json \
          --report-path "${GITLEAKS_REPORT%.json}-merges.json" \
          --redact \
          --no-banner || _mrc=$?
    if [ "$_mrc" -ne 0 ]; then
      echo "FAIL: gitleaks found content added by a merge commit itself (git log --merges --cc ${_mrevs})" >&2
      _scan_rc="$_mrc"
    fi
  fi
  rm -f -- "$_err_log"
fi

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
