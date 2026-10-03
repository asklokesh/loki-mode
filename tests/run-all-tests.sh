#!/usr/bin/env bash
# Loki Mode Test Suite Runner
# Runs all test cases for the Loki Mode skill

set -euo pipefail
# Tests always run headless: no suite may open a browser (S-103).
export LOKI_NO_BROWSER=1 LOKI_CONTROL=0 # tests never ship to a developer's live Control Plane

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# E-154 begin: no test run may write the real ~/.loki/keys. Default the signing
# key file to a run-owned temp dir unless the caller already chose one.
_e154_real_keys="${HOME:-/nonexistent}/.loki/keys"
_e154_keys_before="$(ls -A "$_e154_real_keys" 2>/dev/null || true)"
if [ -z "${LOKI_TEST_LIST:-}" ] && [ -z "${LOKI_RECEIPT_SIGNING_KEY_FILE:-}" ]; then
    # shellcheck source=../eval/loki10/lib-tmp.sh
    . "$REPO_ROOT/eval/loki10/lib-tmp.sh"
    if loki_run_tmp_create; then
        export LOKI_RECEIPT_SIGNING_KEY_FILE="$LOKI_RUN_TMP/receipt-ed25519.pem"
        # Keep LOKI_RUN_TMP as a runner-private shell variable only: exported, it
        # makes every child suite's own loki_run_tmp_create refuse ("already set").
        export -n LOKI_RUN_TMP
        trap 'loki_run_tmp_cleanup || true' EXIT
    fi
fi
# E-154 end
TOTAL_PASSED=0
TOTAL_FAILED=0
TESTS_RUN=0
TIMED_OUT_SUITES=""
_current_suite_pid=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Per-suite timeout (BACKLOG 143). CI's "Shell tests" shard 2 was repeatedly
# cancelled by the workflow's `cancel-in-progress` concurrency group before it
# could finish, because it was still running tests/test-ci-json-argmax.sh when
# the next push arrived (github.com/.../actions/runs/36304977243 and 3 more,
# 2026-09-27). On the one run that WAS allowed to finish
# (github.com/.../actions/runs/36299762731, shard 2 job 108565132341),
# test-ci-json-argmax.sh alone took 1327s (22m07s); every other suite across
# all 4 shards on that same green run finished in <=191s
# (test-trust-core-tests-detect.sh's real `bun test` mutation probes). The
# suite was added in b842a332 (2026-09-26) and its fixture was resized in
# 5c9d4373 the same day to actually clear Linux CI's measured ~4 MiB ARG_MAX
# (~116K findings there vs ~29K on macOS's ~1 MiB ARG_MAX); no shard-2-only
# timing from before either commit was captured, so this cannot pin the
# runtime on one commit over the other -- only that the measured 1327s is real
# and current. Follow-up: shrink the fixture or move the suite out of the
# sharded job. A hang in any OTHER suite now fails LOUD and FAST instead of
# silently consuming the rest of the shard's budget until a human notices and
# cancels the run.
#
# LOKI_TEST_SUITE_TIMEOUT overrides the default (seconds); 0 disables entirely
# (including the override list below). No runner sets this today; an operator
# can export it before invoking tests/run-all-tests.sh directly or via
# scripts/local-ci.sh, e.g. to raise it when running shards in parallel on one
# machine inflates each suite's wall-clock.
_suite_timeout_default="${LOKI_TEST_SUITE_TIMEOUT:-450}"
case "$_suite_timeout_default" in '' | *[!0-9]*) _suite_timeout_default=450 ;; esac

# Resolve a timeout binary ONCE. macOS ships no `timeout`; Homebrew's coreutils
# provides `gtimeout`. Missing entirely -> run untimed (today's behavior) with
# one notice, never rc 127 masquerading as a suite failure. Verified against
# GNU coreutils 9.11 (default process-group kill, -k for a trapped TERM); BSD
# timeout (macOS without coreutils, if ever added to PATH) is not verified here.
_timeout_bin=""
if command -v timeout >/dev/null 2>&1; then
    _timeout_bin="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
    _timeout_bin="gtimeout"
else
    echo -e "${YELLOW}Note: no 'timeout'/'gtimeout' on PATH -- suites run without a per-suite timeout.${NC}"
fi

# Forward Ctrl-C (and a `kill`'s SIGTERM) to whichever suite is currently
# running under the timeout wrapper below. `timeout` makes ITSELF the leader
# of a new process group and the suite inherits that group, so a signal sent
# to the RUNNER's own process group (an interactive Ctrl-C) never reaches it.
# Without this trap, stopping a run stuck in a timeout-wrapped hang means
# waiting out the full per-suite budget (up to 900s for the trust-core override)
# instead of a normal Ctrl-C.
#
# Installed ONLY when a real per-suite timeout is in play (a timeout binary
# exists AND the default is not 0): bash defers a caught signal until the
# current FOREGROUND command returns, so installing this trap unconditionally
# would change the untimed/disabled path too -- a `kill -TERM` on the runner
# would wait for the running (foreground, unbackgrounded) suite to finish
# instead of stopping immediately, which is not what the original runner did.
if [ -n "$_timeout_bin" ] && [ "$_suite_timeout_default" -gt 0 ]; then
    _forward_signal() {
        local _exit_code="$1"
        # Always forward TERM, never the signal the runner itself received.
        # Verified directly (not assumed): under the `&`-backgrounded launch
        # below, sending an external SIGINT straight to `timeout` did NOT
        # reach its child -- because bash starts every asynchronous (`&`)
        # command with SIGINT and SIGQUIT already ignored, and an ignored
        # signal can never be caught by a trap set up afterward, in this
        # script OR inside the suite. TERM is not one of the two signals bash
        # ignores for an async command, so it always reaches `timeout`
        # (confirmed directly) regardless of which signal the runner itself
        # caught.
        if [ -n "$_current_suite_pid" ] && kill -0 "$_current_suite_pid" 2>/dev/null; then
            kill -TERM "$_current_suite_pid" 2>/dev/null || true
            wait "$_current_suite_pid" 2>/dev/null || true
        fi
        exit "$_exit_code"
    }
    trap '_forward_signal 143' TERM
    trap '_forward_signal 130' INT
fi

# Suites whose real, legitimate work exceeds the default. Keyed on basename so
# the override survives the suite moving between shards. Every entry must name
# why, and the measured time it is sized against.
#
# LOKI_TEST_SUITE_TIMEOUT=0 must disable EVERY suite's timeout, including
# these overrides -- an operator asking for no timeout means none, not "none
# except the suites we specifically chose to still kill."
_suite_timeout_for() {
    if [ "$_suite_timeout_default" -eq 0 ]; then
        echo 0
        return
    fi
    case "$(basename -- "$1")" in
        # BACKLOG 143 / S-79: test-ci-json-argmax.sh used to need 2400s
        # (1327s measured, run 36299762731, 2026-09-27) because cmd_ci forked
        # echo+cut once per finding while tallying and rendering the full
        # ARG_MAX-scale fixture (~116K findings). Fixed at the source in
        # autonomy/loki (${match%%:*} / IFS='|' read, no per-finding fork);
        # the fixture itself is unchanged and still sized for total ARG_MAX
        # on every run. Measured post-fix: 4.4s Linux (docker ubuntu:24.04),
        # 4.6s macOS, 8.9s at a 4 MiB ARG_MAX -- all well inside the 450s
        # default, so no override is needed here.
        #
        # Real `bun test` mutation probes (trust-core regression detection),
        # not a fixed-size fixture. Measured: 191s solo (CI shard 2, run
        # 36299762731); locally on this machine, 281s solo (4-shard parallel
        # local run, first pass), 248s and 228s in two later 4-way-parallel
        # runs (scripts/local-ci.sh's full tier runs all shards at once,
        # which inflates every suite's wall-clock the same way, and this
        # machine also had other unrelated sessions running concurrently).
        # 450s (the default) is only ~1.6x the highest local figure (281s);
        # this override gives it the same >=2x margin the other suites get.
        test-trust-core-tests-detect.sh) echo 900 ;;
        *) echo "$_suite_timeout_default" ;;
    esac
}

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          LOKI MODE - COMPREHENSIVE TEST SUITE                  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# SHARDING (S-81, supersedes the plain idx%n split). LOKI_TEST_SHARD=i/n
# splits the suite list across n runners so N runners cut the wall clock by
# roughly N -- but a plain `index % n` split ignores that suites are wildly
# uneven (496 suites from ~0s to 153s measured; see tests/shard-durations.tsv),
# so whichever shard happened to catch the slowest suites set the whole
# workflow's wall clock regardless of n. Measured directly: at n=4 one shard
# held test-ci-json-argmax.sh (1146-1460s alone) while the other three
# finished in 4-8 minutes each.
#
# Fix: assign each suite to a shard by deterministic greedy longest-first
# (LPT) bin-packing over tests/shard-durations.tsv's measured per-suite
# seconds, instead of by index. Suites are sorted longest-first, then each
# goes to whichever shard currently has the smallest running total (ties
# broken by lowest shard number) -- the standard LPT heuristic, computed once
# per invocation from this file's own run_test registration order.
#
# STILL INDEX-BASED FOR REGISTRATION, NOT A CURATED LIST: the packing reads
# every `run_test` call from THIS file in source order (the same grep
# tests/test-shard-coverage.sh uses for its own count) and looks each one up
# by name in the duration table; nothing is hand-maintained per suite. A
# suite missing from the table (new, not yet measured) still gets a shard via
# _shard_default_duration_s below -- it is never silently dropped, and the
# union of all shards is still provably the whole suite list.
#
# The precedent this repo already paid for: a shellcheck "optimization" that
# was ~2x faster and SILENTLY LOST 2 real failures. It was reverted. Speed
# that stops noticing failures is worse than slow. tests/test-shard-coverage.sh
# asserts the shards partition the suite list exactly -- every suite in
# exactly one shard, none dropped, none duplicated -- for every n it checks.
_shard_durations_file="$SCRIPT_DIR/shard-durations.tsv"
_shard_default_duration_s=30
_shard_index=0
_shard_i=""
_shard_n=""
_shard_assign=()
if [ -n "${LOKI_TEST_SHARD:-}" ]; then
    _shard_i="${LOKI_TEST_SHARD%%/*}"
    _shard_n="${LOKI_TEST_SHARD##*/}"
    case "$_shard_i$_shard_n" in
        ''|*[!0-9]*)
            echo "run-all-tests: LOKI_TEST_SHARD must be i/n with integers (got '$LOKI_TEST_SHARD')" >&2
            exit 2 ;;
    esac
    if [ "$_shard_n" -lt 1 ] || [ "$_shard_i" -ge "$_shard_n" ]; then
        echo "run-all-tests: invalid shard '$LOKI_TEST_SHARD' (need 0 <= i < n, n >= 1)" >&2
        exit 2
    fi
    echo -e "${BLUE}Shard ${_shard_i} of ${_shard_n} -- duration-balanced (LPT), not index modulo${NC}"
    echo ""

    # One awk pass computes the whole assignment: read this script's own
    # run_test lines in order (ground truth for suite count/order), join each
    # against the duration table by exact name, LPT-pack into _shard_n bins,
    # print the resulting shard number per suite index in registration order.
    # A missing/unreadable duration file degrades to every suite using the
    # default duration -- still a valid, deterministic partition, never a
    # dropped suite.
    _shard_assign_str="$(awk -v n="$_shard_n" -v defdur="$_shard_default_duration_s" -v durfile="$_shard_durations_file" '
        BEGIN {
            while ((getline line < durfile) > 0) {
                if (line == "" || substr(line, 1, 1) == "#") continue
                split(line, f, "\t")
                dur[f[1]] = f[2] + 0
            }
            close(durfile)
        }
        /^[ \t]*run_test "/ {
            q1 = index($0, "\"")
            rest = substr($0, q1 + 1)
            q2 = index(rest, "\"")
            name = substr(rest, 1, q2 - 1)
            names[count] = name
            secs[count] = (name in dur) ? dur[name] : defdur
            count++
        }
        END {
            for (i = 0; i < count; i++) order[i] = i
            for (i = 0; i < count; i++) {
                best = i
                for (j = i + 1; j < count; j++) {
                    if (secs[order[j]] > secs[order[best]] || \
                        (secs[order[j]] == secs[order[best]] && order[j] < order[best])) {
                        best = j
                    }
                }
                tmp = order[i]; order[i] = order[best]; order[best] = tmp
            }
            for (s = 0; s < n; s++) total[s] = 0
            # start rotates after every pick. Without this, a tie always
            # resolves to the lowest shard number and NEVER moves off it --
            # most suites here measure 0-1s, so hundreds of true ties would
            # all pile onto shard 0 while shard 7 sat near-empty. Rotating the
            # scan start spreads ties round-robin instead.
            start = 0
            for (k = 0; k < count; k++) {
                idx = order[k]
                pick = start
                best_total = total[start]
                for (kk = 1; kk < n; kk++) {
                    s = (start + kk) % n
                    if (total[s] < best_total) { pick = s; best_total = total[s] }
                }
                shardof[idx] = pick
                total[pick] += secs[idx]
                start = (pick + 1) % n
            }
            out = ""
            for (idx = 0; idx < count; idx++) out = out shardof[idx] " "
            print out
        }
    ' "$SCRIPT_DIR/run-all-tests.sh")"
    read -ra _shard_assign <<< "$_shard_assign_str"

    # Fail loudly if the awk pass produced fewer entries than there are
    # run_test calls (a broken awk, an unreadable source file, anything that
    # makes the assignment short). Without this check a short/empty
    # _shard_assign makes EVERY suite's lookup miss -- every shard would
    # silently run zero suites and print "ALL TESTS PASSED" with nothing
    # tested, exactly the failure mode the old idx%n scheme could never have.
    _shard_registered=$(grep -cE '^[[:space:]]*run_test ' "$SCRIPT_DIR/run-all-tests.sh")
    if [ "${#_shard_assign[@]}" -ne "$_shard_registered" ]; then
        echo "run-all-tests: shard assignment produced ${#_shard_assign[@]} entries for $_shard_registered registered suites -- refusing to run with a broken partition" >&2
        exit 2
    fi
fi

# Quarantine (CEO Part C item 14). tests/quarantine.txt lists suites whose
# failure is reported but does not block the run -- each entry names an owner
# and an issue so a quarantine cannot silently become permanent, and an
# expiry so a stale entry ages out loud instead of quietly staying forever.
# Keyed by the suite's script basename, the same key _suite_timeout_for above
# already uses for its own override table, so one lookup convention covers
# both files.
#
# Validated once, up front, before any suite runs: an invalid entry (bad
# format, expired, more than 7 days out, or a moat/review suite) fails the
# whole run immediately rather than being silently ignored or silently
# accepted. No retry -- fix the entry or remove it.
_quarantine_file="$SCRIPT_DIR/quarantine.txt"
_quarantine_suites=$'\n'
TOTAL_QUARANTINED=0
QUARANTINED_SUITES=""

_quarantine_reject() {
    echo "run-all-tests: quarantine.txt: $1" >&2
    exit 2
}

# Read one date (YYYY-MM-DD) as epoch seconds, GNU first then BSD, validating
# the captured value rather than trusting exit status -- same shape as
# loki_run_tmp_stat_field's GNU/BSD stat handling elsewhere in this repo's
# tooling, because each date implementation rejects the other's flags
# differently and only the captured value is trustworthy. Forced to UTC on
# both branches: a local-time parse near a DST transition can shift the
# 86400-second day math by an hour, and "today" below is already formatted in
# UTC (`date -u`), so both sides of the subtraction must agree on zone.
_quarantine_date_epoch() {
    local d="$1" v
    v="$(TZ=UTC date -d "$d" +%s 2>/dev/null)" || v=''
    case "$v" in '' | *[!0-9]*) v="$(TZ=UTC date -j -f '%Y-%m-%d' "$d" +%s 2>/dev/null)" || v='' ;; esac
    case "$v" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s\n' "$v"
}

if [ -f "$_quarantine_file" ]; then
    _q_today_epoch="$(_quarantine_date_epoch "$(date -u +%Y-%m-%d)")" || {
        echo "run-all-tests: quarantine.txt: could not resolve today's date" >&2
        exit 2
    }
    _q_lineno=0
    while IFS= read -r _q_line || [ -n "$_q_line" ]; do
        _q_lineno=$((_q_lineno + 1))
        case "$_q_line" in
            '' | '#'*) continue ;;
        esac
        _q_suite="" _q_owner="" _q_expiry="" _q_issue=""
        IFS=$'\t' read -r _q_suite _q_owner _q_expiry _q_issue <<<"$_q_line"
        if [ -z "$_q_suite" ] || [ -z "$_q_owner" ] || [ -z "$_q_expiry" ] || [ -z "$_q_issue" ]; then
            _quarantine_reject "line $_q_lineno: need suite<TAB>owner<TAB>expiry<TAB>issue, got '$_q_line'"
        fi
        case "$_q_expiry" in
            [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
            *) _quarantine_reject "line $_q_lineno: expiry '$_q_expiry' is not YYYY-MM-DD" ;;
        esac
        case "$_q_suite" in
            moat/* | */moat/*) _quarantine_reject "line $_q_lineno: '$_q_suite' is under tests/moat/ and can never be quarantined" ;;
            *review*) _quarantine_reject "line $_q_lineno: '$_q_suite' matches *review* and can never be quarantined" ;;
        esac
        # The suite field is documented as a bare script basename, so a moat
        # script named without its "moat/" prefix (e.g. just
        # "p1-portable-proof.sh") would slip past the case pattern above while
        # still naming a real file under tests/moat/. Check the actual path,
        # not only the spelling.
        if [ -e "$SCRIPT_DIR/moat/${_q_suite##*/}" ]; then
            _quarantine_reject "line $_q_lineno: '$_q_suite' names a script under tests/moat/ and can never be quarantined"
        fi
        _q_expiry_epoch="$(_quarantine_date_epoch "$_q_expiry")" \
            || _quarantine_reject "line $_q_lineno: expiry '$_q_expiry' could not be parsed"
        if [ "$_q_expiry_epoch" -lt "$_q_today_epoch" ]; then
            _quarantine_reject "line $_q_lineno: '$_q_suite' expired on $_q_expiry"
        fi
        if [ $(( (_q_expiry_epoch - _q_today_epoch) / 86400 )) -gt 7 ]; then
            _quarantine_reject "line $_q_lineno: '$_q_suite' expiry $_q_expiry is more than 7 days out"
        fi
        _quarantine_suites="${_quarantine_suites}${_q_suite}"$'\n'
    done < "$_quarantine_file"
