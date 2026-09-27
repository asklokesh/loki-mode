#!/bin/sh
# Fake engine10-push.sh for deep.test.ts. Logs every call (mode, args, the
# two pin env vars) to LOG_PATH, then answers deterministically. Never the
# real, credentialed autonomy/lib/engine10-push.sh.
mode="$1"; shift
printf 'CALL mode=%s args=%s\n' "$mode" "$*" >> "$LOG_PATH"
printf 'ENV pinned=%s origin=%s\n' "${_LOKI_ORIGIN_PINNED:-}" "${_LOKI_PINNED_ORIGIN:-}" >> "$LOG_PATH"
if [ "$mode" = "${FAIL_ON:-}" ]; then echo "stub: refused" >&2; exit 2; fi
exit 0
