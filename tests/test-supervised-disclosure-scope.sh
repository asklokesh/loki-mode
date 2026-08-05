#!/usr/bin/env bash
# Regression: supervised builds keep disclosure state inside their scoped LOKI_DIR.

set -euo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-disclosure-scope.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

export HOME="$TEST_ROOT/home"
export LOKI_DIR="$TEST_ROOT/workspace/.loki"
mkdir -p "$HOME" "$LOKI_DIR"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=autonomy/crash.sh
source "$REPO_ROOT/autonomy/crash.sh"

loki_show_disclosure_once

grep -Fxq "DISCLOSURE_SHOWN=true" "$LOKI_DIR/config"
if [ -e "$HOME/.loki/config" ]; then
  echo "FAIL: supervised disclosure wrote outside LOKI_DIR" >&2
  exit 1
fi

echo "PASS: supervised disclosure remained inside LOKI_DIR"