fi

_quarantine_is_listed() {
    case "$_quarantine_suites" in
        *$'\n'"$1"$'\n'*) return 0 ;;
        *) return 1 ;;
    esac
}

run_test() {
    local test_name="${1:-}"
    local test_file="${2:-}"

    # Take this suite's index BEFORE any skip, so indices are stable regardless
    # of which shard is running -- the awk pass above walks run_test calls in
    # this same source order, so _shard_assign[idx] always names the shard for
    # this same suite, on every shard's invocation.
    local _idx=$_shard_index
    _shard_index=$((_shard_index + 1))
    # S-174: a registration with a missing or empty command used to die on
    # "$2: unbound variable" (no summary, every later suite skipped) or pass as
    # `bash -c ""`. Count it as one failure and keep going. Placed after the
    # index increment (LPT slots stay put) and before the shard skip (every
    # shard reports it). stderr keeps LOKI_TEST_LIST stdout clean; the word
    # FAILED keeps the local-ci scraper matching.
    if [ "$#" -lt 2 ] || [ -z "$test_file" ]; then
        echo -e "${RED}✗ ${test_name:-<unnamed>} FAILED: malformed registration at run-all-tests.sh line ${BASH_LINENO[0]} (needs a name and a non-empty command)${NC}" >&2
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        return 0
    fi
    if [ -n "$_shard_n" ] && [ "${_shard_assign[_idx]:-}" != "$_shard_i" ]; then
        return 0
    fi

    # LOKI_TEST_LIST=1: print the suite name and stop, no execution. Lets
    # tests/test-shard-coverage.sh (and a CI dry run) verify the real
    # partition -- the same lookup run_test uses, not a re-implementation of
    # it -- without paying for up to 496 suite executions per shard checked.
    if [ -n "${LOKI_TEST_LIST:-}" ]; then
        echo "$test_name"
        return 0
    fi

    # A registration whose script does not exist is a BOOKKEEPING fault, not a
    # product failure, and it must say so. Four suites failed this way on a
    # cherry-pick that took the registrations without the files, and the CI log
    # read exactly like four real regressions -- the message is what cost the
    # time, not the fix. Fails loudly rather than skipping: a silently skipped
    # registration is a suite nobody runs and nobody misses.
    # Two registration forms exist here: a bare path, and a full command
    # ("python3 -m pytest -q $SCRIPT_DIR/x.py"). Checking the raw value with
    # -f treats a command as a filename and reports a PRESENT file as missing,
    # which my first version did -- it failed a suite whose script was on disk.
    # So resolve the path OUT of either form, and check only that.
    local _script_path="$test_file"
    case "$test_file" in
        *" "*)
            # Command form: the script is the last whitespace-separated token
            # that looks like a path to a test file. Node suites (.mjs/.js)
            # count too: with no matching token this grep exits 1, and under
            # set -e that assignment would end the whole runner.
            _script_path="$(printf '%s\n' $test_file | grep -E '\.(sh|py|mjs|js)$' | tail -1)"
            ;;
    esac
    if [ -n "$_script_path" ] && [ ! -f "$_script_path" ]; then
        echo -e "${RED}✗ ${test_name}: registered but its script is MISSING (${_script_path##*/})${NC}"
        echo -e "${RED}  This is a stale run_test registration, not a code defect.${NC}"
        echo -e "${RED}  Either restore the script or remove the registration.${NC}"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        # return 0: under set -e a non-zero return ended the whole run (S-174).
        return 0
    fi

    echo -e "${YELLOW}┌────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${YELLOW}│ Running: ${test_name}${NC}"
    echo -e "${YELLOW}└────────────────────────────────────────────────────────────────┘${NC}"
    echo ""

    TESTS_RUN=$((TESTS_RUN + 1))

    local _suite_timeout
    _suite_timeout="$(_suite_timeout_for "$_script_path")"
    local _timeout_label="${_suite_timeout}s"
    if [ -z "$_timeout_bin" ] || [ "$_suite_timeout" -eq 0 ]; then
        _timeout_label="untimed"
    fi
    echo "[$(date -u +%FT%TZ)] START: ${test_name} (timeout ${_timeout_label})"
    local _t0=$SECONDS

    # Most callers pass a bare path; two pass a full command line
    # ("python3 .../x.py"). `bash "$cmd"` treats the whole string as ONE
    # filename, so those two died with "No such file or directory" and reported
    # as a product failure. Branch on what the argument actually is.
    #
    # Deliberately NOT `bash -c "$test_file"` for everything: -c execve's the
    # file, which requires the exec bit, and 46 shell suites here are committed
    # mode 100644. That swap turns every one of them into rc 126.
    # E-155: a suite must never move the parent checkout's HEAD or branch.
    local _e155_ref_before _e155_sha_before
    _e155_ref_before="$(git -C "$REPO_ROOT" symbolic-ref -q HEAD 2>/dev/null || true)"
    _e155_sha_before="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"

    local _rc=0
    local _elapsed
    if [ -n "$_timeout_bin" ] && [ "$_suite_timeout" -gt 0 ]; then
        # Launch `timeout` via `exec` inside a subshell -- never through an
        # intermediate shell FUNCTION. `$!` after backgrounding a function is
        # the PID of the subshell running that function, not of `timeout`
        # itself (verified directly: they end up in different process
        # groups), so forwarding a signal to it would kill the wrapper and
        # leave `timeout` and the suite as orphans. `exec` inside this
        # subshell keeps `$!` as `timeout`'s own PID.
        #
        # Backgrounding a command is not signal-neutral (verified directly,
        # not assumed): bash starts every `&` job with SIGINT and SIGQUIT
        # already ignored (POSIX/bash async-command default) -- an ignored
        # signal can never be caught by a trap set up afterward, in this
        # script OR inside the suite. `trap - INT QUIT` resets both to their
        # inherited (default) disposition before `timeout` replaces this
        # subshell. This is why `_forward_signal` always sends TERM (never
        # INT) to `timeout`: TERM is not one of the two signals bash ignores
        # for an async command.
        #
        # Explicit `</dev/null` (not the caller's real stdin): the suite runs
        # in `timeout`'s own backgrounded process group, and if stdin were a
        # real TTY, any read from it would stop the suite with SIGTTIN --
        # producing a false TIMEOUT that neither CI (never a TTY) nor the
        # original foreground dispatch would ever hit. /dev/null matches
        # CI's actual non-TTY stdin, which every suite already runs under.
        if [ -f "$test_file" ]; then
            ( trap - INT QUIT; exec "$_timeout_bin" -k 10 "$_suite_timeout" bash "$test_file" ) </dev/null &
        else
            ( trap - INT QUIT; exec "$_timeout_bin" -k 10 "$_suite_timeout" bash -c "$test_file" ) </dev/null &
        fi
        _current_suite_pid=$!
        # bash defers a trap until the current foreground command returns;
        # backgrounding + `wait` is what lets the INT/TERM trap above run
        # WHILE the suite is still executing, so it has a live PID to forward
        # the signal to, instead of only after the suite (or its timeout)
        # already exited on its own.
        wait "$_current_suite_pid" || _rc=$?
        _current_suite_pid=""
        _elapsed=$((SECONDS - _t0))
    else
        # No timeout in play: run exactly as the original dispatch did
        # (foreground, no backgrounding) so this path is byte-identical to
        # pre-existing behavior -- `test-run-all-dispatch.sh` pins this exact
        # if/else shape, and backgrounding here would also make bash ignore
        # SIGINT/SIGQUIT for the suite (job-control default for an
        # asynchronous command), which the untimed/disabled path must not do.
        if [ -f "$test_file" ]; then
            bash "$test_file" || _rc=$?
        else
            bash -c "$test_file" || _rc=$?
        fi
        _elapsed=$((SECONDS - _t0))
    fi

    local _e155_ref_after _e155_sha_after _e154_keys_after
    _e155_ref_after="$(git -C "$REPO_ROOT" symbolic-ref -q HEAD 2>/dev/null || true)"
    _e155_sha_after="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
    if [ "$_e155_ref_before" != "$_e155_ref_after" ] || [ "$_e155_sha_before" != "$_e155_sha_after" ]; then
        echo -e "${RED}$(printf '\342\234\227') ${test_name} FAILED: it changed the parent checkout HEAD (E-155): ${_e155_ref_before:-detached}@${_e155_sha_before:0:8} -> ${_e155_ref_after:-detached}@${_e155_sha_after:0:8}${NC}"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi
    _e154_keys_after="$(ls -A "$_e154_real_keys" 2>/dev/null || true)"
    if [ "$_e154_keys_after" != "$_e154_keys_before" ]; then
        echo -e "${RED}$(printf '\342\234\227') ${test_name} FAILED: it changed the real ${_e154_real_keys} (E-154)${NC}"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        _e154_keys_before="$_e154_keys_after"
    fi

    # GNU timeout exits 124 on its own SIGTERM kill, 137 if -k's SIGKILL
    # was needed. Only call it a TIMEOUT when the exit code matches AND the
    # suite actually ran the full budget -- several suites here legitimately
    # test timeout paths and may pass through 124/137 on their own well under
    # the limit, and that must stay a normal pass/fail, not get relabeled.
    local _timed_out=0
    if [ -n "$_timeout_bin" ] && [ "$_suite_timeout" -gt 0 ] && [ "$_elapsed" -ge "$_suite_timeout" ]; then
        case "$_rc" in 124 | 137) _timed_out=1 ;; esac
    fi

    # Quarantine check happens before the pass/fail branches below so a
    # quarantined suite's failure (or timeout) is reported but never touches
    # TOTAL_FAILED -- the one counter the exit-code gate at the bottom of this
    # file reads. Only intercepts a NON-zero rc; a quarantined suite that
    # passes is just a pass, counted normally.
    local _quarantined=0
    if [ "$_rc" -ne 0 ] && _quarantine_is_listed "$(basename -- "$_script_path")"; then
        _quarantined=1
    fi

    if [ "$_rc" -eq 0 ]; then
        echo ""
        echo -e "${GREEN}✓ ${test_name} PASSED${NC}"
        echo "[$(date -u +%FT%TZ)] END: ${test_name} (${_elapsed}s)"
        TOTAL_PASSED=$((TOTAL_PASSED + 1))
    elif [ "$_quarantined" -eq 1 ]; then
        echo ""
        if [ "$_timed_out" -eq 1 ]; then
            echo -e "${YELLOW}~ ${test_name} QUARANTINED: timed out after ${_suite_timeout}s (non-blocking, see tests/quarantine.txt)${NC}"
        else
            echo -e "${YELLOW}~ ${test_name} QUARANTINED: rc=${_rc} (non-blocking, see tests/quarantine.txt)${NC}"
        fi
        echo "[$(date -u +%FT%TZ)] END: ${test_name} QUARANTINED (${_elapsed}s)"
        QUARANTINED_SUITES="${QUARANTINED_SUITES}${test_name} (${_script_path##*/}, rc=${_rc})"$'\n'
        TOTAL_QUARANTINED=$((TOTAL_QUARANTINED + 1))
    elif [ "$_timed_out" -eq 1 ]; then
        echo ""
        # Must contain the literal substring "FAILED" (not just the ✗ glyph):
        # scripts/local-ci.sh scrapes suite output with
        # grep -aE '(✗.*FAILED|Passed: {5,}[0-9]|Failed: {5,}[0-9])' and tails
        # the result. A timeout line missing "FAILED" is invisible to that
        # scraper -- it would show "Failed: 1" with no suite name, exactly the
        # silent-culprit problem this feature exists to fix.
        echo -e "${RED}✗ ${test_name} FAILED: TIMED OUT after ${_suite_timeout}s (killed, not a normal failure)${NC}"
        echo -e "${RED}  This suite was terminated by the per-suite watchdog, not by its own assertions.${NC}"
        echo -e "${RED}  It is hanging or has regressed to run past its budget -- diagnose ${_script_path##*/} directly.${NC}"
        echo "::error title=Suite timeout::${test_name} (${_script_path##*/}) killed after ${_suite_timeout}s"
        echo "[$(date -u +%FT%TZ)] END: ${test_name} TIMEOUT (${_elapsed}s)"
        TIMED_OUT_SUITES="${TIMED_OUT_SUITES}${test_name} (${_script_path##*/}, ${_elapsed}s)"$'\n'
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    else
        echo ""
        echo -e "${RED}✗ ${test_name} FAILED${NC}"
        echo "[$(date -u +%FT%TZ)] END: ${test_name} FAILED (${_elapsed}s)"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi

    echo ""
    echo ""
}

# Run all tests
run_test "Bootstrap Tests" "$SCRIPT_DIR/test-bootstrap.sh"
run_test "Task Queue Tests" "$SCRIPT_DIR/test-task-queue.sh"
run_test "Circuit Breaker Tests" "$SCRIPT_DIR/test-circuit-breaker.sh"
run_test "Timeout & Stuck Process Tests" "$SCRIPT_DIR/test-agent-timeout.sh"
run_test "State Recovery Tests" "$SCRIPT_DIR/test-state-recovery.sh"
run_test "Wrapper Script Tests" "$SCRIPT_DIR/test-wrapper.sh"

# Memory System Tests
run_test "Memory Engine Tests" "$SCRIPT_DIR/test-memory-engine.sh"
run_test "Memory Retrieval Tests" "$SCRIPT_DIR/test-memory-retrieval.sh"
run_test "Memory Layers Tests" "$SCRIPT_DIR/test-memory-layers.sh"
run_test "Memory CLI Tests" "$SCRIPT_DIR/test-memory-cli.sh"

# Event Bus Tests
run_test "Event Bus Tests" "$SCRIPT_DIR/test-event-bus.sh"
run_test "Event Bus Exact-Id Match (bus.ts)" "$SCRIPT_DIR/test-event-bus-exact-id.sh"

# Hooks and MCP Tests
run_test "Hooks System Tests" "$SCRIPT_DIR/test-hooks.sh"
run_test "MCP Server Tests" "$SCRIPT_DIR/test-mcp-server.sh"

# Healing Hooks (legacy-system healing safety gates)
run_test "Healing Hooks Safety Tests" "$SCRIPT_DIR/test-healing-hooks-safety.sh"
run_test "Healing Snapshot Revert Tests" "$SCRIPT_DIR/test-healing-snapshot-revert.sh"
run_test "Healing Boundary-Equivalence Gate Tests" "$SCRIPT_DIR/test-healing-boundary-equivalence.sh"
run_test "Healing Friction Gate Tests" "$SCRIPT_DIR/test-healing-friction-gate.sh"

# Parallel worktree Claude auto-flags (effort/budget/fallback/mcp parity)
run_test "Worktree Auto-Flags Tests" "$SCRIPT_DIR/test-worktree-auto-flags.sh"
run_test "Worktree install cache keyed on lockfile hash (E-130)" "$SCRIPT_DIR/test-worktree-install-cache.sh"
run_test "WhatsNew CURRENT_VERSION matches VERSION (E-129)" "$SCRIPT_DIR/test-whatsnew-version-sync.sh"
run_test "Merge-queue log-once + nested-agent parallel guard (client parallel-issue fix)" "$SCRIPT_DIR/test-merge-queue-log-once.sh"
run_test "loki merge queue: green-only serial merge, rebase next, dry-run" "timeout -k 10 120 $SCRIPT_DIR/test-loki-merge-queue.sh"

# v8: raw-SDK judge/text bridges (fail-closed, opt-in, binary-free ordering)
run_test "v8 SDK judge bridge (done-recognition + council-v2)" "$SCRIPT_DIR/test-sdk-done-recog-bridge.sh"
run_test "v8 SDK text bridge (grill + prd-enrich)" "$SCRIPT_DIR/test-sdk-text-bridge.sh"
run_test "v8 SDK council VOTE (member + contrarian, trust core)" "$SCRIPT_DIR/test-sdk-council-vote.sh"
run_test "v8 SDK voter-agents council (Epic C, finding schema)" "$SCRIPT_DIR/test-sdk-voter-agents.sh"
run_test "v8 SDK-loop start routing (LOKI_SDK_LOOP gate, default-off)" "$SCRIPT_DIR/test-sdk-loop-routing.sh"
run_test "D65 shim routing (slack, answer, jira, linear)" "$SCRIPT_DIR/test-d65-routing.sh"
run_test "SDK version sync (root package.json/lockfile/Dockerfile vs loki-ts, E-106)" "$SCRIPT_DIR/test-sdk-version-sync.sh"
run_test "v8 Structured Review Self-Copy Asset Resolution" "$SCRIPT_DIR/test-code-review-self-copy.sh"
run_test "Review deadline, requirements, and speculative assurance tail" "$SCRIPT_DIR/test-review-assurance-tail.sh"

# Completion-council effective threshold (operator tighten-only floor + size guard)
run_test "Council Threshold Tests" "$SCRIPT_DIR/test-council-threshold.sh"
run_test "Healing Test Gate Tests" "$SCRIPT_DIR/test-healing-test-gate.sh"

