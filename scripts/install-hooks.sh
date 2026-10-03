#!/usr/bin/env bash
# Install Loki Mode's git hooks (committed under .githooks/) by pointing
# git at the directory. Idempotent.
set -euo pipefail

usage() {
    echo "Usage: scripts/install-hooks.sh [-h|--help]"
    echo "Sets git config core.hooksPath to .githooks. Takes no other arguments."
}

if [ "$#" -gt 0 ]; then
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "[install-hooks] unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
git config core.hooksPath .githooks
echo "[install-hooks] core.hooksPath -> .githooks"
echo "[install-hooks] hooks active:"
ls -1 .githooks
