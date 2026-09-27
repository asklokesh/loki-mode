#!/usr/bin/env bash
# The quickstart fixture is the git bundle empty-repo.bundle (clone it with
# `git clone empty-repo.bundle app`). This script documents and rebuilds it:
# a one-commit repo on branch main holding only README.md. Identity and dates
# are pinned so the commit SHA is deterministic:
#   a49d132f67fd193a89e55363dc8c8a8933a1304e (repo.ref of every quickstart task)
# Quickstart task.json files point repo.source at the main-checkout path
# /Users/lokesh/git/lokimode-anthropic/eval/loki10/fixtures/empty-repo/empty-repo.bundle
# Usage: bash make-bundle.sh   (writes empty-repo.bundle next to this script)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
cd "$work"
git init -q -b main repo
cd repo
printf '%s\n' "# app" "" "Empty starting point for Loki 10 quickstart evals." > README.md
git add README.md
GIT_AUTHOR_NAME=loki-eval GIT_AUTHOR_EMAIL=eval@loki.invalid \
GIT_COMMITTER_NAME=loki-eval GIT_COMMITTER_EMAIL=eval@loki.invalid \
GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' \
  git -c commit.gpgsign=false commit -q -m "initial commit"
git rev-parse HEAD
git bundle create -q "$here/empty-repo.bundle" main