# v7.114.0 accuracy/speed moat batch (ranks 2, 8, 9, 15)
run_test "RARV mode-aware + PARALLEL_TOOL_CALLS build_prompt (rank 16+8)" "$SCRIPT_DIR/test-rarv-parallel-build-prompt.sh"
run_test "Mergeability reviewer + quality score (rank 9 run_code_review)" "$SCRIPT_DIR/test-mergeability-review.sh"
run_test "Code-review gitignore filter + oversized-diff loud-fail (client fix)" "$SCRIPT_DIR/test-review-gitignore-filter.sh"
run_test "Code-review compact lockfile context and explicit size rejection" "$SCRIPT_DIR/test-review-lockfile-context.sh"
run_test "Code-review size caps derive from PROVIDER_CONTEXT_WINDOW" "$SCRIPT_DIR/test-review-context-window-caps.sh"
run_test "Council Convergence Floor (rank 15 no-claim early check)" "$SCRIPT_DIR/test-council-convergence-floor.sh"
run_test "Council failed_count honesty (S-157 member vote + convergence)" "$SCRIPT_DIR/test-council-failed-count-honesty.sh"
run_test "Acceptance-oracle source-grounded (rank 2 routes/LSP-symbols/invariant)" "$SCRIPT_DIR/test-oracle-source-grounded.sh"

# Batch-3 verify.sh: rank 10 code-scope/locality record (advisory-first) + rank 7
# setup-recipe writer (env NAMES only, never secret values).
run_test "Verify scope record (rank 10 locality, advisory-first)" "$SCRIPT_DIR/test-verify-scope-record.sh"
run_test "Verify setup-recipe writer (rank 7, env NAMES not values)" "$SCRIPT_DIR/test-verify-setup-recipe.sh"

# Task #79 trust defect: node --test (built-in Node runner, no package.json)
# detection in BOTH enforce_test_coverage (run.sh) and verify_gate_tests
# (verify.sh). A passing slug.js+slug.test.js was recorded as
# source_without_tests -> NOT VERIFIED (false-negative, symmetric to fake-green).
run_test "node --test detection (run.sh + verify.sh, task #79 false-negative)" "$SCRIPT_DIR/test-node-test-detection.sh"
run_test "LOKI_DIR double-.loki path guard (#80 COMPLETED marker)" "$SCRIPT_DIR/test-loki-dir-double-path.sh"
run_test "zero-test-file inconclusive (run.sh + verify.sh + council, #82 fake-green)" "$SCRIPT_DIR/test-zero-test-inconclusive.sh"
run_test "Heal Assess Readiness Triage Tests (rank 13)" "$SCRIPT_DIR/test-heal-assess-readiness.sh"

# Process Supervisor Tests
run_test "Process Supervisor Tests" "$SCRIPT_DIR/test-process-supervisor.sh"
run_test "Supervised Signal Finalization and Honest Proof" "$SCRIPT_DIR/test-supervised-signal-finalization.sh"

# Orphan wrapper reaper (loki-mode #92: liveness-gated self-reaping, nohup-safe)
run_test "Orphan Wrapper Reaper (#92 liveness predicate)" "$SCRIPT_DIR/test-orphan-wrapper-reaper.sh"

# Quality Gates
run_test "Mock Detector (Gate #8)" "$SCRIPT_DIR/detect-mock-problems.sh"
run_test "Mock Detector source-import false positive (subprocess E2E)" "$SCRIPT_DIR/test-mock-detector-source-import.sh"
run_test "start-SHA empty-repo capture (council empty_diff blocker)" "$SCRIPT_DIR/test-start-sha-empty-repo.sh"
run_test "stat portability (GNU-first ordering)" "$SCRIPT_DIR/test-stat-portability.sh"
run_test "alt-provider model-alias warning (OpenRouter/Ollama/LiteLLM)" "$SCRIPT_DIR/test-alt-provider-warning.sh"
run_test "bash 3.2 parse compatibility (macOS /bin/bash)" "$SCRIPT_DIR/test-bash32-parse.sh"
run_test "greenfield diff-stat (report what was built)" "$SCRIPT_DIR/test-greenfield-diffstat.sh"
run_test "PAUSED.md states the pause reason" "$SCRIPT_DIR/test-paused-md-reason.sh"
run_test "per-outcome next-step guidance" "$SCRIPT_DIR/test-outcome-guidance.sh"
run_test "Evidence Receipt run-level baseline (signed diff stat)" "$SCRIPT_DIR/test-receipt-run-baseline.sh"
run_test "no hardcoded home-directory paths in tests" "$SCRIPT_DIR/test-no-hardcoded-paths.sh"
run_test "run-all-tests guards: real key dir + parent HEAD (E-154, E-155)" "$SCRIPT_DIR/test-e154-e155-guards.sh"
run_test "no ambient gitconfig writes without top-level isolation" "$SCRIPT_DIR/test-no-ambient-gitconfig-writes.sh"
run_test "loki why honest reporting (gate named, diff re-derived)" "$SCRIPT_DIR/test-why-honest-report.sh"
run_test "status surfaces agree (STATUS.txt vs COMPLETION.txt, --json staleness)" "$SCRIPT_DIR/test-status-surface-agrees.sh"
run_test "emit.sh append lock never hangs (telemetry must not outlive the run)" "$SCRIPT_DIR/test-emit-lock-no-hang.sh"
run_test "emit.sh self-reaper caps every path (no 10-hour orphans)" "$SCRIPT_DIR/test-emit-self-reaper.sh"
run_test "dashboard venv teardown is serialized (concurrent runs keep an importable venv)" "$SCRIPT_DIR/test-venv-concurrent-teardown.sh"
run_test "verification runs air-gapped (enterprise perimeter, honest scope)" "$SCRIPT_DIR/test-airgap-verify.sh"
run_test "doctor names what blocks you (first-run funnel)" "$SCRIPT_DIR/test-doctor-names-blockers.sh"
run_test "first-run funnel covers the walls users hit" "$SCRIPT_DIR/test-first-run-funnel-coverage.sh"
run_test "a completion claim must name work in the diff" "$SCRIPT_DIR/test-claim-grounding.sh"
run_test "decision records surface a model swap and leak nothing" "$SCRIPT_DIR/test-decision-record.sh"
run_test "failure memory learns from measured events only" "$SCRIPT_DIR/test-failure-memory.sh"
run_test "agent readiness is measured, not judged" "$SCRIPT_DIR/test-agent-readiness.sh"
run_test "the verification-cost page stays honest" "$SCRIPT_DIR/test-verification-cost-doc.sh"
run_test "outcome ledger anchors before it measures" "$SCRIPT_DIR/test-outcome-ledger.sh"
run_test "intent ledger detects spec-drifted-from-intent" "$SCRIPT_DIR/test-intent-ledger.sh"
run_test "pre-edit snapshot separates agent from human rescue" "$SCRIPT_DIR/test-preedit-snapshot.sh"
run_test "server.json tracks VERSION (MCP registry not stale)" "$SCRIPT_DIR/test-server-json-current.sh"
# The published registry entry must not fall behind what we ship. The guard
# above compares server.json to VERSION, both LOCAL, so they agree with each
# other while saying nothing about what the registry serves. Measured
# 2026-09-13 with both green: registry 7.34.1, shipped 9.49.4.
# Network-dependent, so it is deliberately NOT in the fast tier; an
# unreachable registry exits 0 rather than reddening a pre-push gate.
run_test "MCP registry entry is not stale (published vs shipped)" "$SCRIPT_DIR/test-mcp-registry-not-stale.sh"
run_test "plugin.json tracks VERSION (plugin updates not stale)" "$SCRIPT_DIR/test-plugin-json-current.sh"
run_test "subagent fleet capacity is explicit (CC 2.1.217 defaults)" "$SCRIPT_DIR/test-subagent-fleet-capacity.sh"
run_test "build wall-clock is attributable (boot/teardown timed)" "$SCRIPT_DIR/test-build-time-attribution.sh"
run_test "README has no hand-maintained version (drifts by default)" "$SCRIPT_DIR/test-readme-no-stale-version.sh"
run_test "doc-gen does not re-bill its shared context or run untiered" "$SCRIPT_DIR/test-docgen-cost-shape.sh"
run_test "loki web alias does not silently do the wrong thing" "$SCRIPT_DIR/test-web-alias-consistency.sh"
run_test "every terminal outcome has a human label (no raw enums)" "$SCRIPT_DIR/test-completion-outcome-labels.sh"
run_test "verify never reports an LLM review it did not perform" "$SCRIPT_DIR/test-verify-llm-review.sh"
run_test "brownfield assess changes nothing (enterprise trust claim)" "$SCRIPT_DIR/test-brownfield-assess-readonly.sh"
run_test "EVALUATING.md claims stay runnable (no COMPARISON.md rot)" "$SCRIPT_DIR/test-evaluating-doc-runnable.sh"
run_test "council never fabricates a reviewer verdict (INCONCLUSIVE != REJECT)" "$SCRIPT_DIR/test-council-no-fabricated-verdict.sh"
run_test "model catalog: no Claude defaults on non-Claude providers" "$SCRIPT_DIR/test-catalog-no-claude-default.sh"
run_test "Evidence Receipt names the blocking gate (facts, not assessment)" "$SCRIPT_DIR/test-receipt-names-blocking-gate.sh"
run_test "Evidence Receipt splits exogenous vs advisory verification" "$SCRIPT_DIR/test-receipt-exogenous-split.sh"
run_test "Evidence Receipt reports model provenance (decision trail)" "$SCRIPT_DIR/test-receipt-model-provenance.sh"
run_test "project-graph bash/bun parity (members discovery default)" "$SCRIPT_DIR/test-parity-project-graph.sh"
run_test "opencode provider (model-agnostic route, 75+ providers)" "$SCRIPT_DIR/test-opencode-provider.sh"
run_test "opencode start routing and main-loop dispatch" "$SCRIPT_DIR/test-opencode-start.sh"
run_test "fast_verify: millisecond deterministic verification" "$SCRIPT_DIR/test-fast-verify.sh"
run_test "provider_invoke_argv timeout seam (judges keep their timeout)" "$SCRIPT_DIR/test-provider-invoke-argv.sh"
run_test "Test Mutation Detector (Gate #9)" "$SCRIPT_DIR/detect-test-mutations.sh"
run_test "Harness False-Green Regression and Mutation" "$SCRIPT_DIR/test-harness-false-green.sh"

# Sentrux Gate (v7.5.14) -- unit tests only; uses fake on-PATH binary so safe
# on every CI host (Linux/macOS). The real-binary integration test lives at
# tests/integration/test_sentrux_real.sh and is gated to a manual workflow.
run_test "Sentrux Gate Unit Tests" "$SCRIPT_DIR/test-sentrux-gate.sh"

# CI Coverage Verification (v7.5.15) -- asserts sentrux test wiring is intact
run_test "CI Sentrux Coverage" "$SCRIPT_DIR/test-ci-sentrux-coverage.sh"

# v7.5.15 fleet additions -- registered after Devil's Advocate flagged that
# 7 of 8 new tests would otherwise rot silently (only invoked manually).
run_test "Sentrux Iteration Wireup (Dev1)" "$SCRIPT_DIR/test-sentrux-iteration-wireup.sh"
run_test "Sentrux Init-Rules (Dev3)" "$SCRIPT_DIR/test-sentrux-init-rules.sh"
run_test "Doctor JSON Sentrux Parity (Dev4)" "$SCRIPT_DIR/test-doctor-json-sentrux.sh"
run_test "Receipt Signing Discoverability" "$SCRIPT_DIR/test-receipt-signing-discoverability.sh"
run_test "Dashboard Nav UAT (Dev5)" "$SCRIPT_DIR/test-dashboard-nav-uat.sh"
run_test "dashboard bundle stays within its measured budget" "$SCRIPT_DIR/test-dashboard-bundle-budget.sh"
run_test "exposed dashboard bind requires auth (#188)" "$SCRIPT_DIR/test-dashboard-bind-auth-guard.sh"
run_test "per-job receipt attestation (signed JWT + JWKS)" "$SCRIPT_DIR/test-receipt-jwt-attestation.sh"
run_test "remote receipt attestation verdict (JWKS)" "$SCRIPT_DIR/test-remote-attestation-verdict.sh"
run_test "proof verify --jwks (third-party offline)" "$SCRIPT_DIR/test-proof-verify-jwks.sh"
run_test "proof ablation headline: never VERIFIED when not_load_bearing (S-113)" "$SCRIPT_DIR/test-proof-ablation-headline.sh"
run_test "council cannot approve inconclusive evidence on the vote alone (S-116)" "$SCRIPT_DIR/test-council-inconclusive-no-approve.sh"
run_test "done-recognition tests_axis: zero-test is unknown, failed_count is red (S-125)" "$SCRIPT_DIR/test-done-recognition-tests-axis.sh"
run_test "iteration 0 drops a stale static-analysis.pass (S-124)" "$SCRIPT_DIR/test-iteration0-drops-static-analysis.sh"
run_test "JWKS attestation fetch requires https, loopback http only (S-123)" "$SCRIPT_DIR/test-jwks-https-only.sh"
run_test "tier-a R0 step has no timeout tighter than its job (S-96)" "$SCRIPT_DIR/test-tier-a-r0-timeout-budget.sh"
run_test "verify-path python3 hardening (canary verify, proof share/show)" "$SCRIPT_DIR/test-verify-path-shim-hardening.sh"
run_test "worker autoscaling on queue depth" "$SCRIPT_DIR/test-worker-autoscaling.sh"
run_test "helm receipt signing (receiver only)" "$SCRIPT_DIR/test-helm-receipt-signing.sh"
run_test "compose receipt signing (opt-in, default intact)" "$SCRIPT_DIR/test-compose-receipt-signing.sh"
run_test "head-to-head corpus honesty" "$SCRIPT_DIR/test-headtohead-honesty.sh"
run_test "receipt metrics exposed to monitoring" "$SCRIPT_DIR/test-receipt-metrics.sh"
run_test "A/B analysis honesty (tiny-n statistics)" "$SCRIPT_DIR/test-ab-analysis-honesty.sh"
run_test "webapp receipt panel renders (real browser)" "$SCRIPT_DIR/../scripts/run-webapp-receipt-panel.sh"
run_test "webapp admin, templates and teams render honestly (real browser)" "$SCRIPT_DIR/../scripts/run-webapp-admin-honesty.sh"
run_test "local receipt attestation" "$SCRIPT_DIR/test-local-receipt-attestation.sh"
run_test "Pytest Gate Timeout (Dev6)" "$SCRIPT_DIR/test-pytest-gate-timeout.sh"
run_test "Go/Cargo Gate Timeout" "$SCRIPT_DIR/test-go-cargo-gate-timeout.sh"
# Python tests (Dev2 + Dev7) -- registered via tiny wrapper scripts so the
# bash runner (which expects a single executable file per entry) can include
# them alongside the bash tests.
if command -v python3 >/dev/null 2>&1 && python3 -c "import pytest" >/dev/null 2>&1; then
    run_test "Quality Architecture Endpoint (Dev2 pytest)" \
        "$SCRIPT_DIR/dashboard/run_quality_architecture_tests.sh"
    run_test "Episode Load Resilience (Dev7 pytest)" \
        "$SCRIPT_DIR/memory/run_episode_load_resilience_tests.sh"
    run_test "Council Transcripts Endpoint (pytest)" \
        "$SCRIPT_DIR/dashboard/run_council_transcripts_tests.sh"
fi

# Crash Reporting Phase 0 (local-only, zero egress) -- bash CLI/helper tests.
run_test "Crash Reporting CLI Tests" "$SCRIPT_DIR/test-crash-cli.sh"
# Crash scrubber golden vectors + adversarial/negative tests (Python). Wrapped
# in a tiny sh runner so the bash runner (one executable per entry) can include
# them alongside the bash tests, matching the Dev2/Dev7 pytest pattern above.
if command -v python3 >/dev/null 2>&1; then
    run_test "Crash Scrubber Redaction Tests (Python)" \
        "$SCRIPT_DIR/crash/run_crash_redact_tests.sh"
fi

# Batch-3 rank 6: work-based engineering-hours estimator emitted into proof.json.
# Python; wrapped so the bash runner (one executable per entry) can include it.
if command -v python3 >/dev/null 2>&1; then
    run_test "Effort Estimator (Rank 6 proof.json hours)" \
        "$SCRIPT_DIR/run_effort_estimate_tests.sh"
fi

# Verified completion / evidence hard gate (v7.19.1) -- council_evidence_gate
# truth table. Skips gracefully when git/python3 are unavailable or the gate
# is not yet defined.
run_test "Evidence Gate (verified completion)" "$SCRIPT_DIR/test-evidence-gate.sh"
run_test "No-mock data-render classification" "$SCRIPT_DIR/test-nomock-data-render.sh"

# State baseline lifecycle: a fresh run after a terminal status (success,
# failure, or crash) must reset ITERATION_COUNT so the evidence-gate baseline
# recaptures to the new run's HEAD; resume states (paused/interrupted) must
# preserve it. Regression guard for the W3 stale-baseline REJECT (v7.19.1).
run_test "State Baseline Lifecycle (run 2+ freshness)" "$SCRIPT_DIR/test-state-baseline-lifecycle.sh"

# Completion-route evidence gate: the verified-completion gate must guard the
# DEFAULT completion-promise route (loki_complete_task / promise text), not only
# the interval-gated council path. Regression guard for the W3 council REJECT:
# a fabricated completion (empty diff or red tests) must be rejected there too.
run_test "Completion-route Evidence Gate (default path)" "$SCRIPT_DIR/test-completion-route-evidence-gate.sh"

# check_completion_promise gating: structured signal is the default trigger;
# legacy grep matching is OFF by default and fixed-string (grep -F) when on.
run_test "Completion-promise Gating (signal vs legacy grep)" "$SCRIPT_DIR/test-completion-promise-gating.sh"

# WAVE13 CRITICAL: completion-council live-vote quorum. The voter-agents.sh
# dispatch parser must judge COMPLETE/CONTINUE against the EXPECTED council
# size (COUNCIL_SIZE), never the number of findings the model returned, so a
# degraded/partial response can never reach COMPLETE on a returned subset (fail
# closed). Includes a mutation guard proving non-vacuity.
run_test "Council Live-Vote Quorum (WAVE13 fail-closed)" "$SCRIPT_DIR/test-council-quorum-wave13.sh"

