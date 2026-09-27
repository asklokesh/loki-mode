#!/usr/bin/env bash
# E-39 fixture: stands in for a provider CLI (LOKI_CODEX_CLI) that never
# returns on its own, so a stage stays "in progress" until something kills
# its process group. The caller identifies the group via session.ts's own
# session.started pgid event; this script does not need to report itself.
set -u
sleep 30
