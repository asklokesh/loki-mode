#!/usr/bin/env bash
# PROTO token-diet-architecture (loki-ts/src/features/token_diet.ts), stub provider only. New file: prototype branch, no
# min test owns a tool-less implement protocol; on adoption these cases move into context-pack.sh and engine10-e2e-stub.sh.
# Asserts: the dossier is deterministic and verbatim; a red check resumes the same session with a failure digest and the
# current edited regions; apply is all-or-nothing with a nearest-text report; read-only and escaping paths are refused;
# NEED gets one read round; exhausted rounds return red (agentic fallback), never green.
. "$(dirname "$0")/lib.sh"
need bun; need node
out="$(cd "$ROOT/loki-ts" && timeout 120 bun fixtures/token-diet/stub_check.ts "$T" 2>&1)"; rc=$?
printf '%s\n' "$out"
_min_pass=$(printf '%s\n' "$out" | grep -c '  PASS: ')
_min_fail=$(printf '%s\n' "$out" | grep -c '  FAIL: ')
[ "$rc" -eq 0 ] || _min_fail=$((_min_fail + 1))
finish
