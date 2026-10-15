#!/usr/bin/env bash
# Shared --json helpers. Source this file; it defines functions only.
#
#   loki_json_requested ARGS...    exit 0 when --json is among ARGS
#   loki_json_strip ARGS...        print ARGS (one per line) without --json
#   loki_json_wrap NAME CMD ARGS.. run CMD, print one JSON object:
#                                  {"command":NAME,"exit_code":N,"ok":bool,"output":"..."}
#                                  and return CMD's exit code. Use ONLY for
#                                  commands with no native --json output.

loki_json_requested() {
    local a
    for a in "$@"; do
        [ "$a" = "--json" ] && return 0
    done
    return 1
}

loki_json_strip() {
    local a
    for a in "$@"; do
        [ "$a" = "--json" ] || printf '%s\n' "$a"
    done
}

loki_json_wrap() {
    local name="$1" out rc
    shift
    out="$("$@" 2>&1)"
    rc=$?
    LOKI_JW_NAME="$name" LOKI_JW_RC="$rc" LOKI_JW_OUT="$out" python3 -c '
import json, os, re
rc = int(os.environ["LOKI_JW_RC"])
out = re.sub(r"\x1b\[[0-9;]*m", "", os.environ["LOKI_JW_OUT"])
print(json.dumps({"command": os.environ["LOKI_JW_NAME"], "exit_code": rc, "ok": rc == 0, "output": out}))
'
    return "$rc"
}