# Completion-council devil's advocate: must read the structured test signal
# (.loki/quality/test-results.json), not a log path nothing writes, so a real
# unanimous COMPLETE is not always vetoed. Includes a mutation guard.
run_test "Council Devil's Advocate (structured test-evidence)" "$SCRIPT_DIR/test-council-devils-advocate.sh"
run_test "Council py-tool copy byte-identical to run.sh" "$SCRIPT_DIR/test-council-py-tool-identity.sh"

# Anti-sycophancy DA veto: on a UNANIMOUS approve, a non-confirming devil's-advocate
# verdict MUST drive approve_count below the effective completion threshold so
# council_vote returns CONTINUE (recorded REJECTED), for a council of size >= 3.
# Guards the silent-no-op regression where a bare approve_count-1 still cleared 2/3.
run_test "Council DA Veto (anti-sycophancy forces CONTINUE)" "$SCRIPT_DIR/test-council-da-veto.sh"

# #47 build applicability: N/A ONLY on a positive "no build phase"; an
# unrecognized-but-real build system (Make/Maven/Gradle/non-"build" npm script)
# stays a not_run gap, never a fake-green N/A. Guards the exact council-caught
# hole where the writer laundered "unknown build system" into applicable:false.
run_test "Build applicability (unrecognized build stays a gap, not fake N/A)" "$SCRIPT_DIR/test-build-check-applicability.sh"

# #139 Python test detection: a ROOT-LEVEL test_*.py (no tests/ dir, no config)
# is detected + run (pytest, or stdlib unittest fallback when pytest absent), so
# a genuinely-passing Python suite reads verified -- not "tests not run" on
# validated work. Zero-discovery stays inconclusive (never fake-green).
run_test "Python test detection (root test_*.py + unittest fallback, no fake-green)" "$SCRIPT_DIR/test-python-test-detection.sh"

# check_human_intervention signal dispatch + security: STOP -> rc 2; HUMAN_INPUT
# symlink rejected; prompt injection disabled-by-default quarantines input.
run_test "Human Intervention Signals (STOP/HUMAN_INPUT security)" "$SCRIPT_DIR/test-human-intervention-signals.sh"

# Regression guards for the v7.51-v7.53 shipped features (SDET hardening):
#  - coverage.json is written with measured:false even at the default (off).
#  - run.sh surfaces the council evidence-gate-details (WARN/INFO/silent).
#  - check_policy honors the approval wait under enforce knobs; advisory default.
#  - the semantic gate is default-OFF on the bash route + blocks on HIGH when on.
#  - no live `codex exec --full-auto` invocation has crept back into the repo.
run_test "Coverage Artifact Default-Off (v7.51 measured:false)" "$SCRIPT_DIR/test-coverage-artifact-default-off.sh"
run_test "Evidence-Gate-Details Consumer (v7.51 P1-1)" "$SCRIPT_DIR/test-evidence-gate-details-consumer.sh"
run_test "Approval Phase-Gate (v7.51 P3-3)" "$SCRIPT_DIR/test-approval-phase-gate.sh"
run_test "Semantic Gate Bash Route (v7.53 P1-3)" "$SCRIPT_DIR/test-semantic-gate-bash-route.sh"
run_test "No Deprecated Codex Flag (v7.52 --full-auto guard)" "$SCRIPT_DIR/test-no-deprecated-codex-flag.sh"

# Uncertainty-gated escalation: when >=2 of 3 reused proxies (no-change,
# diff-hash oscillation, council split) co-occur for N rounds, the decision
# function escalates once per stuck-episode (debounced); a single noisy proxy
# must NOT escalate. Regression guard for the v7.19.2 escalation ladder.
run_test "Uncertainty Escalation (2-of-3 proxies)" "$SCRIPT_DIR/test-uncertainty-escalation.sh"

# AGENTS.md support (agents.md standard: AGENTS.md preferred, CLAUDE.md
# fallback, nearest-file-wins, never merged). The layered doc walker resolves
# per-dir conventions via _lpg_memory_file; the build_prompt instruction line is
# parity-locked byte-identical across the bash and Bun routes.
run_test "AGENTS.md Doc Walker (precedence + fallback)" "$SCRIPT_DIR/test-agents-md-walker.sh"
run_test "AGENTS.md build_prompt Instruction (all blocks)" "$SCRIPT_DIR/test-agents-md-build-prompt.sh"
run_test "AGENTS.md Instruction Parity (bash vs Bun)" "$SCRIPT_DIR/test-parity-agents-md.sh"
run_test "Run-owned temp cleanup scope" "$SCRIPT_DIR/test-safe-cleanup-scope-188.sh"

# F52: DOC_SCOPE instruction scales documentation to detected project complexity
# (simple -> minimal docs; standard/complex -> full architecture suite).
run_test "DOC_SCOPE build_prompt Instruction (tier-conditional)" "$SCRIPT_DIR/test-doc-scope-build-prompt.sh"

# F52 doc-scope generator + gate halves: a simple project must NOT trigger
# 'loki docs generate' (the agentic architecture-suite writer, ~270s of burn),
# and the doc-coverage gate must accept README+USAGE for simple tier so the
# skip does not force wasted iterations. standard/complex keep the full suite.
run_test "DOC_SCOPE generator + gate (tier-conditional)" "$SCRIPT_DIR/test-doc-scope-generator.sh"

# caveman output-token compressor gates: ACTIVATE on free-form generation,
# HARD-SUPPRESS (CAVEMAN_DEFAULT_MODE=off) on every parsed trust-gate subcall.
# Includes the determinism / moat carve-out proof (suppression is unconditional)
# and cross-route parity with loki-ts/src/providers/claude_flags.ts.
run_test "Caveman Compressor Gates (activate/suppress + determinism)" "$SCRIPT_DIR/test-caveman-flags.sh"

# Delegate-then-notify (Release 2): build_completion_summary writes the durable
# .loki/COMPLETION.txt + .loki/state/completion.json for every terminal state
# and suppresses the desktop ping when LOKI_NOTIFICATIONS=0 while still writing
# the files (state, not a notification).
run_test "Completion Summary (delegate-then-notify files)" "$SCRIPT_DIR/test-completion-summary.sh"
run_test "Plan JSON Smoke (--json unbound-var regression guard)" "$SCRIPT_DIR/test-plan-json-smoke.sh"

# Dynamic resource-aware session concurrency (Release 3, slice 3): effective_session_cap
# default-off byte-identical, scales the session cap down under CPU/memory pressure,
# best-effort on missing/garbage resources.json, clamped to [1, ceiling].
run_test "Dynamic Session Concurrency (effective_session_cap)" "$SCRIPT_DIR/test-dynamic-concurrency.sh"

# Delegate-then-notify (Release 2): notify on ALL terminal states
# (complete / max_iterations / stopped / failed) with branch + diff in the body;
# on_run_complete is default-OFF and defers to the existing GITHUB_PR path; the
# --bg daemon machinery + new UX message lines are preserved.
run_test "Delegate Notify (all terminal states)" "$SCRIPT_DIR/test-delegate-notify.sh"

# Hybrid retrieval (Release 3): incremental-freshness manifest diff + staleness
# detection (slice 1) and reciprocal-rank-fusion determinism + dedup by
# file:line + budget-never-exceeded + grep-only fallback (slice 2). Pure-logic
# tests run without a live ChromaDB; live-index parts skip cleanly when absent.
run_test "Hybrid Codebase Search (manifest + RRF + budget + fallback)" "$SCRIPT_DIR/test-hybrid-search.sh"

# Live Build HUD (FEAT-HUD): render_build_hud() emits a single per-iteration
# status line ONLY on an interactive TTY (foreground, not --bg, LOKI_HUD != 0);
# off-TTY/CI output is byte-identical (zero added bytes). Drives the helper under
# a pseudo-tty to prove the gate both fires (emits [HUD]) and suppresses, plus
# cost-degrade, set -u safety, _hud_fmt_secs formatting, and ETA gating.
run_test "Live Build HUD (TTY gate + degrade + parity)" "$SCRIPT_DIR/test-build-hud.sh"

# Public Preview Tunnel (FEAT-PREVIEW-LINK): `loki preview --public` wraps the
# user's OWN cloudflared/ngrok CLI behind a consent-gated, default-OFF flow.
# Covers the pure URL extractors, preconditions (no app / not-running / dead
# port), consent (interactive decline + non-TTY refuse), provider allowlist,
# the honest CLI-absent install hint, FAKE-binary URL capture + SIGTERM
# teardown (no real tunnel ever opened), and the plain-preview regression.
run_test "Public Preview Tunnel (--public consent + tunnel wrap)" "$SCRIPT_DIR/test-preview-public.sh"

# Branch Lifecycle (FEAT-BRANCH-DEFAULT): loki start works out of a feature
# branch by default (base != main), squashes one honest session-end commit, and
# ADVISES the PR (print-only, no push) unless LOKI_AUTO_PR=1. Extracts the three
# branch functions from run.sh + the shared advisory lib; headline test proves
# the advisory prints push+PR commands and does NOT push (real bare remote, zero
# refs after), with a mutation check proving that assertion is non-vacuous.
run_test "Branch Lifecycle (default-on, base!=main, commit, advisory no-push)" "$SCRIPT_DIR/test-branch-lifecycle.sh"
run_test "Refused resume warning names the blocking ignored file and the recorded branch (S-233)" "timeout -k 10 120 $SCRIPT_DIR/test-refused-resume-warning.sh"

# Telemetry disclosure-before-egress under a REAL pty (council cH_r1 AC7). The
# on-by-default gate resolves interactivity ONCE at the entry point (exported
# LOKI_TTY_INTERACTIVE) instead of re-probing `-t` in FD-detached subshells, so
# an interactive user is never auto-off'd by the gate-check/emit subshells. This
# test drives `loki version` (Bun route) and a bash-routed command under a
# python3 pty on a fresh HOME and asserts: interactive enabled -> disclosure once
# before egress; 2nd run no repeat; off/CI/enterprise/DO_NOT_TRACK/non-pty ->
# silent; sentinel edge (CI-first then interactive) still discloses. Hermetic:
# endpoint points at an unroutable local sink, never the real PostHog host.
run_test "Telemetry Disclosure PTY (TTY signal + no covert egress)" "$SCRIPT_DIR/test-telemetry-disclosure-pty.sh"

# Opt-in build-outcome analytics (Build A). The build_verified event sits behind
# a STRICT second-layer gate (LOKI_ANALYTICS/LOKI_POSTHOG=on) below base
# telemetry, default OFF even for diagnostics-on users. Asserts the gate
# precedence (default off, opt-in fires, every opt-out kills it) and that the
# FIXED allowlist (autonomy/lib/proof-analytics-props.py) emits only already-
# computed scalars -- never spec/PRD text or file paths. Hermetic: curl stubbed.
run_test "Build Analytics Opt-In (strict gate + allowlist, no leak)" "$SCRIPT_DIR/test-build-analytics-optin.sh"

# Deploy Advisory (FEAT-DEPLOY): `loki deploy` detects project type + CI/CD
# pipeline and PRINTS the deploy command(s); print-only (NEVER runs a cloud CLI,
# NEVER git push). Drives the real binary with fake cloud-CLI stubs; headline
# proves non-execution + CI/CD git-advice precedence over cloud options.
run_test "Deploy advisory (print-only, CI/CD precedence)" "$SCRIPT_DIR/test-deploy.sh"

# Receipt-gated deploy: `loki deploy --execute` runs a deploy ONLY when a
# VERIFIED Evidence Receipt authorizes THIS tree (hash_ok + VERIFIED verdict +
# anchor to HEAD + clean tree + per-invocation opt-in), and fails closed on any
# check it cannot evaluate. Includes the POSITIVE CONTROL that stops the gate
# from passing by refusing everything, and the destructive/git-push limits.
run_test "Deploy receipt gate (--execute authorization)" "$SCRIPT_DIR/test-deploy-receipt-gate.sh"

# Unified config-file (#691): `loki start --config <path>` (.env/YAML/JSON), the
# locked precedence ladder (--config beats ambient env -- the keystone), ${VAR}
# expansion, raw-secret detection, injection rejection, and `config
# example|schema|validate`. Drives the real binary under LOKI_CONFIG_DUMP=1 +
# direct unit calls into the side-effect-free config-map.sh lib.
run_test "Unified config-file (--config precedence + formats)" "$SCRIPT_DIR/test-config-file.sh"
run_test "Config validate unknown-key detection (JSON/YAML parity)" "$SCRIPT_DIR/test-config-unknown-keys.sh"
run_test "Enforcement claims in buyer-facing docs are scoped" "$SCRIPT_DIR/test-enforcement-doc-honesty.sh"
run_test "Healing docs disclose unwired modify hooks (issue 200)" "timeout -k 10 120 $SCRIPT_DIR/test-heal-docs-honesty.sh"
run_test "loki logs reads the log the runner writes" "$SCRIPT_DIR/test-logs-command.sh"
run_test "report cost agrees with its own budget state file" "$SCRIPT_DIR/test-report-cost-budget.sh"
run_test "loki stop is bounded regardless of provider timeout" "$SCRIPT_DIR/test-stop-latency.sh"
run_test "kill_provider_child never signals outside its own process group" "$SCRIPT_DIR/test-kill-provider-child-scoping.sh"
run_test "resource monitor reaps its sleep child on shutdown (BACKLOG 22)" "$SCRIPT_DIR/test-resource-monitor-sleep-reaped.sh"
run_test "audit chain claims match what the chain proves" "$SCRIPT_DIR/test-audit-chain-honesty.sh"
run_test "audit subsystem Node suites (witness, manifest, crosslink)" "$SCRIPT_DIR/test-audit-js-suites.sh"
# Moat P7 at the pixel: the real cost components and cost.html render an
# unmeasured cost as unknown, never $0.00, and a measured zero as $0.00. Node is
# required, not skipped (as in the audit suites above): no runtime means the
# suite did not run, which is unmeasured, not clean.
run_test "dashboard unmeasured cost never renders as zero (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-unmeasured-cost-never-zero.node.test.mjs"
run_test "dashboard panels render unmeasured as unknown (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-unmeasured-panels-honesty.node.test.mjs"
run_test "dashboard UI component utilities match shipped code (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/ui-components.test.js"
run_test "dashboard overview issue-to-PR journey (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-overview-issue-journey.node.test.mjs"
run_test "dashboard overview proof card wording (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-overview-proof-card.node.test.mjs"
run_test "dashboard static content council vote label (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/static-council-vote-label.node.test.mjs"
run_test "web-app NLSearch failed request is not no-results (S-159)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/NLSearch.state.test.mjs"
run_test "web-app DeployConnections failed load is not Not connected (S-185)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/DeployConnections.state.test.mjs"
run_test "web-app DeployConnections handlers do not push synthesized statuses (PO-WEB-DEPLOY-1)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/DeployConnections.propagate.test.mjs"
run_test "web-app ProjectsPage poll error is not an empty list (S-161)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/pages/ProjectsPage.state.test.mjs"
run_test "web-app workspace panels surface fetch failures (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/ProjectWorkspace.panels.test.mjs"
run_test "web-app preview says could not detect after a failed preview-info fetch (S-229)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/ProjectWorkspace.preview.test.mjs"
run_test "web-app workspace phase: completed shows Replay Build, unknown phase is not building (S-230)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/ProjectWorkspace.phase.test.mjs"
run_test "web-app CI/CD panel shows unknown status as unknown (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/CICDPanel.status.test.mjs"
run_test "web-app cost estimate ignores the iteration cap (S-187)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/CostEstimator.estimate.test.mjs"
run_test "web-app receipt and cost trend mark a partly priced run (S-224)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/EvidenceReceiptPanel.cost.test.mjs"
run_test "web-app chat completion never says Done. for a silent failure (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/AIChatPanel.result.test.mjs"
run_test "web-app issue list shows the gh comment count (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/GitHubIssuesPanel.comments.test.mjs"
run_test "web-app cockpit actions say not loaded after a failed fetch (S-206)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/cockpit/FinalActions.reasons.test.mjs"
run_test "web-app cockpit evidence says could not load after a failed checklist fetch (S-207)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/cockpit/EvidencePanel.state.test.mjs"
run_test "dashboard checkpoint viewer shows a failed read, not empty (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-checkpoint-viewer-fetch-error.node.test.mjs"
run_test "dashboard council transcripts show a failed hook-events read (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-council-transcripts-fetch-error.node.test.mjs"
run_test "dashboard task board keeps a server load error visible (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-task-board-fetch-error.node.test.mjs"
run_test "dashboard API keys load error hides the empty state (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-api-keys-fetch-error.node.test.mjs"
run_test "dashboard log stream shows an unreachable API, not a quiet log (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-log-stream-fetch-error.node.test.mjs"
run_test "dashboard migration view shows a failed load, not an empty state (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-migration-dashboard-fetch-error.node.test.mjs"
run_test "dashboard managed memory events error payload hides the empty state (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-managed-memory-events-error.node.test.mjs"
run_test "dashboard learning metrics and trends show a failed read, not no data (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-learning-dashboard-fetch-error.node.test.mjs"
run_test "shipped agent roles reach the review pool" "$SCRIPT_DIR/test-agent-types-loaded.sh"
run_test "policy present but unevaluable refuses fail-closed" "$SCRIPT_DIR/test-policy-node-failclosed.sh"
run_test "audit entries attribute an actor honestly" "$SCRIPT_DIR/test-audit-actor-attribution.sh"
run_test "shipped modules have a recorded reachability verdict" "$SCRIPT_DIR/test-no-unreachable-shipped.sh"
run_test "dashboard HTML strings escape run-written values" "$SCRIPT_DIR/test-no-unescaped-innerhtml.sh"
run_test "loki proof chain fronts the buyer verifier" "$SCRIPT_DIR/test-proof-chain-command.sh"
run_test "workflow RC handlers are reachable under bash -e" "$SCRIPT_DIR/test-workflow-rc-capture.sh"
run_test "issue-to-PR action and workflow ship, gate and split agent from publish" "$SCRIPT_DIR/test-issue-to-pr-action.sh"
run_test "no shipped action runs the agent in a step holding a GitHub token" "$SCRIPT_DIR/test-action-agent-step-no-token.sh"
run_test "model substitutions are visible and attributable" "$SCRIPT_DIR/test-model-substitution-visible.sh"
run_test "the completion council reports its duration" "$SCRIPT_DIR/test-council-stage-timing.sh"
run_test "a gate that scanned nothing is not a pass" "$SCRIPT_DIR/test-static-analysis-noop-not-pass.sh"
# Registered here for the first time. All three existed on disk but were in no
# runner, so CI had never executed them; test-cluster-workflow.sh had never even
# printed a result (set -e killed it on its first pass()). Each passes now.
run_test "Cluster workflow templates and swarm classes" "$SCRIPT_DIR/test-cluster-workflow.sh"
run_test "Cross-project learning surface" "$SCRIPT_DIR/test-cross-project-learning.sh"
run_test "Project memory persists across runs and injects a bounded summary" "timeout -k 10 120 $SCRIPT_DIR/test-project-memory.sh"
run_test "Cross-provider auto-failover" "$SCRIPT_DIR/test-failover.sh"

