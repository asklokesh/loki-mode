#!/usr/bin/env bash
# generate-stale-zero.sh - regenerate hand-maintained facts from their source of truth
# (STALE-ZERO SZ-01). Called by scripts/release.sh on every bump; safe to run any time.
#
# Sources: VERSION, loki-ts/src/cli/registry.ts.
# Targets:
#   SKILL.md                     block  generated:commands
#   README.md                    block  generated:facts
#   helm/loki-mode/Chart.yaml    appVersion
#   deploy/helm/*/Chart.yaml     appVersion
#   docs/CLI-REFERENCE.md        whole file
#   docs/v10/CLI-MODERN.md       whole file (existing registry generator)
# Block markers: <!-- generated:NAME --> ... <!-- /generated -->
#
# Usage: scripts/generate-stale-zero.sh [--check]   (--check: exit 1 if anything would change)
# shellcheck disable=SC2016
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

command -v bun >/dev/null 2>&1 || { echo "generate-stale-zero: bun is required" >&2; exit 1; }
VERSION="$(tr -d '\n' <"$ROOT_DIR/VERSION")"
case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "generate-stale-zero: bad VERSION '$VERSION'" >&2; exit 1 ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT

# replace_block FILE NAME CONTENT_FILE: swap the text between the NAME markers.
replace_block() {
    python3 - "$1" "$2" "$3" <<'PY'
import re, sys
path, name, content_path = sys.argv[1:4]
text = open(path, encoding="utf-8").read()
body = open(content_path, encoding="utf-8").read().rstrip("\n")
pat = re.compile(r"(<!-- generated:%s -->\n).*?(\n<!-- /generated -->)" % re.escape(name), re.S)
if not pat.search(text):
    sys.exit("missing markers generated:%s in %s" % (name, path))
new = pat.sub(lambda m: m.group(1) + body + m.group(2), text, count=1)
if new != text:
    open(path, "w", encoding="utf-8").write(new)
PY
}

cd "$ROOT_DIR"

bun loki-ts/scripts/gen-command-lists.ts inline >"$WORK/inline.md"
replace_block SKILL.md commands "$WORK/inline.md"

{
    printf 'Current release: **v%s** (generated from `VERSION` by `scripts/generate-stale-zero.sh`; the badge above tracks npm).\n' "$VERSION"
    printf '\nCLI reference: [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md) (generated from the command registry).\n'
} >"$WORK/facts.md"
replace_block README.md facts "$WORK/facts.md"

for chart in helm/loki-mode/Chart.yaml deploy/helm/*/Chart.yaml; do
    [ -f "$chart" ] || continue
    sed -E "s/^appVersion: \"[0-9]+\.[0-9]+\.[0-9]+\"/appVersion: \"${VERSION}\"/" "$chart" >"$WORK/chart.yaml"
    cmp -s "$WORK/chart.yaml" "$chart" || cat "$WORK/chart.yaml" >"$chart"
done

{
    printf '# CLI reference\n\n'
    printf 'Generated from `loki-ts/src/cli/registry.ts` by `scripts/generate-stale-zero.sh` for v%s. Do not edit by hand.\n' "$VERSION"
    printf 'Hidden and legacy-only commands are omitted; see `docs/v10/CLI-MODERN.md` for the full inventory.\n\n'
    bun loki-ts/scripts/gen-command-lists.ts table
} >"$WORK/cli-ref.md"
cmp -s "$WORK/cli-ref.md" docs/CLI-REFERENCE.md 2>/dev/null || cat "$WORK/cli-ref.md" >docs/CLI-REFERENCE.md

bun loki-ts/scripts/gen-cli-modern-doc.ts

lines="$(wc -l <SKILL.md | tr -d ' ')"
if [ "$lines" -ge 500 ]; then
    echo "generate-stale-zero: SKILL.md is $lines lines (limit 499)" >&2
    exit 1
fi

if [ "$CHECK" = 1 ] && [ -n "$(git status --porcelain -- SKILL.md README.md helm deploy/helm docs/CLI-REFERENCE.md docs/v10/CLI-MODERN.md)" ]; then
    echo "generate-stale-zero: generated facts are stale (run scripts/generate-stale-zero.sh)" >&2
    exit 1
fi
echo "generate-stale-zero: ok (v${VERSION})"
