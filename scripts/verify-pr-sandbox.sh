#!/usr/bin/env bash
# verify-pr-sandbox.sh - run one untrusted PR check inside a fail-closed container.
#
# Contract (VPR-1; consumed by VPR-2). See docs/v11/VERIFY-PR-SANDBOX.md.
#   verify-pr-sandbox.sh --repo DIR --out DIR --cmd 'SHELL CMD' [--image IMG]
#                        [--timeout SECS] [--max-output BYTES] [--print-argv]
# Exit codes: 0 the check ran (read exit_code in result.json), 2 refused (bad
# input), 3 BLOCKED (docker absent, daemon down, image missing, pool exhausted).
# BLOCKED is never a verdict about the PR. Writes OUT/result.json and OUT/output.txt (the capped check output) only.
# Env: LOKI_VPR_IMAGE (default image), LOKI_VPR_DOCKER (docker binary, tests).
set -uo pipefail

REPO="" OUT="" CMD="" IMAGE="${LOKI_VPR_IMAGE:-}" TIMEOUT=120 MAX_OUT=65536 PRINT_ARGV=0
DOCKER="${LOKI_VPR_DOCKER:-docker}"

die() { printf 'verify-pr-sandbox: %s\n' "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) [ $# -ge 2 ] || die "$1 needs a value"; REPO="$2"; shift 2 ;;
        --out) [ $# -ge 2 ] || die "$1 needs a value"; OUT="$2"; shift 2 ;;
        --cmd) [ $# -ge 2 ] || die "$1 needs a value"; CMD="$2"; shift 2 ;;
        --image) [ $# -ge 2 ] || die "$1 needs a value"; IMAGE="$2"; shift 2 ;;
        --timeout) [ $# -ge 2 ] || die "$1 needs a value"; TIMEOUT="$2"; shift 2 ;;
        --max-output) [ $# -ge 2 ] || die "$1 needs a value"; MAX_OUT="$2"; shift 2 ;;
        --print-argv) PRINT_ARGV=1; shift ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$REPO" ] && [ -d "$REPO" ] || die "--repo must be an existing directory"