# Config-map no-yq YAML fallback: regression for same-last-segment key collision
# and the BSD-sed \s stray-quote bug. Forces the fallback by hiding yq from PATH.
run_test "Config-map no-yq YAML fallback (nested-path + quote handling)" "$SCRIPT_DIR/test-config-map-fallback.sh"

# Release A (v7.79.0) enterprise + local hardening: the bash-side suites. (The
# python suites -- test_lokistore.py, test_trigger*.py, tests/dashboard/*auth*.py,
# test-checkpoint-objectstore-sync.py -- are auto-discovered by the local-ci
# `python3.12 -m pytest -q` block; only the bash tests need explicit registration.)
run_test "validate_yaml_value injection guard (#691 security fix)" "$SCRIPT_DIR/test-validate-yaml-value.sh"
run_test "ALLOWED_PATHS partial enforcement (A5: sandbox mount + command)" "$SCRIPT_DIR/test-allowed-paths-a5.sh"
run_test "ALLOWED_PATHS sandbox workspace mount (V3: fail-closed refuse)" "$SCRIPT_DIR/test-allowed-paths-sandbox-mount.sh"
run_test "Multi-build state isolation (A6: LOKI_SESSION_ID namespacing)" "$SCRIPT_DIR/test-state-isolation-a6.sh"
run_test "loki why (B5: failure/outcome diagnosis)" "$SCRIPT_DIR/test-loki-why.sh"
run_test "loki next (forward-motion resolver)" "$SCRIPT_DIR/cli/test-loki-next.sh"
run_test "loki ship review scope (branch range on clean loki branch)" "$SCRIPT_DIR/cli/test-ship-review-scope.sh"
run_test "CLI flag guards (budget/plan-json/memory/temp-prd/flag-value)" "$SCRIPT_DIR/cli/test-cli-flag-guards.sh"
run_test "Rate-limit detection (no false-positive on agent output)" "$SCRIPT_DIR/test-rate-limit-detection.sh"
run_test "Checkpoint worktree-bundle sync (V2: refs/loki/cp via git bundle)" "$SCRIPT_DIR/run-checkpoint-worktree-bundle-tests.sh"
run_test "Queue-consumer (V5: redis/file backend + flag-injection guard)" "$SCRIPT_DIR/test-queue-consumer.sh"
run_test "loki bench honest degrade (L4: packaged-install UX)" "$SCRIPT_DIR/test-bench-honest-degrade.sh"

# events/emit.sh json_escape: payload values with raw C0 control bytes must
# escape to \uXXXX so the events.jsonl + pending JSON stay parseable (consumers
# silently drop a JSONDecodeError line); UTF-8 multibyte must survive intact.
run_test "Emit JSON Escape (C0 control chars + UTF-8)" "$SCRIPT_DIR/test-emit-json-escape.sh"

# providers/codex.sh: LOKI_CODEX_MODEL is trusted (used verbatim, incl
# org-scoped fine-tunes); only the generic LOKI_MODEL_* fallback is validated
# against CODEX_KNOWN_MODELS. Regression guard for the silent-downgrade bug.
run_test "Codex Model Trusted (LOKI_CODEX_MODEL verbatim)" "$SCRIPT_DIR/test-codex-model-trusted.sh"

# provider_invoke()/provider_invoke_with_tier() argv construction across all
# four providers. Registered 2026-07-27: this file existed but was wired into
# NO runner, so the layer it guards went unwatched -- which is how a hardcoded
# codex model that ChatGPT accounts reject reached users. An unregistered test
# is indistinguishable from no test.
run_test "Provider Invocation (argv construction, all providers)" "$SCRIPT_DIR/test-provider-invocation.sh"

# Provider capability flags + degraded-mode reasons must match what each CLI
# actually supports, not a stale assumption.
run_test "Provider Degraded Mode (capability flags)" "$SCRIPT_DIR/test-provider-degraded-mode.sh"

# The loader contract itself (which vars every provider must export, tier
# mapping, unknown-provider handling). Also previously unregistered.
run_test "Provider Loader (contract + tier mapping)" "$SCRIPT_DIR/test-provider-loader.sh"

# Audit-chain integrity across CONCURRENT WRITER PROCESSES. Registered with the
# fix (2026-07-27): a threading.Lock plus an import-time chain tip meant every
# concurrent writer process forked the tamper-evident chain at write time. 25 of
# 67 audit files on a real machine were internally chain-broken.
run_test "Audit Chain Multiprocess (cross-process flock + tip re-read)" "$SCRIPT_DIR/test-audit-chain-multiprocess.sh"

# Test-coverage gate: a PASSING suite must record pass:true, a failing one must
# BLOCK, and genuinely-no-tests must stay inconclusive. Registered with the
# node-test detector fix (2026-07-27): node 26 defaults to the spec reporter, so
# a green suite emitted no TAP "ok N -" lines and was mislabeled "no_tests_run".
run_test "Coverage Gate Fail-Open (node-test detector)" "$SCRIPT_DIR/test-coverage-gate-fail-open.sh"

# BACKLOG 62 (S-175): a whitelist-rejected LOKI_MONOREPO_TEST_CMD ran nothing and
# must record inconclusive/not_run with no unit-tests.pass, never pass:true.
run_test "Monorepo rejected test cmd is inconclusive (S-175)" "$SCRIPT_DIR/test-monorepo-rejected-cmd-inconclusive.sh"

# `loki init` surface, including --json. Registered with the stdout/stderr fix
# (2026-07-27): the reinit banner was written to stdout, so the SECOND init in a
# directory emitted invalid JSON to any tool parsing it.
run_test "Init Command (templates, --json, --list)" "$SCRIPT_DIR/test-init-command.sh"

# ANTHROPIC_BASE_URL + LOKI_MODEL_OVERRIDE fail-closed AND-gate (bash route).
# Registered 2026-07-27 after retargeting 4 assertions that still expected the
# pre-v7.104.0 opus default; the Bun mirror had been updated, the bash twin had
# not, because no runner ever ran it.
run_test "Anthropic Base URL (override AND-gate, bash)" "$SCRIPT_DIR/test-anthropic-base-url.sh"

# The v8 completion secret gate must not call a finished app a leak. v7.129.5
# had NO secret logic in the council, so every false positive here is a build
# that COMPLETED on v7 and BLOCKS on v8. Pairs each relaxation with a real-leak
# case so the gate cannot be loosened into uselessness.
run_test "Secret Gate False Positives (templates vs real leaks)" "$SCRIPT_DIR/test-secret-gate-false-positives.sh"

# Batch 6: previously-orphaned suites repaired 2026-07-27. Each was failing for
# a DIFFERENT reason (a hoisted helper the extractor no longer carried, three
# retargets to post-v7.89.0 contracts, an incomplete checked-in fixture, and a
# test that scanned the repo's own branch diff), and none was a product defect.
run_test "Council Contrarian Transcript Fields" "$SCRIPT_DIR/test-council-contrarian-transcript-fields.sh"
run_test "Bugfix Audit (CLI regressions)" "$SCRIPT_DIR/test-bugfix-audit.sh"
run_test "CLAUDE.md Walker (project graph layers)" "$SCRIPT_DIR/test-claude-md-walker.sh"
run_test "CI Command (--fail-on thresholds)" "$SCRIPT_DIR/test-ci-command.sh"
run_test "CI report body via stdin, not argv (BACKLOG 25)" "$SCRIPT_DIR/test-ci-report-argmax.sh"
run_test "CI JSON payloads via temp file/stdin, not exported env vars (BACKLOG 25)" "$SCRIPT_DIR/test-ci-json-argmax.sh"

# Batch 7 of the orphaned-suite registration (2026-07-27).
run_test "Report Command" "$SCRIPT_DIR/test-report-command.sh"
run_test "Review Allowlist 167" "$SCRIPT_DIR/test-review-allowlist-167.sh"
run_test "Review Command" "$SCRIPT_DIR/test-review-command.sh"
run_test "Review Severity Calibration" "$SCRIPT_DIR/test-review-severity-calibration.sh"
run_test "Run Sh Quoting" "$SCRIPT_DIR/test-run-sh-quoting.sh"
run_test "Run Start Estimate" "$SCRIPT_DIR/test-run-start-estimate.sh"
run_test "Runtime Gate" "$SCRIPT_DIR/test-runtime-gate.sh"
run_test "Sandbox Bughunt W4" "$SCRIPT_DIR/test-sandbox-bughunt-w4.sh"
run_test "Scaffold Hook" "$SCRIPT_DIR/test-scaffold-hook.sh"
run_test "Sentrux Setup Hints" "$SCRIPT_DIR/test-sentrux-setup-hints.sh"
run_test "Share Command" "$SCRIPT_DIR/test-share-command.sh"

# ---------------------------------------------------------------------------
# Batch 1 of the orphaned-suite registration (2026-07-27). These suites existed
# and passed but were wired into NO runner, so they never executed. See
# tests/test-registration-coverage.sh for the gate that now prevents new orphans.
# ---------------------------------------------------------------------------
run_test "Admin Quote Injection" "$SCRIPT_DIR/test-admin-quote-injection.sh"
run_test "Aider Cloud" "$SCRIPT_DIR/test-aider-cloud.sh"
run_test "Api Server" "$SCRIPT_DIR/test-api-server.sh"
run_test "App Runner Compose" "$SCRIPT_DIR/test-app-runner-compose.sh"
run_test "App Runner Injection" "$SCRIPT_DIR/test-app-runner-injection.sh"
run_test "App Runner Nextjs Standalone" "$SCRIPT_DIR/test-app-runner-nextjs-standalone.sh"
run_test "App Runner Port Reconcile" "$SCRIPT_DIR/test-app-runner-port-reconcile.sh"
run_test "App Runner Static Site" "$SCRIPT_DIR/test-app-runner-static-site.sh"
run_test "App Runner Token Lifecycle" "$SCRIPT_DIR/test-app-runner-token-lifecycle.sh"
run_test "App Runner Tree Stop" "$SCRIPT_DIR/test-app-runner-tree-stop.sh"
run_test "App Runner Watchdog Health" "$SCRIPT_DIR/test-app-runner-watchdog-health.sh"
run_test "App Runner Wave5 W5" "$SCRIPT_DIR/test-app-runner-wave5-w5.sh"
run_test "Apprunner Dockerfile Exec Wave8" "$SCRIPT_DIR/test-apprunner-dockerfile-exec-wave8.sh"
run_test "Assumption Gate Brief Mode" "$SCRIPT_DIR/test-assumption-gate-brief-mode.sh"
run_test "Auto Wiki" "$SCRIPT_DIR/test-auto-wiki.sh"
run_test "Backlog (loki backlog + loki.yaml)" "$SCRIPT_DIR/test-backlog.sh"
run_test "Backlog units (loki backlog --dag, D61)" "$SCRIPT_DIR/test-backlog-units.sh"
run_test "Backend Floor" "$SCRIPT_DIR/test-backend-floor.sh"
run_test "Backend Floor port scoping (kill by recorded PID, never by port)" "$SCRIPT_DIR/test-backend-floor-port-scoping.sh"
run_test "cmd_web_stop/start use a real process identity check (D14/D15 class)" "$SCRIPT_DIR/test-web-stop-scoping.sh"
run_test "cmd_web_start port-conflict path scoped by identity" "$SCRIPT_DIR/test-web-start-port-scoping.sh"
run_test "autonomy/verify.sh runtime teardown scoped to LISTEN + ownership" "$SCRIPT_DIR/test-verify-runtime-teardown-scoping.sh"
run_test "Marketplace action Cleanup step scoped to this job's own loki run" "$SCRIPT_DIR/test-action-yml-cleanup-scoping.sh"
run_test "Dashboard fresh-repo/evidence harnesses kill only their own recorded PID" "$SCRIPT_DIR/test-dashboard-harness-port-scoping.sh"
run_test "Dashboard API smoke cleanup kills only its own recorded PID" "$SCRIPT_DIR/test-dashboard-api-smoke-scoping.sh"
run_test "cleanup-test-processes.sh scoped to LISTEN + this uid, --aggressive gated" "$SCRIPT_DIR/test-cleanup-script-scoping.sh"
run_test "clean-test-branches.sh refuses own repo, spares protected branches, deletes only debris" "timeout -k 10 120 $SCRIPT_DIR/test-clean-test-branches.sh"
run_test "No script or test removes run-owned temp dirs by glob (E-140)" "$SCRIPT_DIR/test-no-tmp-sweep.sh"
run_test "No test starts a build against the repo root (E-165)" "$SCRIPT_DIR/test-no-start-against-repo-root.sh"
run_test "Runtime Gate port reclaims scoped to LISTEN + cwd ownership" "$SCRIPT_DIR/test-runtime-gate-port-scoping.sh"
run_test "Bun Parity disk.available_gb tolerance (BACKLOG 26)" "$SCRIPT_DIR/test-bun-parity-disk-tolerance.sh"
run_test "council_augment_from_managed_memory never falls back to cwd for PROJECT_DIR (BACKLOG 63)" "$SCRIPT_DIR/test-council-augment-managed-memory-project-dir.sh"
run_test "council_should_stop's shadow-write never falls back to cwd for PROJECT_DIR (BACKLOG 63/127)" "$SCRIPT_DIR/test-council-shadow-write-project-dir.sh"
run_test "council_managed_should_stop diffs the target project, not the install tree (S-196)" "$SCRIPT_DIR/test-council-managed-diff-target.sh"
run_test "auto-capture shadow-write skips empty PROJECT_DIR and never splices importance (S-156)" "$SCRIPT_DIR/test-autocapture-shadow-write-guard.sh"
run_test "Bench Haschanges" "$SCRIPT_DIR/test-bench-haschanges.sh"
run_test "Benchmarks Resume Atomic" "$SCRIPT_DIR/test-benchmarks-resume-atomic.sh"
run_test "Bmad Integration" "$SCRIPT_DIR/test-bmad-integration.sh"
run_test "Build Profile" "$SCRIPT_DIR/test-build-profile.sh"
run_test "Caveman Loki Coverage" "$SCRIPT_DIR/test-caveman-loki-coverage.sh"
run_test "Checkpoint Cli" "$SCRIPT_DIR/test-checkpoint-cli.sh"
run_test "Checkpoint Prune Sort" "$SCRIPT_DIR/test-checkpoint-prune-sort.sh"

# Batch 2 of the orphaned-suite registration (2026-07-27).
run_test "Checkpoint Ref Prune Wave9" "$SCRIPT_DIR/test-checkpoint-ref-prune-wave9.sh"
run_test "Claude Flags" "$SCRIPT_DIR/test-claude-flags.sh"
run_test "Claude Login State" "$SCRIPT_DIR/test-claude-login-state.sh"
run_test "Cli Allow Haiku Flag" "$SCRIPT_DIR/test-cli-allow-haiku-flag.sh"
run_test "Cli Provider Flag" "$SCRIPT_DIR/test-cli-provider-flag.sh"
run_test "Cluster Id Injection Wave10" "$SCRIPT_DIR/test-cluster-id-injection-wave10.sh"
run_test "Cockpit Cmd" "$SCRIPT_DIR/test-cockpit-cmd.sh"
run_test "Cockpit Follow" "$SCRIPT_DIR/test-cockpit-follow.sh"
run_test "Cockpit Keys" "$SCRIPT_DIR/test-cockpit-keys.sh"
run_test "Code Review Json Rematerialize" "$SCRIPT_DIR/test-code-review-json-rematerialize.sh"
run_test "Code Review Verdict Parse Wave8" "$SCRIPT_DIR/test-code-review-verdict-parse-wave8.sh"
run_test "Codex Max Tier Normalize" "$SCRIPT_DIR/test-codex-max-tier-normalize.sh"
run_test "Completion Council Affirmative Evidence" "$SCRIPT_DIR/test-completion-council-affirmative-evidence.sh"
run_test "Completion Paused Block" "$SCRIPT_DIR/test-completion-paused-block.sh"
run_test "Completion Route Checklist Gate" "$SCRIPT_DIR/test-completion-route-checklist-gate.sh"
run_test "Completion Signal Consume" "$SCRIPT_DIR/test-completion-signal-consume.sh"
run_test "Complexity Proportional Review" "$SCRIPT_DIR/test-complexity-proportional-review.sh"
run_test "Compound Cli" "$SCRIPT_DIR/test-compound-cli.sh"
run_test "Concurrent Sessions" "$SCRIPT_DIR/test-concurrent-sessions.sh"
run_test "Config Spawn Deprecated Wave10" "$SCRIPT_DIR/test-config-spawn-deprecated-wave10.sh"
run_test "Context Optimization" "$SCRIPT_DIR/test-context-optimization.sh"
run_test "Contract Scaffold" "$SCRIPT_DIR/test-contract-scaffold.sh"

