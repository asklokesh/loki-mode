#!/usr/bin/env bash
# `loki doctor --fix` and the 2 second doctor budget, on BOTH routes
# (bash autonomy/loki via LOKI_LEGACY_BASH=1, and the Bun route).
#
# --fix only ever ADDS state: it creates a missing receipt signing key and
# prints the provider-select command. It must never overwrite an existing key.
# The speed half stubs every provider CLI (instant) and plants slow python
# packages named mcp / numpy / sentence_transformers in the cwd: a real
# `import` of any of them sleeps 15s, so doctor only finishes fast when the
# Integrations probes use find_spec instead of importing.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LOKI_NO_BROWSER=1
T="$(mktemp -d "$(cd "${TMPDIR:-/tmp}" && pwd -P)/loki-run.XXXXXXXX")"
trap 'rm -rf "$T"' EXIT

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Key creation on the bash route needs python cryptography (the Bun route uses
# node crypto). Without it the key assertions are skipped by name, not failed.
HAVE_CRYPTO=1
python3 -c 'import cryptography' 2>/dev/null || HAVE_CRYPTO=0

mkdir -p "$T/bin" "$T/slow"
for p in claude codex cline aider opencode; do
    printf '#!/bin/sh\necho 1.0.0\n' >"$T/bin/$p"
    chmod +x "$T/bin/$p"
done
# Minimal PATH (as test-doctor-blocker-parity.sh): the host's own PATH may carry
# several loki installs, which doctor correctly reports as a blocker.
for b in bash sh python3 python sed awk grep cat tr head tail sort uniq wc \
         date mkdir rm ls printf env dirname basename cut find xargs stat \
         node jq git curl df uname bun id tput mktemp sleep kill; do
    _src="$(command -v "$b" 2>/dev/null)"
    [ -n "$_src" ] && ln -sf "$_src" "$T/bin/$b" 2>/dev/null
done
for m in mcp numpy sentence_transformers; do
    mkdir -p "$T/slow/$m"
    printf 'import time\ntime.sleep(15)\n' >"$T/slow/$m/__init__.py"
done

# run_doctor <route> <home> [args...]: stdout to $T/out, rc in $RC, seconds in $SECS
run_doctor() {
    local route="$1" home="$2" s e
    shift 2
    local -a pre=(env HOME="$home" PATH="$T/bin" ANTHROPIC_API_KEY=stub-not-a-real-key)
    [ "$route" = bash ] && pre+=(LOKI_LEGACY_BASH=1)
    s=$(python3 -c 'import time; print(time.time())')
    (cd "$T/slow" && "${pre[@]}" "$REPO_ROOT/bin/loki" doctor "$@" >"$T/out" 2>"$T/err")
    RC=$?
    e=$(python3 -c 'import time; print(time.time())')
    SECS=$(python3 -c "print(round($e - $s, 2))")
}

NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 1)"
LOAD1="$(uptime | sed 's/.*load averages*: *//' | awk '{print $1}' | tr -d ',')"
KEY=".loki/keys/receipt-ed25519.pem"
for route in bash bun; do
    H="$T/home-$route"
    mkdir -p "$H"

    if [ "$HAVE_CRYPTO" = 1 ]; then
        run_doctor "$route" "$H" --fix
        if [ -f "$H/$KEY" ] && grep -q "FIXED  receipt signing key created" "$T/out"; then
            ok "$route: --fix creates a missing key"
        else
            bad "$route: --fix did not create the key"
        fi
        if [ "$RC" -eq 0 ] && tail -1 "$T/out" | grep -q '^Ready: .*receipts signed'; then
            ok "$route: --fix ends with Ready (rc 0)"
        else
            bad "$route: --fix did not end Ready (rc=$RC): $(tail -1 "$T/out")"
        fi

        before="$(cksum <"$H/$KEY" 2>/dev/null)"
        run_doctor "$route" "$H" --fix
        after="$(cksum <"$H/$KEY" 2>/dev/null)"
        if [ -n "$before" ] && [ "$before" = "$after" ] && grep -q "OK     receipt signing key present" "$T/out"; then
            ok "$route: an existing key is untouched"
        else
            bad "$route: existing key changed or not reported"
        fi
    else
        printf "SKIP: %s key assertions (python cryptography not installed)\n" "$route"
    fi

    best=999
    for _ in 1 2 3 4 5; do
        run_doctor "$route" "$H"
        awk -v a="$SECS" -v b="$best" 'BEGIN{exit !(a<b)}' && best="$SECS"
        awk -v a="$best" 'BEGIN{exit !(a<2)}' && break
    done
    if ! grep -q "PASS.*sentence-transformers (embeddings)" "$T/out"; then
        bad "$route: lost the sentence-transformers integration check"
    elif awk -v a="$best" 'BEGIN{exit !(a<2)}'; then
        ok "$route: doctor under 2s with stubbed providers (best of 5: ${best}s)"
    elif awk -v a="$best" -v l="$LOAD1" -v c="$NCPU" 'BEGIN{exit !(a<10 && l>c)}'; then
        # A real import would take 15s+; under 10s proves find_spec. The 2s bound
        # itself is only meaningful on an unsaturated host, so it is skipped there.
        printf 'SKIP: %s 2s bound (host load %s > %s cpus); %ss is still well under a real import\n' "$route" "$LOAD1" "$NCPU" "$best"
    else
        bad "$route: doctor too slow (best of 5: ${best}s, load $LOAD1)"
    fi
done

# Parity: the Fix block and last line match across routes on the same fresh HOME path.
P="$T/home-parity"
if [ "$HAVE_CRYPTO" = 1 ]; then
for route in bash bun; do
    rm -rf "$P"; mkdir -p "$P"
    run_doctor "$route" "$P" --fix
    { sed -n '1,/^$/p' "$T/out"; tail -1 "$T/out" | sed 's/(kid [^)]*)/(kid X)/'; } >"$T/parity-$route"
done
if cmp -s "$T/parity-bash" "$T/parity-bun" && [ -s "$T/parity-bash" ]; then
    ok "bash/bun parity on --fix"
else
    bad "bash/bun --fix output differs"
    diff "$T/parity-bash" "$T/parity-bun" | head
fi
else
    printf "SKIP: parity (python cryptography not installed)\n"
fi

# --fix with --json is refused, not silently ignored.
run_doctor bash "$P" --fix --json
if [ "$RC" -ne 0 ]; then ok "--fix --json refused"; else bad "--fix --json accepted"; fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
