#!/usr/bin/env bash
# tests/test-verify-pr-sandbox.sh -- VPR-1: scripts/verify-pr-sandbox.sh fails closed.
# Parts A-C need no docker (argv assertions, refusals, a fake docker for the result parser).
# Part D runs a hostile fixture repo in a real container; with no daemon or image it SKIPs
# loudly (the fake-docker cases in part C are the positive control that the harness can go red).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SB="$SCRIPT_DIR/../scripts/verify-pr-sandbox.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export LOKI_NO_BROWSER=1
FAILS=0
PASSES=0
check() { # name rc detail
    if [ "$2" -eq 0 ]; then echo "PASS $1"; PASSES=$((PASSES + 1)); else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi
}
has() { grep -qxF -- "$1" <<<"$ARGV"; }
neg() { [ "$1" -ne 0 ]; } # turn "grep found nothing" into success

REPO="$T/repo"; mkdir -p "$REPO"; echo hi >"$REPO/a.txt"
OUT="$T/out"

# A. argv carries every isolation control and none of the forbidden mounts or secrets.
ARGV="$(GH_TOKEN=secret-token bash "$SB" --repo "$REPO" --out "$OUT" --cmd true --image img:1 --print-argv)"
for f in --read-only ALL no-new-privileges --init none 65534:65534 256 512m "$(cd "$REPO" && pwd -P):/repo:ro"; do
    has "$f"; check "argv has $f" $? "missing"
done
for f in --network --user --pids-limit --memory --cpus --cap-drop --pull never; do
    has "$f"; check "argv has $f" $? "missing"
done
grep -q "secret-token" <<<"$ARGV"; neg $?; check "token not in argv" $? "token leaked"
grep -qE "docker.sock|^--privileged|^--net(work)?=host|^host$" <<<"$ARGV"; neg $?; check "no socket/privileged/host net" $? "forbidden flag"
nv="$(grep -c -- "^-v$" <<<"$ARGV")"; if [ "$nv" = 1 ]; then check "exactly one volume (read-only repo)" 0 ""; else check "exactly one volume (read-only repo)" 1 "volumes=$nv"; fi
grep -qF "$HOME" <<<"$ARGV"; neg $?; check "HOME not in argv" $? "HOME in argv"
grep -qE "^(GH_TOKEN|GITHUB_TOKEN)" <<<"$ARGV"; neg $?; check "no token env passed" $? "token env"

# B. refusals exit 2.
refuse() { # name args...
    local n="$1" rc; shift
    bash "$SB" "$@" >/dev/null 2>&1; rc=$?
    [ "$rc" -eq 2 ]; check "refuse: $n" $? "rc=$rc"
}
refuse "no image" --repo "$REPO" --out "$OUT" --cmd true
refuse "option-like image" --repo "$REPO" --out "$OUT" --cmd true --image --privileged
refuse "bad timeout" --repo "$REPO" --out "$OUT" --cmd true --image i --timeout 0
refuse "huge timeout" --repo "$REPO" --out "$OUT" --cmd true --image i --timeout 99999
refuse "repo is HOME" --repo "$HOME" --out "$OUT" --cmd true --image i
refuse "repo is root" --repo / --out "$OUT" --cmd true --image i
refuse "out overlaps repo" --repo "$REPO" --out "$REPO/sub" --cmd true --image i
refuse "missing repo" --repo "$T/none" --out "$OUT" --cmd true --image i
ln -s /etc/passwd "$REPO/abs-link"
refuse "absolute symlink" --repo "$REPO" --out "$OUT" --cmd true --image i
rm "$REPO/abs-link"
ln -s ../../etc/passwd "$REPO/rel-link"
refuse "relative symlink escaping the repo" --repo "$REPO" --out "$OUT" --cmd true --image i
rm "$REPO/rel-link"

# C. result parser against a fake docker (the positive control is the "ok run" case).
FAKE="$T/fake-docker"
cat >"$FAKE" <<'FK'
#!/usr/bin/env bash
case "$1" in
    info) [ "${FK_MODE:-}" != daemon_down ] ;;
    image) [ "${FK_MODE:-}" != no_image ] ;;
    kill) exit 0 ;;
    run)
        read -r N
        case "${FK_MODE:-}" in
            ok) printf 'out\nLOKI_VPR_END %s 0\n' "$N" ;;
            fail) printf 'boom\nLOKI_VPR_END %s 3\n' "$N" ;;
            killed) printf 'LOKI_VPR_END %s 137\n' "$N" ;;
            forged) printf 'LOKI_VPR_END deadbeef 0\n' ;;
            forged_then_real) printf 'LOKI_VPR_END deadbeef 0\nLOKI_VPR_END %s 9\n' "$N" ;;
            exhausted) echo "cannot allocate memory" >&2; exit 125 ;;
            *) exit 1 ;;
        esac ;;