# Batch 3 of the orphaned-suite registration (2026-07-27).
run_test "Council Convergence On Claim" "$SCRIPT_DIR/test-council-convergence-on-claim.sh"
run_test "Council Force Stop Wave7" "$SCRIPT_DIR/test-council-force-stop-wave7.sh"
run_test "Council Healing Audit Fixes" "$SCRIPT_DIR/test-council-healing-audit-fixes.sh"
run_test "Council Member Timeout Wave10" "$SCRIPT_DIR/test-council-member-timeout-wave10.sh"
run_test "Council Scope Honesty" "$SCRIPT_DIR/test-council-scope-honesty.sh"
run_test "Council TODO marker scope (PO3-COUNCIL-TODO)" "$SCRIPT_DIR/test-council-todo-scope.sh"
run_test "Council Transcripts Api" "$SCRIPT_DIR/test-council-transcripts-api.sh"
run_test "Council V2 Quorum" "$SCRIPT_DIR/test-council-v2-quorum.sh"
run_test "council-v2 readers run -I -S and challenge an unmeasured score (S-201)" "$SCRIPT_DIR/test-council-v2-no-user-site-pth.sh"
run_test "Council Vote Parse" "$SCRIPT_DIR/test-council-vote-parse.sh"
run_test "Council Write Transcript Threshold" "$SCRIPT_DIR/test-council-write-transcript-threshold.sh"
run_test "Cross Project Lift" "$SCRIPT_DIR/test-cross-project-lift.sh"
run_test "Da Veto" "$SCRIPT_DIR/test-da-veto.sh"
run_test "Dashboard Identity" "$SCRIPT_DIR/test-dashboard-identity.sh"
run_test "UI bare loki" "$SCRIPT_DIR/test-ui-bare-loki.sh"
run_test "Dashboard Json Guards" "$SCRIPT_DIR/test-dashboard-json-guards.sh"
run_test "Dashboard Memory Endpoints" "$SCRIPT_DIR/test-dashboard-memory-endpoints.sh"
run_test "Dashboard Multiproject" "$SCRIPT_DIR/test-dashboard-multiproject.sh"
run_test "Design System" "$SCRIPT_DIR/test-design-system.sh"
run_test "Docker Bun" "$SCRIPT_DIR/test-docker-bun.sh"
run_test "Docker Helpers W4" "$SCRIPT_DIR/test-docker-helpers-w4.sh"
run_test "Docker Run" "$SCRIPT_DIR/test-docker-run.sh"
run_test "Doctor Ux" "$SCRIPT_DIR/test-doctor-ux.sh"
run_test "E2e Features" "$SCRIPT_DIR/test-e2e-features.sh"
run_test "Embeddings" "$SCRIPT_DIR/test-embeddings.sh"
run_test "Emit Jsonl" "$SCRIPT_DIR/test-emit-jsonl.sh"
run_test "Empty Args No Prd" "$SCRIPT_DIR/test-empty-args-no-prd.sh"
run_test "Enterprise Resilience" "$SCRIPT_DIR/test-enterprise-resilience.sh"
run_test "Events Jsonl Concurrency" "$SCRIPT_DIR/test-events-jsonl-concurrency.sh"
run_test "Evidence Proof Axes" "$SCRIPT_DIR/test-evidence-proof-axes.sh"
run_test "Expectation Ledger" "$SCRIPT_DIR/test-expectation-ledger.sh"
run_test "F3 Port Detection" "$SCRIPT_DIR/test-f3-port-detection.sh"

# Batch 4 of the orphaned-suite registration (2026-07-27).
run_test "Hard Deadline Confinement" "$SCRIPT_DIR/test-hard-deadline-confinement.sh"
run_test "Honest Gate Status" "$SCRIPT_DIR/test-honest-gate-status.sh"
run_test "Human Input Directive" "$SCRIPT_DIR/test-human-input-directive.sh"
run_test "Isolation Dial" "$SCRIPT_DIR/test-isolation-dial.sh"
run_test "Iteration Card Plain" "$SCRIPT_DIR/test-iteration-card-plain.sh"
run_test "Iteration Complete Accuracy" "$SCRIPT_DIR/test-iteration-complete-accuracy.sh"
run_test "Json Prd" "$SCRIPT_DIR/test-json-prd.sh"
run_test "License Audit Pinned Version" "$SCRIPT_DIR/test-license-audit-pinned-version.sh"
run_test "Log Debug Stderr" "$SCRIPT_DIR/test-log-debug-stderr.sh"
run_test "Loki Stop Byid Reap Wave8" "$SCRIPT_DIR/test-loki-stop-byid-reap-wave8.sh"
run_test "Lsp Diagnostics Regression" "$SCRIPT_DIR/test-lsp-diagnostics-regression.sh"
run_test "Lsp Proxy Http" "$SCRIPT_DIR/test-lsp-proxy-http.sh"
run_test "Lsp Proxy" "$SCRIPT_DIR/test-lsp-proxy.sh"
run_test "Magic" "$SCRIPT_DIR/test-magic.sh"
run_test "Mcp Config" "$SCRIPT_DIR/test-mcp-config.sh"
run_test "Acp Agent" "$SCRIPT_DIR/test-acp-agent.sh"
run_test "Mcp Http Auth" "$SCRIPT_DIR/test-mcp-http-auth.sh"
run_test "Memory Audit Fixes" "$SCRIPT_DIR/test-memory-audit-fixes.sh"
run_test "Memory Capture Wedge" "$SCRIPT_DIR/test-memory-capture-wedge.sh"
run_test "Memory Economics Endpoint" "$SCRIPT_DIR/test-memory-economics-endpoint.sh"
run_test "Memory Error Log" "$SCRIPT_DIR/test-memory-error-log.sh"
run_test "Memory Replay" "$SCRIPT_DIR/test-memory-replay.sh"
run_test "Memory Speed Privacy" "$SCRIPT_DIR/test-memory-speed-privacy.sh"
run_test "Memory Wake Dead Code" "$SCRIPT_DIR/test-memory-wake-dead-code.sh"
run_test "Metrics Command" "$SCRIPT_DIR/test-metrics-command.sh"
run_test "Metrics JSON Unmeasured" "$SCRIPT_DIR/test-metrics-json-unmeasured.sh"

# Batch 5 of the orphaned-suite registration (2026-07-27).
run_test "Migration Post Edit Revert" "$SCRIPT_DIR/test-migration-post-edit-revert.sh"
run_test "Migration V2" "$SCRIPT_DIR/test-migration-v2.sh"
run_test "Model And Port" "$SCRIPT_DIR/test-model-and-port.sh"
run_test "Onboard Command" "$SCRIPT_DIR/test-onboard-command.sh"
run_test "Onboard Json Injection Wave10" "$SCRIPT_DIR/test-onboard-json-injection-wave10.sh"
run_test "Openspec Sentinel" "$SCRIPT_DIR/test-openspec-sentinel.sh"
run_test "Parity Mcp Config" "$SCRIPT_DIR/test-parity-mcp-config.sh"
run_test "Platform Infra" "$SCRIPT_DIR/test-platform-infra.sh"
run_test "Policy Failclosed" "$SCRIPT_DIR/test-policy-failclosed.sh"
run_test "Prd Checklist Interval W4" "$SCRIPT_DIR/test-prd-checklist-interval-w4.sh"
run_test "prd-checklist readers ignore user-site .pth (-I -S, S-204)" "$SCRIPT_DIR/test-prd-checklist-no-user-site-pth.sh"
run_test "Prd Directive Envelope" "$SCRIPT_DIR/test-prd-directive-envelope.sh"
run_test "Prd Reuse Bash W4" "$SCRIPT_DIR/test-prd-reuse-bash-w4.sh"
run_test "Proof Forgery Defense" "$SCRIPT_DIR/test-proof-forgery-defense.sh"
run_test "Provider Degraded Reasons Honesty" "$SCRIPT_DIR/test-provider-degraded-reasons-honesty.sh"
run_test "Provider Flags" "$SCRIPT_DIR/test-provider-flags.sh"
run_test "Provider Source Cli" "$SCRIPT_DIR/test-provider-source-cli.sh"
run_test "Rarv Tier Mapping" "$SCRIPT_DIR/test-rarv-tier-mapping.sh"
run_test "Rate Limit Octal" "$SCRIPT_DIR/test-rate-limit-octal.sh"
run_test "Ratelimit Debug Clean" "$SCRIPT_DIR/test-ratelimit-debug-clean.sh"

# Secure-by-default gate (Loop 4): the secure-scan engine precision (bad/safe
# matrix for all 5 rules + the named false-positive guards), the run_secure_scan
# wiring (advisory default never blocks; LOKI_SECURE_GATE=block blocks an
# un-waived HIGH; a waiver suppresses the block), and the `loki secure
# waive|unwaive|list` CLI shape. Receipt honesty is in tests/test_proof_generator.py.
run_test "Secure-by-Default Gate (engine precision + wiring + waiver CLI)" "$SCRIPT_DIR/test-secure-scan.sh"

# Proven PR (Loop 6 / v7.90.0): the Evidence Receipt rendered into the PR body
# Loki opens. Honesty: a green/VERIFIED claim only when honesty.headline==VERIFIED;
# advisory check-run is opt-in and cannot block a merge; verify-yourself works on
# the default route + installed layout (F47 guard). Tests PATH-stub gh/glab and
# capture argv/body -- they NEVER open a real PR or post a real check.
run_test "Proven PR Receipt (PR-body honesty + no false green)" "$SCRIPT_DIR/test-proven-pr-receipt.sh"
run_test "Proven PR Check-Run (advisory, opt-in, cannot block merge)" "$SCRIPT_DIR/test-proven-pr-check.sh"
run_test "proof-check readers ignore user-site .pth (-I -S, S-203)" "$SCRIPT_DIR/test-proof-check-no-user-site-pth.sh"
run_test "PR receipt renderer ignores cwd json.py (-I -S, S-215)" "timeout -k 10 120 $SCRIPT_DIR/test-proof-pr-no-cwd-shadow.sh"
run_test "Proven PR Installed-Layout (verify-yourself works on shipped routes)" "$SCRIPT_DIR/test-proven-pr-installed-layout.sh"
run_test "Proven PR Detached Path (cmd_run --pr/--ship -d carries receipt)" "$SCRIPT_DIR/test-proven-pr-detached.sh"

# Build-time HOME isolation (F49): Loki's in-build app executions must run with an
# isolated HOME/XDG/TMPDIR so a generated app cannot litter the user's real home.
run_test "Build-time HOME isolation (in-build app exec sandbox)" "$SCRIPT_DIR/test-build-home-isolation.sh"

# Reuse done-recognition gate (v7.94.0): a no-PRD reuse run over an already-done
# project must model-verify "already satisfied?" and fast-stop instead of
# rebuilding finished work; never fake-green; build only the unsatisfied gap.
run_test "Reuse done-recognition gate (no-PRD reuse: done/incomplete/inconclusive)" "$SCRIPT_DIR/test-reuse-done-recognition.sh"
run_test "done-recognition readers ignore user-site .pth (-I -S, S-200)" "$SCRIPT_DIR/test-done-recognition-no-user-site-pth.sh"
run_test "voter-agents readers ignore user-site .pth (-I -S, S-202)" "$SCRIPT_DIR/test-voter-agents-no-user-site-pth.sh"

# Multi-provider issue backends (#7 team parity): detection, parse, normalize
# for GitHub / GitLab / Jira / Azure DevOps -- network-free, mocked responses.
run_test "Issue providers (GitHub/GitLab/Jira/Azure detect+parse+normalize)" "$SCRIPT_DIR/test-issue-providers.sh"
run_test "prepared PR publishes only with explicit consent, exact body, and rollback" "$SCRIPT_DIR/cli/test-publish-prepared-pr.sh"

# local-ci FAST/FULL tiering: the fast tier must never be mistaken for the full
# pre-push gate, and must never stop covering the trust core. Static assertions
# only -- never runs the real gate.
run_test "local-ci tiers (fast never green-washes full; trust core always kept)" "$SCRIPT_DIR/test-local-ci-tiers.sh"
run_test "parent checkout core.bare detection self-heals without green-washing" "$SCRIPT_DIR/test-core-bare-selfheal.sh"

# E-60: local-ci fast-tier gitleaks step (scoped to origin/main..HEAD, reviewed
# .gitleaksignore baseline, SKIP not pass when the binary is absent). Live
# temp-repo scenarios only run when gitleaks is on PATH; static assertions
# always run.
run_test "local-ci gitleaks fast-tier step (scoped scan, skip-not-pass, literal vs concatenated fixture)" "$SCRIPT_DIR/test-local-ci-gitleaks.sh"

# E-114: security-audit.yml's gitleaks CI gate never trusts a pushed
# .gitleaks.toml -- refuses the job when the range changes it (no automatic
# bypass), scans with the base commit's config (or gitleaks' default rules),
# and warns (never blocks) on a .gitleaksignore addition. SKIP not pass when
# the binary is absent.
run_test "security-audit.yml gitleaks config isolation (refuse config change, base-config scan, gitleaksignore warning)" "$SCRIPT_DIR/test-security-audit-config.sh"

# E-94: local-ci fast-tier hermetic changed-tests scan (re-runs every changed
# tests/*.sh, tests/*.py, loki-ts/tests/** under env -i with no gh/network,
# fails naming any file that passes normally but fails stripped). Live temp-
# repo scenarios (a gh-calling fixture, the real pre-E-92 dep-inventory.py
# replay) run whenever python3 and gh are on PATH; static assertions always
# run.
run_test "local-ci hermetic changed-tests scan (no gh/network, catches pre-E-92 dep-inventory regression)" "$SCRIPT_DIR/test-local-ci-hermetic.sh"