[ -n "$OUT" ] || die "--out is required"
[ -n "$CMD" ] || die "--cmd is required"
[ -n "$IMAGE" ] || die "--image or LOKI_VPR_IMAGE is required (no implicit pull)"
case "$IMAGE" in -*|*[!A-Za-z0-9._/:@-]*) die "invalid image name" ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) die "--timeout must be an integer" ;; esac
case "$MAX_OUT" in ''|*[!0-9]*) die "--max-output must be an integer" ;; esac
[ "${#TIMEOUT}" -le 7 ] && [ "${#MAX_OUT}" -le 9 ] || die "numeric argument too long"
# Force base 10: "09" is an arithmetic error and "010" is octal in $(( )).
TIMEOUT=$((10#$TIMEOUT)) MAX_OUT=$((10#$MAX_OUT))
[ "$TIMEOUT" -ge 1 ] && [ "$TIMEOUT" -le 3600 ] || die "--timeout out of range (1-3600)"
[ "$MAX_OUT" -ge 1 ] && [ "$MAX_OUT" -le 1048576 ] || die "--max-output out of range (1-1048576)"

mkdir -p "$OUT" || die "cannot create --out"
REPO_REAL="$(cd "$REPO" && pwd -P)" || die "cannot resolve --repo"
OUT_REAL="$(cd "$OUT" && pwd -P)" || die "cannot resolve --out"

# Never expose HOME, a docker socket, or an overlapping repo/out pair.
HOME_REAL="$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P || true)"
overlaps() { case "$1/" in "$2"/*) return 0 ;; esac; case "$2/" in "$1"/*) return 0 ;; esac; return 1; }
for p in "$REPO_REAL" "$OUT_REAL"; do
    [ "$p" != "/" ] || die "refusing to mount /"
    if [ -n "$HOME_REAL" ]; then
        [ "$p" != "$HOME_REAL" ] || die "refusing to mount HOME: $p"
        case "$HOME_REAL/" in "$p"/*) die "refusing to mount an ancestor of HOME: $p" ;; esac
    fi
    case "$p" in *docker.sock*|/var/run*|/run/*) die "refusing to mount a docker/run path: $p" ;; esac
done
! overlaps "$REPO_REAL" "$OUT_REAL" || die "--repo and --out must not overlap"

# Symlinks that leave the repo are refused before the container sees them.
while IFS= read -r link; do
    target="$(readlink "$link")"
    case "$target" in
        /*) die "symlink with absolute target: ${link#"$REPO_REAL"/}" ;;
        *../*|..) resolved="$(cd "$(dirname "$link")" 2>/dev/null && cd "$(dirname "$target")" 2>/dev/null && pwd -P)/$(basename "$target")" || resolved=""
            case "$resolved" in "$REPO_REAL"/*) ;; *) die "symlink escapes the repo: ${link#"$REPO_REAL"/}" ;; esac ;;
    esac
done < <(find "$REPO_REAL" -path "$REPO_REAL/.git" -prune -o -type l -print 2>/dev/null)

# 32 hex chars of nonce; fail closed if there is no entropy source.
NONCE="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
[ "${#NONCE}" -eq 32 ] || die "no entropy for the result nonce"
NAME="loki-vpr-$$-${NONCE:0:8}"

# The wrapper runs as the container command. The nonce arrives on stdin, so the
# checked command (stdin from /dev/null) never sees it in env or argv.
# shellcheck disable=SC2016  # the script is for the container shell, not this one
WRAPPER='read -r N
cp -a /repo/. /work/ 2>/dev/null || { echo "LOKI_VPR_END $N 125"; exit 125; }
cd /work || exit 125
LOKI_VPR_CMD="$1" T="$2" M="$3"
timeout -s KILL "$T" sh -c "$LOKI_VPR_CMD" </dev/null >/cap/out 2>&1
rc=$?
head -c "$M" /cap/out
printf "\nLOKI_VPR_END %s %s\n" "$N" "$rc"
exit "$rc"'

ARGV=(run --rm -i --name "$NAME" --pull never
    --network none --read-only
    --tmpfs "/work:rw,exec,nosuid,size=256m"
    --tmpfs "/cap:rw,noexec,nosuid,size=64m"
    --tmpfs "/tmp:rw,noexec,nosuid,size=16m"
    --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges
    --pids-limit 256 --memory 512m --memory-swap 512m --cpus 1 --init
    --workdir /work
    -v "$REPO_REAL:/repo:ro"
    -e "PATH=/usr/local/bin:/usr/bin:/bin" -e HOME=/work -e CI=1
    "$IMAGE" sh -c "$WRAPPER" vpr "$CMD" "$TIMEOUT" "$MAX_OUT")

if [ "$PRINT_ARGV" = 1 ]; then
    printf '%s\n' "$DOCKER" "${ARGV[@]}"
    exit 0
fi

write_result() { # status exit_code truncated detail
    local tmp="$OUT_REAL/.result.$$"
    printf '{"status":"%s","exit_code":%s,"output_truncated":%s,"detail":"%s","image":"%s","timeout_s":%s}\n' \
        "$1" "$2" "$3" "$4" "$IMAGE" "$TIMEOUT" >"$tmp" && mv -f "$tmp" "$OUT_REAL/result.json"
}
blocked() { write_result BLOCKED null false "$1"; printf 'verify-pr-sandbox: BLOCKED: %s\n' "$1" >&2; exit 3; }

command -v "$DOCKER" >/dev/null 2>&1 || blocked "docker binary not found"
"$DOCKER" info >/dev/null 2>&1 || blocked "docker daemon unreachable"
"$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || blocked "image not present locally: $IMAGE"

RAW="$OUT_REAL/.raw.$$"
printf '%s\n' "$NONCE" | "$DOCKER" "${ARGV[@]}" >"$RAW" 2>"$RAW.err" &
DPID=$!
start=$SECONDS
killed=0
while kill -0 "$DPID" 2>/dev/null; do
    if [ $((SECONDS - start)) -gt $((TIMEOUT + 15)) ]; then
        "$DOCKER" kill "$NAME" >/dev/null 2>&1 || true
        kill "$DPID" 2>/dev/null || true # a hung client would otherwise block the wait below
        killed=1
        break
    fi
    sleep 1
done
wait "$DPID" 2>/dev/null
drc=$?

end_line="$(grep -a "^LOKI_VPR_END $NONCE " "$RAW" | tail -n 1)"
if [ "$killed" = 1 ]; then
    write_result TIMEOUT null false "host watchdog fired"
elif [ -n "$end_line" ]; then
    rc="${end_line##* }"
    case "$rc" in ''|*[!0-9]*) rc=null ;; esac
    trunc=false
    [ "$(wc -c <"$RAW")" -ge "$MAX_OUT" ] && trunc=true
    # The wrapper exits with the check's code, so a sentinel that disagrees with docker's own exit code is not trusted.
    if [ "$rc" != null ] && [ "$rc" != "$drc" ]; then
        write_result ERROR null false "sentinel exit $rc disagrees with container exit $drc"
    else
        grep -av "^LOKI_VPR_END $NONCE " "$RAW" | head -c "$MAX_OUT" >"$OUT_REAL/.output.$$" && mv -f "$OUT_REAL/.output.$$" "$OUT_REAL/output.txt"
        if [ "$rc" = 137 ]; then write_result TIMEOUT 137 "$trunc" "check exceeded ${TIMEOUT}s"
        else write_result COMPLETED "$rc" "$trunc" "ok"; fi
    fi
elif grep -aqiE "cannot allocate|no space left|too many|pool overlaps|daemon" "$RAW.err"; then
    rm -f "$RAW" "$RAW.err"; blocked "docker resource exhaustion"
else
    write_result ERROR null false "no result sentinel (docker rc $drc)"
fi
rm -f "$RAW" "$RAW.err"
exit 0
