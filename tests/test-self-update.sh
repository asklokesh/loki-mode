#!/usr/bin/env bash
# loki self-update --check reports installed vs latest version (TEN-ADOPTION-15).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-su.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

INSTALLED="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"

mkdir -p "$WORK/bin-up" "$WORK/bin-off" "$WORK/bin-same"
printf '#!/bin/sh\nprintf %s\n' "'{\"version\":\"999.0.0\"}'" > "$WORK/bin-up/curl"
printf '#!/bin/sh\nprintf %s\n' "'{\"version\":\"$INSTALLED\"}'" > "$WORK/bin-same/curl"
printf '#!/bin/sh\nexit 6\n' > "$WORK/bin-off/curl"
chmod +x "$WORK"/bin-*/curl

run_check() { # <stub-dir> <home>
    HOME="$2" PATH="$1:$PATH" LOKI_NO_UPDATE_CHECK=1 bash "$LOKI" self-update --check 2>&1
}

out="$(run_check "$WORK/bin-up" "$WORK/h1")"; rc=$?
[ "$rc" -eq 0 ] && ok "exit 0 when update exists" || bad "rc=$rc"
case "$out" in *"installed $INSTALLED, latest 999.0.0, update available yes"*) ok "update available yes" ;; *) bad "yes line missing: $out" ;; esac
case "$out" in *"current mgr:"*) ok "manager detection still printed" ;; *) bad "manager line lost" ;; esac

out="$(run_check "$WORK/bin-same" "$WORK/h2")"
case "$out" in *"installed $INSTALLED, latest $INSTALLED, update available no"*) ok "update available no" ;; *) bad "no line missing: $out" ;; esac

out="$(run_check "$WORK/bin-off" "$WORK/h3")"; rc=$?
[ "$rc" -eq 0 ] && ok "offline exits 0" || bad "offline rc=$rc"
case "$out" in *"installed $INSTALLED, latest unknown"*) ok "offline prints latest unknown" ;; *) bad "unknown line missing: $out" ;; esac
case "$out" in *"update available"*) bad "offline must not claim an update verdict" ;; *) ok "offline makes no update claim" ;; esac

# fresh cache served without network (offline stub, cache says 999.0.0)
mkdir -p "$WORK/h4/.loki/cache"
printf '{"checkedAt":%s,"latest":"999.0.0"}\n' "$(date +%s)" > "$WORK/h4/.loki/cache/update-check-bash.json"
out="$(run_check "$WORK/bin-off" "$WORK/h4")"
case "$out" in *"latest 999.0.0, update available yes"*) ok "fresh cache used" ;; *) bad "cache not used: $out" ;; esac

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