# Linting
run_test "Export overwrite guard (non-interactive never hangs)" "$SCRIPT_DIR/test-export-overwrite-noninteractive.sh"
run_test "Time-to-first-preview metric (write-once, never invented)" "$SCRIPT_DIR/test-first-preview-metric.sh"
run_test "Session knobs stay default-OFF (gates the v8 SDK-flip audit)" "$SCRIPT_DIR/test-session-knobs-default-off.sh"
run_test "shards partition the suite list (no silently dropped suite)" "$SCRIPT_DIR/test-shard-coverage.sh"
run_test "shard-durations.tsv drift detector (S-134)" "$SCRIPT_DIR/test-shard-durations-drift.sh"
run_test "version-bump-only push skips heavy Tests jobs (S-132)" "$SCRIPT_DIR/test-version-bump-only.sh"
run_test "train verdict reuse on main push (E-160, D55)" "$SCRIPT_DIR/test-train-verdict-reuse.sh"
run_test "council gate readers use the resolved -I -S interpreter (S-141)" "$SCRIPT_DIR/test-council-gate-readers-pth.sh"
run_test "Tier A test selector (S-91 rules R0-R7)" "$SCRIPT_DIR/test-select-tests.sh"
run_test "quarantine (non-blocking listed failure, rejects expired/moat/review/>7d)" "$SCRIPT_DIR/test-quarantine.sh"
run_test "quickstart scorer works on macOS bash 3.2 (first-run path)" "$SCRIPT_DIR/test-quickstart-bash32.sh"
run_test "first-run path works on macOS bash 3.2 (welcome, tour, quickstart)" "$SCRIPT_DIR/test-first-run-bash32.sh"
run_test "competitor verify surface (head-to-head, locally reproducible)" "$SCRIPT_DIR/test-competitor-verify-surface.sh"
run_test "efficiency baseline pipeline (writer + collector, honest zero)" "$SCRIPT_DIR/test-efficiency-baseline-pipeline.sh"
run_test "time-to-first-preview reaches the user (not just disk)" "$SCRIPT_DIR/test-first-preview-surfaced.sh"
run_test "per-stage timing reaches the user (where the time went)" "$SCRIPT_DIR/test-stage-timing-surfaced.sh"
run_test "iteration attribution (progress vs rework, honest null)" "$SCRIPT_DIR/test-iteration-attribution.sh"
run_test "receipt attributes cost to progress vs rework" "$SCRIPT_DIR/test-receipt-rework-attribution.sh"
run_test "silence report (longest in-build gap, idle excluded)" "$SCRIPT_DIR/test-silence-report.sh"
run_test "free on-ramp stays wired (codex, zero API spend)" "$SCRIPT_DIR/test-free-onramp.sh"
run_test "argv seam model flags (all providers; codex effort, max-tier clamp)" "$SCRIPT_DIR/test-codex-argv-model.sh"
run_test "helm values schema rejects bad values by name" "$SCRIPT_DIR/test-helm-values-schema.sh"
run_test "helm worker scaling knob and tenancy invariant" "$SCRIPT_DIR/test-helm-worker-scaling.sh"
run_test "helm test hook proves the release serves" "$SCRIPT_DIR/test-helm-test-hook.sh"
run_test "ECS/Fargate module structure + Helm parity" "$SCRIPT_DIR/test-ecs-fargate-module.sh"
run_test "audit PVC can outlive the release (compliance)" "$SCRIPT_DIR/test-audit-pvc-retention.sh"
run_test "worker grace period honours mid-build shutdown" "$SCRIPT_DIR/test-worker-grace-period.sh"
run_test "k8s sizing says what was measured and what was not" "$SCRIPT_DIR/test-k8s-sizing-honesty.sh"
run_test "air-gapped k8s install is honest about scope" "$SCRIPT_DIR/test-airgap-k8s-install.sh"
run_test "enterprise smoke script contract (offline)" "$SCRIPT_DIR/test-enterprise-smoke-script.sh"
run_test "image provenance: signing and SBOM in the publish job" "$SCRIPT_DIR/test-image-provenance.sh"
run_test "doctor is CI-gateable (nonzero on missing required dep)" "$SCRIPT_DIR/test-doctor-ci-gateable.sh"
run_test "completion coverage (every real command in both shells)" "$SCRIPT_DIR/test-completion-coverage.sh"
run_test "dry-run paths work and are discoverable from start --help" "$SCRIPT_DIR/test-dry-run-discoverable.sh"
run_test "exit codes documented and matching the source" "$SCRIPT_DIR/test-exit-codes-documented.sh"
run_test "Exit-code contract is discoverable from --help" "$SCRIPT_DIR/test-exit-codes-discoverable.sh"
run_test "log verbosity (--quiet / LOKI_LOG_LEVEL, errors never hidden)" "$SCRIPT_DIR/test-log-verbosity.sh"
run_test "verify --json emits pipeable evidence on stdout" "$SCRIPT_DIR/test-verify-json-stdout.sh"
run_test "documented env vars exist in the source" "$SCRIPT_DIR/test-env-vars-documented.sh"
run_test "generic tiers (small|medium|high) resolve for every provider" "$SCRIPT_DIR/test-generic-tiers.sh"
run_test "wall-clock cap (LOKI_MAX_DURATION) fires and is terminal" "$SCRIPT_DIR/test-max-duration.sh"
run_test "startup preflight blocks a doomed build, stays advisory where optional" "$SCRIPT_DIR/test-preflight-checks.sh"
run_test "magic debate gate (Gate 12) can actually block" "$SCRIPT_DIR/test-magic-debate-gate.sh"
run_test "review council cap trims the tail, never the mandate" "$SCRIPT_DIR/test-review-council-cap.sh"
run_test "review skip on gate failure never records a pass" "$SCRIPT_DIR/test-review-skip-on-gate-fail.sh"
run_test "time-to-first-artifact is recorded and rendered" "$SCRIPT_DIR/test-first-artifact-signal.sh"
run_test "council cap binds on the REAL selector" "$SCRIPT_DIR/test-review-cap-real-selector.sh"
run_test "gate detectors ship in the npm package" "$SCRIPT_DIR/test-detectors-are-packaged.sh"
run_test "runtime python libs ship in the npm package" "$SCRIPT_DIR/test-runtime-libs-are-packaged.sh"
run_test "npm artifacts have portable permissions" "$SCRIPT_DIR/test-package-permissions.sh"
run_test "packaged MCP server exposes the exact tool surface" "$SCRIPT_DIR/test-mcp-tool-surface-packaged.sh"
run_test "MCP contract guard rejects rename/deletion/missing prereqs" "$SCRIPT_DIR/test-mcp-tool-surface-guard-rejects.sh"
run_test "npm SBOM is attached to the GitHub Release" "$SCRIPT_DIR/test-release-sbom-attached.sh"
run_test "release.sh version-bump preserves file mode (BACKLOG 22)" "$SCRIPT_DIR/test-release-sh.sh"
run_test "loki why maps each error class to an action" "$SCRIPT_DIR/test-why-actions.sh"
run_test "loki start surfaces a stale install" "$SCRIPT_DIR/test-start-update-hint.sh"
run_test "loki help does not recurse into itself" "$SCRIPT_DIR/test-help-no-recursion.sh"
run_test "no test uses a platform-divergent construct" "$SCRIPT_DIR/test-ci-only-divergence.sh"
run_test "doctor detects an incomplete install" "$SCRIPT_DIR/test-doctor-install-integrity.sh"
run_test "findings injection degrades loudly, never silently" "$SCRIPT_DIR/test-findings-injection-degrade.sh"
run_test "a stuck gate aborts instead of grinding" "$SCRIPT_DIR/test-gate-stuck-abort.sh"
run_test "iteration 1 names the gates that will judge it" "$SCRIPT_DIR/test-first-pass-gate-directive.sh"
run_test "iteration cap is bounded without truncating real runs" "$SCRIPT_DIR/test-iteration-cap-default.sh"
run_test "codex usage and cost are recovered, unknown never zero" "$SCRIPT_DIR/test-codex-usage-cost.sh"
run_test "cache-stable prompt prefix stays free of volatile values" "$SCRIPT_DIR/test-cache-breakpoint-discipline.sh"
run_test "no raw shell error when .loki/config is a directory" "$SCRIPT_DIR/test-disclosure-config-directory.sh"
run_test "startup is instrumented, never a silent gap" "$SCRIPT_DIR/test-startup-instrumentation.sh"
run_test "every handled gate escalates its findings" "$SCRIPT_DIR/test-gate-escalation-coverage.sh"
run_test "cost honesty holds across every surface" "python3 -m pytest -q $SCRIPT_DIR/test_cost_honesty_end_to_end.py"
run_test "a partly priced run renders as at least, never a total" "python3 -m pytest -q $SCRIPT_DIR/dashboard/test_cost_partial_surfaced.py"
run_test "web-app status push sends null for unmeasured cost (S-192)" "python3 -m pytest -q -p no:cacheprovider $SCRIPT_DIR/../web-app/tests/test_status_push_unmeasured.py"
run_test "the agent call reports its own prompt size" "$SCRIPT_DIR/test-agent-prompt-size.sh"
run_test "per-turn context growth is measured" "$SCRIPT_DIR/test-context-growth-instrumentation.sh"
run_test "provider auto-detection is wired" "$SCRIPT_DIR/test-provider-autodetect.sh"
run_test "the two provider lists agree" "$SCRIPT_DIR/test-provider-lists-agree.sh"
run_test "preflight verdict is honest" "$SCRIPT_DIR/test-preflight-verdict.sh"
run_test "the provider docs match the code" "$SCRIPT_DIR/test-provider-docs-match-code.sh"
run_test "every opencode dispatch path passes --auto" "$SCRIPT_DIR/test-provider-config-autonomous-flag.sh"
run_test "a dropped event is visible" "$SCRIPT_DIR/test-event-drop-visible.sh"
run_test "events carry the source the dashboard reads" "$SCRIPT_DIR/test-event-source-attribution.sh"
run_test "proof verify --human explains a failure" "$SCRIPT_DIR/test-proof-verify-human.sh"
run_test "the verification demo runs the real tools" "$SCRIPT_DIR/test-verify-demo.sh"
run_test "cost and estimate are reachable from the CLI" "$SCRIPT_DIR/test-cost-cli.sh"
run_test "quickstart names the provider that will run" "$SCRIPT_DIR/test-quickstart-provider-detect.sh"
run_test "explicit provider preflight" "$SCRIPT_DIR/test-provider-preflight.sh"
run_test "doctor shows provider availability" "$SCRIPT_DIR/test-doctor-providers.sh"
run_test "interrupted runs surface how to resume" "$SCRIPT_DIR/test-resume-discoverability.sh"
run_test "install integrity is checked on both doctor routes" "$SCRIPT_DIR/test-doctor-install-integrity-parity.sh"
run_test "model catalog: no tier points at a superseded flagship" "$SCRIPT_DIR/test-model-catalog-current-flagship.sh"
run_test "model catalog staleness is advisory in doctor" "$SCRIPT_DIR/test-model-catalog-staleness.sh"
run_test "doctor blocker parity (both routes name blockers + offer loki tour)" "$SCRIPT_DIR/test-doctor-blocker-parity.sh"
run_test "stale skill link for an optional provider does not block doctor" "$SCRIPT_DIR/test-doctor-optional-skill-not-blocking.sh"
run_test "first_run_blocked signal (opt-out silent, enum-clamped)" "$SCRIPT_DIR/test-first-run-blocked-signal.sh"
run_test "a green doctor never recommends a command that exits 2" "$SCRIPT_DIR/test-doctor-next-recommendation.sh"
run_test "analytics opt-in has a writer (the funnel can fire)" "$SCRIPT_DIR/test-telemetry-analytics-toggle.sh"
run_test "help discoverability (every command reachable)" "$SCRIPT_DIR/test-help-discoverability.sh"
run_test "assess runtime detection (declared, never guessed)" "$SCRIPT_DIR/test-assess-runtime-detection.sh"
run_test "provider model scoping (global tier var must not leak)" "$SCRIPT_DIR/test-provider-model-scoping.sh"
run_test "model catalog is a single source of truth" "$SCRIPT_DIR/test-model-catalog-single-source.sh"
run_test "MiniMax model catalog and compatible endpoints" "$SCRIPT_DIR/test-minimax-model-catalog.sh"
run_test "model catalog staleness is advisory and route-consistent" "$SCRIPT_DIR/test-model-catalog-staleness.sh"
run_test "pre-push hook (post-D27: identity + syntax + no pytest + speed)" "$SCRIPT_DIR/test-pre-push-hook.sh"
run_test "pre-push hook eval-fixture gitleaks step (E-86)" "$SCRIPT_DIR/test-pre-push-gitleaks.sh"
run_test "loki help <command> and the daily log cap" "$SCRIPT_DIR/test-help-and-log-cap.sh"
run_test "model picker is provider-aware (no claude models on codex)" "python3 $SCRIPT_DIR/test-provider-aware-model-picker.py"
run_test "codex capability tiers resolve to distinct real models" "$SCRIPT_DIR/test-codex-tier-models.sh"
run_test "scoped issue fix skips greenfield-only phases" "$SCRIPT_DIR/test-scoped-change-profile.sh"
run_test "a force-stop reports failure, not success" "$SCRIPT_DIR/test-force-stop-exit-code.sh"
run_test "the iteration cap considers evidence but stays a cap" "$SCRIPT_DIR/test-iteration-grace.sh"
run_test "the user sees the rework split, not just the agent" "$SCRIPT_DIR/test-rework-in-summary.sh"
run_test "the token report counts cache tokens" "$SCRIPT_DIR/test-economics-cache-tokens.sh"
run_test "a terminal outcome names the next step" "$SCRIPT_DIR/test-terminal-next-step.sh"
run_test "loki why is rework-aware on the iteration cap" "$SCRIPT_DIR/test-why-rework-aware.sh"
run_test "loki why --json carries the rework split" "$SCRIPT_DIR/test-why-json-rework.sh"
run_test "loki cost --json exposes the token breakdown" "$SCRIPT_DIR/test-cost-json-tokens.sh"
run_test "loki cost reads unmeasured budget spend as null" "$SCRIPT_DIR/test-loki-cost-unmeasured.sh"
run_test "all reporting surfaces agree about one run" "$SCRIPT_DIR/test-surfaces-agree.sh"
run_test "recorded exit codes match the failure contract" "$SCRIPT_DIR/test-exit-code-contract.sh"
run_test "the receipt shows disabled gates" "$SCRIPT_DIR/test-receipt-shows-disabled-gates.sh"
run_test "the public HTML receipt shows disabled gates" "$SCRIPT_DIR/test-html-receipt-disabled-gates.sh"
run_test "the founder-decisions document is accurate" "$SCRIPT_DIR/test-founder-decisions-doc-accurate.sh"
run_test "entry-document pointers resolve" "$SCRIPT_DIR/test-entry-doc-pointers-resolve.sh"
run_test "a pause needs no TTY, and a run names its receipt" "$SCRIPT_DIR/test-pause-tty-and-receipt-surface.sh"
run_test "the mutation probe cannot silently no-op" "$SCRIPT_DIR/test-mutation-probe.sh"
run_test "the Quality page shows which gates block" "$SCRIPT_DIR/test-gate-policy-ui-line.sh"
run_test "the evidence receipt is reachable from the dashboard" "$SCRIPT_DIR/test-receipts-panel.sh"
run_test "the build's learnings are visible" "$SCRIPT_DIR/test-learnings-panel.sh"
run_test "the spend-cap state is visible" "$SCRIPT_DIR/test-budget-banner.sh"
run_test "the Cost page budget banner has its own id" "$SCRIPT_DIR/test-budget-banner-dedup.sh"
run_test "trust-core tests detect their regressions" "$SCRIPT_DIR/test-trust-core-tests-detect.sh"
run_test "trust-core probes never mutate the shared tree" "$SCRIPT_DIR/test-trust-core-probe-isolation.sh"
run_test "a user-installed reviewer takes part in a run" "$SCRIPT_DIR/test-installed-agent-reviewer.sh"
# Skill modules are loaded INTO the agent's context and acted on, so a false
# claim there is worse than no claim. Asserts the load-bearing ones against source.
run_test "skill docs match source (gate flags, providers, tiers, index routing, seam)" "$SCRIPT_DIR/test-skill-doc-accuracy.sh"
run_test "SKILL.md runtime-migration paragraph does not understate the Bun route" "timeout -k 10 120 $SCRIPT_DIR/test-skill-md-runtime-claim.sh"
run_test "proof md (paste-able receipt, one renderer)" "$SCRIPT_DIR/test-proof-md.sh"
run_test "air-gapped read-only path (egress severed)" "$SCRIPT_DIR/test-airgap-commands.sh"
run_test "doctor --airgap judges OLLAMA_HOST locality from the host, not a substring match" "$SCRIPT_DIR/test-airgap-ollama-host.sh"
run_test "proof phases CLI/API parity (one reader, two surfaces)" "$SCRIPT_DIR/test_cli_phases_parity.sh"
run_test "web-app has no orphaned modules (reachable from main.tsx)" "$SCRIPT_DIR/test-web-app-no-orphan-components.sh"
run_test "web-app CommandPalette file-search failure is not no-results (node --test)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; node --test $SCRIPT_DIR/../web-app/src/components/CommandPalette.state.test.mjs"
# The moat runner's self-test builds and tags its own throwaway repos, so it is
# safe in a depth-1 shard. The runner itself (tests/moat/run.sh) is NOT
# registered here: it ratchets against the last release tag, which a depth-1
# shard checkout does not have. It runs in its own "Moat rules (no regression)" job instead.
run_test "the moat runner enforces every ratchet rule" "$SCRIPT_DIR/test-moat-runner.sh"
run_test "v10-pulse anti-drift status/violation reporter" "$SCRIPT_DIR/test-v10-pulse.sh"
run_test "board-mark-released flips a slice's merged row once its tag ships (E-90)" "$SCRIPT_DIR/test-board-mark-released.sh"
run_test "release.sh --bump-only restores debugId-only dist churn (E-72)" "$SCRIPT_DIR/test-release-bump-only.sh"
run_test "release.sh --bump-only never leaves dist deleted on build failure (E-102)" "$SCRIPT_DIR/test-release-bump-dist.sh"
run_test "release.sh --bump-only refuses dist maps with absolute or repo-escaping sources (E-133)" "$SCRIPT_DIR/test-release-dist-guard.sh"
run_test "release publishes to npm next; promote.yml gates latest on the first-run gate (A-01)" "python3 -m pytest -q $SCRIPT_DIR/test_release_next_tag.py"
run_test "release-notes.sh extraction/validation + pre-push VERSION-bump gate (E-88)" "$SCRIPT_DIR/test-release-notes.sh"
run_test "no hardcoded far-future latest a release can overtake (E-73)" "$SCRIPT_DIR/test-no-stale-future-version.sh"
run_test "timeout launches of run.sh/autonomy/loki escalate with -k (E-00)" "$SCRIPT_DIR/test-timeout-escalates.sh"
run_test "v10 drift-audit turn counter (every-6th-turn signal)" "$SCRIPT_DIR/test-v10-drift-audit-counter.sh"
run_test "v10 slice-card template (fields, budget, dispatch rule)" "$SCRIPT_DIR/test-v10-slice-card.sh"