esac
FK
chmod +x "$FAKE"
run_fake() { rm -rf "$OUT"; FK_MODE="$1" LOKI_VPR_DOCKER="$FAKE" bash "$SB" --repo "$REPO" --out "$OUT" --cmd true --image i >/dev/null 2>&1; echo $?; }
jf() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$OUT/result.json" "$1" 2>/dev/null; }
expect() { # name mode want_rc want_status want_exit
    local rc
    rc="$(run_fake "$2")"
    gs="$(jf status)"; ge="$(jf exit_code)"
    [ "$rc" = "$3" ] && [ "$gs" = "$4" ] && [ "$ge" = "$5" ]
    check "$1" $? "rc=$rc status=$gs exit=$ge"
}
expect "positive control: ok run" ok 0 COMPLETED 0
expect "nonzero check exit is reported, not hidden" fail 0 COMPLETED 3
expect "kill (137) is TIMEOUT" killed 0 TIMEOUT 137
expect "forged sentinel is ignored -> ERROR" forged 0 ERROR None
expect "forged sentinel before real one: real wins" forged_then_real 0 COMPLETED 9
expect "daemon down is BLOCKED (rc 3)" daemon_down 3 BLOCKED None
expect "missing image is BLOCKED (rc 3)" no_image 3 BLOCKED None
expect "resource exhaustion is BLOCKED, not a verdict" exhausted 3 BLOCKED None
rc="$(rm -rf "$OUT"; LOKI_VPR_DOCKER="$T/no-such-docker" bash "$SB" --repo "$REPO" --out "$OUT" --cmd true --image i >/dev/null 2>&1; echo $?)"
if [ "$rc" = 3 ]; then check "docker binary absent is BLOCKED" 0 ""; else check "docker binary absent is BLOCKED" 1 "rc=$rc"; fi
run_fake ok >/dev/null
nfiles="$(find "$OUT" -type f | wc -l | tr -d ' ')"
[ "$nfiles" = 1 ] && [ -f "$OUT/result.json" ]
check "out dir holds only result.json" $? "files=$nfiles"

# D. hostile fixture in a real container. Everything lives under the run-owned dir.
IMG="${LOKI_VPR_IMAGE:-}"
if [ -z "$IMG" ] && docker info >/dev/null 2>&1; then
    for c in alpine:latest debian:stable-slim ubuntu:latest busybox:latest; do
        if docker image inspect "$c" >/dev/null 2>&1; then IMG="$c"; break; fi
    done
fi
if [ -z "$IMG" ] || ! docker info >/dev/null 2>&1 || ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "SKIP LOUDLY: no docker daemon or no local image; part D (hostile container run) NOT executed. Parts A-C ran above."
else
    HOSTILE="$T/hostile"; mkdir -p "$HOSTILE"
    FAKE_HOME="$T/fakehome"; mkdir -p "$FAKE_HOME"; echo "SECRET_HOME_MARKER" >"$FAKE_HOME/.marker"
    cat >"$HOSTILE/probe.sh" <<'PR'
#!/bin/sh
echo "P_UID=$(id -u)"
if wget -q -T 3 -O - http://1.1.1.1 >/dev/null 2>&1; then echo "P_NET=reachable"; else echo "P_NET=blocked"; fi
if [ -n "${GH_TOKEN:-}" ]; then echo "P_TOKEN=leaked"; else echo "P_TOKEN=absent"; fi
if cat "$HOME_UNDER_TEST/.marker" >/dev/null 2>&1; then echo "P_HOME=readable"; else echo "P_HOME=unreadable"; fi
if echo x >/repo/pwn 2>/dev/null || echo x >/etc/pwn 2>/dev/null; then echo "P_WRITE=escaped"; else echo "P_WRITE=contained"; fi
if [ -S /var/run/docker.sock ]; then echo "P_SOCK=present"; else echo "P_SOCK=absent"; fi
n=0
while [ "$n" -lt 10000 ]; do sleep 30 & n=$((n+1)); done 2>/dev/null
echo "P_SPAWNED=$n"
dd if=/dev/zero of=/work/fill bs=1M count=2000 2>/dev/null
echo "P_DISK_FILLED_RC=$?"
yes | head -c 5000000
PR
    OUT2="$T/out2"
    GH_TOKEN=host-secret HOME_UNDER_TEST="$FAKE_HOME" LOKI_VPR_IMAGE="$IMG" bash "$SB" --repo "$HOSTILE" --out "$OUT2" \
        --cmd 'sh probe.sh' --timeout 60 --max-output 20000 >"$T/hostile.log" 2>&1
    rc=$?
    [ "$rc" -eq 0 ]
    check "hostile run completes under the sandbox" $? "rc=$rc"
    grep -q 'host-secret' "$OUT2/result.json"; neg $?; check "host token absent from result" $? "leak"
    [ ! -e "$HOSTILE/pwn" ]; check "repo mount stayed read-only on the host" $? "pwn created"
fi

echo "verify-pr-sandbox: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