# S-93: registration-coverage cleanup batch. These suites existed and passed
# (some after a genuine bug fix; see commit) but were wired into no runner --
# indistinguishable from no test at all. See test-registration-coverage.sh.
run_test "Add-dir reaches provider" "$SCRIPT_DIR/test-add-dir-reaches-provider.sh"
run_test "Auto-PR default on" "$SCRIPT_DIR/test-auto-pr-default-on.sh"
run_test "Delegate PR refuses the repo default branch" "$SCRIPT_DIR/test-delegate-default-branch.sh"
run_test "Dashboard port ownership" "$SCRIPT_DIR/test-dashboard-port-ownership.sh"
run_test "Dashboard static fallback and reuse" "$SCRIPT_DIR/test-dashboard-static-fallback.sh"
run_test "No dashboard leak from suites" "$SCRIPT_DIR/test-no-dashboard-leak.sh"
run_test "Dashboard leak2: fail-closed reuse and bound-port URL" "$SCRIPT_DIR/test-dashboard-leak2.sh"
run_test "Doctor --json skills section" "$SCRIPT_DIR/test-doctor-json-skills.sh"
run_test "Emit hang forensics" "$SCRIPT_DIR/test-emit-hang-forensics.sh"
run_test "Issue PRD honesty" "$SCRIPT_DIR/test-issue-prd-is-honest.sh"
run_test "Next/resume agreement" "$SCRIPT_DIR/test-next-resume-agree.sh"
run_test "PGID stale reap" "$SCRIPT_DIR/test-pgid-stale-reap.sh"
run_test "Pipeline panel" "$SCRIPT_DIR/test-pipeline-panel.sh"
run_test "Provider arm coverage" "$SCRIPT_DIR/test-provider-arm-coverage.sh"
run_test "Queue tasks not truncated" "$SCRIPT_DIR/test-queue-tasks-not-truncated.sh"
run_test "Rate limiting" "$SCRIPT_DIR/test-rate-limiting.sh"
run_test "Remote receipt verify" "$SCRIPT_DIR/test-remote-receipt-verify.sh"
run_test "Remote submit" "$SCRIPT_DIR/test-remote-submit.sh"
run_test "Reviewer persona reaches prompt" "$SCRIPT_DIR/test-reviewer-persona-reaches-prompt.sh"
run_test "Setup skill conflicts" "$SCRIPT_DIR/test-setup-skill-conflicts.sh"
run_test "Simple prompt ablation" "$SCRIPT_DIR/test-simple-prompt-ablation.sh"
run_test "Skills/references copied" "$SCRIPT_DIR/test-skills-references-copied.sh"
run_test "Spec interrogation bughunt (wave 4)" "$SCRIPT_DIR/test-spec-interrogation-bughunt-w4.sh"
run_test "Stale dashboard PID" "$SCRIPT_DIR/test-stale-dashboard-pid.sh"
run_test "Start banner dedup" "$SCRIPT_DIR/test-start-banner-dedup.sh"
run_test "Start handoff" "$SCRIPT_DIR/test-start-handoff.sh"
run_test "State notifications" "$SCRIPT_DIR/test-state-notifications.sh"
run_test "Static analysis iteration baseline" "$SCRIPT_DIR/test-static-analysis-iteration-baseline.sh"
run_test "Static analysis tsconfig" "$SCRIPT_DIR/test-static-analysis-tsconfig.sh"
run_test "Status CLI/provider parity" "$SCRIPT_DIR/test-status-cli-provider-parity.sh"
run_test "Status --explain heal injection (wave 8)" "$SCRIPT_DIR/test-status-explain-heal-injection-wave8.sh"
run_test "Supervised dependency setup" "$SCRIPT_DIR/test-supervised-dependency-setup.sh"
run_test "Supervised disclosure scope" "$SCRIPT_DIR/test-supervised-disclosure-scope.sh"
run_test "Supervised simple-web fastpath" "$SCRIPT_DIR/test-supervised-simple-web-fastpath.sh"
run_test "Swarm intelligence" "$SCRIPT_DIR/test-swarm-intelligence.sh"
run_test "Test command" "$SCRIPT_DIR/test-test-command.sh"
run_test "Test provenance gate" "$SCRIPT_DIR/test-test-provenance-gate.sh"
run_test "Tier harness policy" "$SCRIPT_DIR/test-tier-harness-policy.sh"
run_test "Ultracode command" "$SCRIPT_DIR/test-ultracode-command.sh"
run_test "Unified memory" "$SCRIPT_DIR/test-unified-memory.sh"
run_test "Usage markdown render" "$SCRIPT_DIR/test-usage-markdown-render.sh"
run_test "Verification gap" "$SCRIPT_DIR/test-verification-gap.sh"
run_test "Vibe-kanban export" "$SCRIPT_DIR/test-vibe-kanban-export.sh"
run_test "Voter agents JSON" "$SCRIPT_DIR/test-voter-agents-json.sh"
run_test "Web redirects to dashboard" "$SCRIPT_DIR/test-web-redirects-to-dashboard.sh"
run_test "Audit chain cross-file verification" "$SCRIPT_DIR/test-audit-chain-cross-file.sh"
run_test "Cline provider E2E" "$SCRIPT_DIR/test-cline-e2e.sh"
run_test "Dashboard hook events (Live Tool Activity)" "$SCRIPT_DIR/test-dashboard-hook-events.sh"
run_test "Dashboard api_runs unreadable reads (HONEST-READ-2)" "timeout -k 10 120 python3 -m pytest -q $SCRIPT_DIR/dashboard/test_api_runs_unreadable.py"
run_test "Dashboard /api/v1/runs REST API" "timeout -k 10 120 python3 -m pytest -q $SCRIPT_DIR/dashboard/test_api_runs_v1.py"
run_test "Learning aggregator" "$SCRIPT_DIR/test-learning-aggregator.sh"
run_test "Learning signal emission" "$SCRIPT_DIR/test-learning-emit.sh"
run_test "Learning suggestions" "$SCRIPT_DIR/test-learning-suggestions.sh"
run_test "MCP learning collector" "$SCRIPT_DIR/test-mcp-learning-collector.sh"
run_test "Progressive isolation CLI help" "$SCRIPT_DIR/test-progressive-isolation.sh"
run_test "Project graph discovery" "$SCRIPT_DIR/test-project-graph.sh"
run_test "State versioning (SYN-015)" "$SCRIPT_DIR/test-state-versioning.sh"
run_test "Welcome opener (terminal + browser)" "$SCRIPT_DIR/test-welcome-opener.sh"

run_test "Browser-open guard (tests never open a browser, S-103)" "$SCRIPT_DIR/test-browser-open-guard.sh"
run_test "prune-worktrees treats cherry-picked branches as merged (S-154)" "$SCRIPT_DIR/test-prune-worktrees.sh"
run_test "Eval results archive: redaction and dirty-check exclude (E-101)" "$SCRIPT_DIR/test-eval-archive.sh"
run_test "run_test missing or empty argument does not stop the runner (S-174)" "$SCRIPT_DIR/test-run-all-missing-arg.sh"
run_test "proof headline ignores a stale test-results.json (S-176)" "python3 -m pytest -q $SCRIPT_DIR/test_proof_tests_freshness.py"
run_test "Managed completion council flag (BACKLOG 75, S-211)" "$SCRIPT_DIR/council/test_managed_completion_flag.sh"
run_test "Managed review flag (BACKLOG 75, S-211)" "$SCRIPT_DIR/council/test_managed_review_flag.sh"
run_test "Evidence gate with no tests (BACKLOG 75, S-211)" "$SCRIPT_DIR/test-evidence-gate-no-tests.sh"
run_test "LOKI_AUTO_PR refuses a branch whose history holds user files (S-194)" "$SCRIPT_DIR/test-auto-pr-agent-committed-refuse.sh"
run_test "Session commit warns on a failed git add (S-219)" "timeout -k 10 120 $SCRIPT_DIR/test-session-commit-add-failure.sh"
run_test "Untrack keeps force-staged agent files (S-220)" "timeout -k 10 120 $SCRIPT_DIR/test-untrack-keeps-force-staged.sh"
run_test "focus POST skipped when the dashboard is disabled (S-195)" "$SCRIPT_DIR/test-focus-post-dashboard-off.sh"
run_test "Loki 10 eval harness runner and scorer (EV-1)" "$SCRIPT_DIR/../eval/loki10/test-harness.sh"
run_test "Loki 10 gate report generator (E-33)" "$SCRIPT_DIR/../eval/loki10/test-gate-report.sh"
run_test "Loki 10 engine trusted push and PR (E-11)" "$SCRIPT_DIR/test-engine10-push.sh"
run_test "Loki 10 engine dispatch hook (E-12)" "$SCRIPT_DIR/test-engine10-dispatch.sh"
run_test "loki verify --pubkey=FILE routes to v10 through bin/loki (P0-VERIFY-ARG)" "$SCRIPT_DIR/test-verify-pubkey-cli.sh"
run_test "metrics-usage-append arg parsing, block format, repeat append (PO-TEST-1)" "timeout -k 10 120 $SCRIPT_DIR/test-metrics-usage-append.sh"
run_test "Loki 10 legacy route contract golden rows (E-30)" "$SCRIPT_DIR/test-engine10-legacy-contract.sh"
run_test "Loki 10 live PR smoke on a sandbox repo (E-40)" "$SCRIPT_DIR/test-engine10-live-pr.sh"
run_test "Loki control plane wiring: serve, backfill, UI (CP-04)" "$SCRIPT_DIR/test-control-plane.sh"
run_test "Loki 10 engine runs from dist and the npm package (E-32)" "$SCRIPT_DIR/test-engine10-dist.sh"
run_test "run-owned temp cleanup works when sourced under zsh" "$SCRIPT_DIR/test-run-tmp-cleanup-zsh.sh"
run_test "Loki 10 legacy deprecation notice (E-35)" "$SCRIPT_DIR/test-engine10-legacy-notice.sh"
run_test "bin/loki bun resolver and no-bun notice (P0-nobun-S2)" "$SCRIPT_DIR/test-bin-loki-bun-resolve.sh"
run_test "Loki 10 gate publish script (EV-6)" "$SCRIPT_DIR/../eval/loki10/test-publish-gate.sh"
run_test "Loki 10 user docs match USAGE and the default marker (E-34)" "$SCRIPT_DIR/test-engine10-docs.sh"
run_test "Loki modernize py2/3 capture tracer (M-09)" "$SCRIPT_DIR/test-modernize-py-capture.sh"
run_test "Loki modernize user guide matches cli.ts flags (M-30)" "$SCRIPT_DIR/test-modernize-docs.sh"
run_test "Docs name only CLI commands, flags and versions on main (DOC-02)" "$SCRIPT_DIR/test-docs-cli-drift.sh"
run_test "loki modernize always routes to engine10 (M-08)" "$SCRIPT_DIR/test-modernize-dispatch.sh"
run_test "Dependency inventory Latest/Bump self-consistency (DEP-01)" "$SCRIPT_DIR/test-dep-inventory.sh"
run_test "Usage governor calibration and dedup (G-01)" "$SCRIPT_DIR/test-usage-governor.sh"
run_test "Usage governor statusLine logger (G-01)" "$SCRIPT_DIR/test-usage-statusline-logger.sh"
run_test "cloud-dispatch dry-run refuses on overlap, governor max, not-ready (G-04)" "timeout -k 10 120 $SCRIPT_DIR/test-cloud-dispatch.sh"
run_test "CI security scanners wired, fail-closed (E-123)" "$SCRIPT_DIR/test-security-scan-coverage.sh"
run_test "Heredoc dollar-digit footgun checker (D44)" "$SCRIPT_DIR/test-check-heredoc-dollar-digit.sh"
run_test "Inline script syntax gate parses dashboard HTML" "timeout -k 10 60 $SCRIPT_DIR/test-check-inline-scripts.sh"
run_test "CI cache scope (D44)" "$SCRIPT_DIR/test-ci-cache-scope.sh"
run_test "Engine10 push GitLab (D44)" "$SCRIPT_DIR/test-engine10-push-gitlab.sh"
run_test "gh withhold nested (D44)" "$SCRIPT_DIR/test-gh-withhold-nested.sh"
run_test "SettingsPage has no Gemini (D44)" "$SCRIPT_DIR/test-settingspage-no-gemini.sh"
run_test "Trusted push agent config (D44)" "$SCRIPT_DIR/test-trusted-push-agent-config.sh"
run_test "v10 guard rules (D44)" "$SCRIPT_DIR/test-v10-guard.sh"
run_test "first-run gate assertion logic (A-02)" "$SCRIPT_DIR/test-first-run-gate.sh"
run_test "real-repo acceptance gate logic (D58-GATE)" "timeout -k 10 120 $SCRIPT_DIR/test-real-repo-gate.sh"
run_test "json schemas validate real why and status output (D48 r5)" "$SCRIPT_DIR/test-json-schemas.sh"
run_test "Every test suite is registered in a runner (D44)" "$SCRIPT_DIR/test-registration-coverage.sh"
run_test "Structural checks catch planted defects (D44-C)" "$SCRIPT_DIR/test-structural-checks.sh"
run_test "v10 ops (E-142)" "$SCRIPT_DIR/test-v10-ops.sh"
run_test "loki-seal Stop hook (A-04)" "$SCRIPT_DIR/../packages/loki-seal/test/run.sh"
run_test "Quick-fix artifacts (A-132)" "$SCRIPT_DIR/test-quick-artifacts.sh"
run_test "Council trivial-diff probe skip (A-133)" "$SCRIPT_DIR/test-council-trivial-diff.sh"
run_test "Quick receipt order and quiet output (A-134)" "$SCRIPT_DIR/test-quick-receipt-order.sh"
run_test "Quick config safety (P0-t15)" "$SCRIPT_DIR/test-quick-config-safety.sh"
run_test "Loki Seal marketplace (D48 r10)" "$SCRIPT_DIR/test-loki-seal-marketplace.sh"
run_test "Quick integrity exit code (A-118)" "$SCRIPT_DIR/test-quick-integrity-rc.sh"
run_test "Quick quiet failure tail and stdin (A-134b)" "$SCRIPT_DIR/test-quick-quiet-tail.sh"
run_test "Pre-commit author email guard (E-153)" "$SCRIPT_DIR/test-pre-commit-author-guard.sh"
run_test "Provider stdin closed under verbose (A-134c)" "$SCRIPT_DIR/test-provider-stdin-closed.sh"
run_test "D51 Phase B workspaces (B01)" "$SCRIPT_DIR/test-workspace.sh"
run_test "train-cycle.sh release captain: train, promote, release, locks, dry-run (RC-AUTO)" "$SCRIPT_DIR/test-train-cycle.sh"
run_test "Python shutdown SIGABRT with piped output (PY-ABORT)" "$SCRIPT_DIR/test-py-shutdown-abort.sh"
run_test "audit.py verify exits 2 when it checked nothing (PO-AUDIT-CLI-1)" "timeout -k 10 120 python3 -m pytest -q $SCRIPT_DIR/dashboard/test_audit_verify_cli_nothing_checked.py"
run_test "skill-session status push sends null running_agents (S-222)" "timeout -k 10 120 python3 -m pytest -q -p no:cacheprovider $SCRIPT_DIR/dashboard/test_skill_session_ws_running_agents.py"
run_test "notification triggers unreadable is not empty (PO-DASH-HONEST-1)" "timeout -k 10 120 python3 -m pytest -q -p no:cacheprovider $SCRIPT_DIR/dashboard/test_notification_triggers_unreadable.py"
run_test "notification triggers panel unreadable vs empty (node --test, PO-DASH-HONEST-1)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; timeout -k 10 120 node --test $SCRIPT_DIR/../dashboard-ui/tests/loki-notification-triggers-error.node.test.mjs"
run_test "corrupt or denied proofs and memory files give 503 or an error row, never empty (HONEST-READ-1)" "timeout -k 10 120 python3 -m pytest -q -p no:cacheprovider $SCRIPT_DIR/dashboard/test_unreadable_not_empty.py"
run_test "Stats unmeasured cost reads unmeasured (S-226r)" "timeout -k 10 120 bash $SCRIPT_DIR/test-stats-unmeasured-cost.sh"
run_test "Status budget unmeasured reads unmeasured (S-226r)" "timeout -k 10 120 bash $SCRIPT_DIR/test-status-budget-unmeasured.sh"
run_test "verify readers ignore a planted json.py in the reviewed tree (-I -S, S-216)" "timeout -k 10 120 bash $SCRIPT_DIR/test-verify-no-cwd-shadow.sh"
run_test "start page workspace runs card (node --test, D51-B14r)" "command -v node >/dev/null 2>&1 || { echo 'node not installed: the suite did not run (unmeasured, not clean)'; exit 1; }; timeout -k 10 120 node --test $SCRIPT_DIR/../dashboard-ui/tests/start-workspace-card.node.test.mjs"
run_test "Untracked status ignores core.fsmonitor (S-218r)" "timeout -k 10 120 bash $SCRIPT_DIR/test-untracked-status-fsmonitor.sh"
run_test "install-hooks.sh --help and unknown args never write git config (PO5)" "timeout -k 10 120 bash $SCRIPT_DIR/test-install-hooks.sh"
run_test "loki hub install (manifest fetch and verify)" "timeout -k 10 120 bash $SCRIPT_DIR/cli/test-hub-install.sh"
run_test "Whole-tree no dash or emoji codepoint guard (PO5-DASH-BENCH)" "timeout -k 10 120 bash $SCRIPT_DIR/test-no-dashes-tree.sh"
run_test "loki start repo directory routes as repository target (PO4)" "timeout -k 10 120 bash $SCRIPT_DIR/cli/test-start-repo-directory.sh"
run_test "loki wiki command (build, ask, grounded citation)" "timeout -k 10 120 bash $SCRIPT_DIR/cli/test-wiki-command.sh"
run_test "issue-to-PR flow (--prepare-pr, issue-mode)" "timeout -k 10 120 bash $SCRIPT_DIR/cli/test-issue-to-pr.sh"
run_test "dogfood-stats honest labeling and flags (PO5)" "timeout -k 10 120 bash $SCRIPT_DIR/test-dogfood-stats.sh"
run_test "loki status empty state files (cli)" "timeout -k 10 120 bash $SCRIPT_DIR/cli/test_status_empty_state.sh"
run_test "loki start stale PID cleanup (cli)" "timeout -k 10 120 bash $SCRIPT_DIR/cli/test_stale_pid_cleanup.sh"
run_test "loki start/run unified dispatch (cli)" "timeout -k 10 120 bash $SCRIPT_DIR/cli/test_start_run_unified.sh"
run_test "non-standard suite registration guard (cli, dashboard, integration)" "timeout -k 10 120 bash $SCRIPT_DIR/test-registration-nonstandard.sh"
run_test "measure-run and guard-changed help is read-only (PO5)" "timeout -k 10 120 bash $SCRIPT_DIR/test-help-readonly-scripts.sh"
run_test "mobile emulator tests: NOT VERIFIED without a device" "timeout -k 10 120 bash $SCRIPT_DIR/test-mobile-verify.sh"
run_test "ShellCheck Linting" "$SCRIPT_DIR/run-shellcheck.sh"

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                     TEST SUITE SUMMARY                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Tests Run:    ${TESTS_RUN}"
echo -e "${GREEN}Passed:       ${TOTAL_PASSED}${NC}"
echo -e "${RED}Failed:       ${TOTAL_FAILED}${NC}"
echo -e "${YELLOW}Quarantined:  ${TOTAL_QUARANTINED}${NC}"
echo ""

if [ -n "$QUARANTINED_SUITES" ]; then
    echo -e "${YELLOW}Quarantined (ran, failed, reported but did not block -- see tests/quarantine.txt):${NC}"
    echo -e "${YELLOW}${QUARANTINED_SUITES}${NC}"
fi

if [ -n "$TIMED_OUT_SUITES" ]; then
    echo -e "${RED}Timed out (killed by the per-suite watchdog, not a normal failure):${NC}"
    echo -e "${RED}${TIMED_OUT_SUITES}${NC}"
fi

if [ $TOTAL_FAILED -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              ALL TESTS PASSED SUCCESSFULLY!                    ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    exit 0
else
    echo -e "${RED}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║              SOME TESTS FAILED - PLEASE REVIEW                 ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════════╝${NC}"
    exit 1
fi
