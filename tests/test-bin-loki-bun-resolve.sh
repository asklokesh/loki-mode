#!/usr/bin/env bash
# P0-nobun-S2: bin/loki _loki_bun resolver. Runs a copy of bin/loki in a
# throwaway repo root with a PATH that excludes any real bun; every bun is a stub.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

T="$(mktemp -d "${TMPDIR:-/tmp}/bun-resolve.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT

mkdir -p "$T/root/bin" "$T/root/autonomy" "$T/fakebin" "$T/home" "$T/cwd"
cp "$REPO/bin/loki" "$T/root/bin/loki"
cp "$REPO/autonomy/telemetry.sh" "$T/root/autonomy/telemetry.sh"
printf '#!/usr/bin/env bash\nprintf "BASH %%s\\n" "$*" >"%s/out"\n' "$T" >"$T/root/autonomy/loki"
chmod +x "$T/root/autonomy/loki" "$T/root/bin/loki"
: >"$T/entry.ts"

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
TO=()
[ -n "$TIMEOUT_BIN" ] && TO=("$TIMEOUT_BIN" -k 5 30)

# mkbun <path> <tag> <version-exit-code>: stub that answers --version, else records argv.
mkbun() {
    mkdir -p "$(dirname "$1")"
    printf '#!/usr/bin/env bash\n[ "${1:-}" = "--version" ] && { echo 1.4.2; exit %s; }\nprintf "%s %%s\\n" "$*" >"%s/out"\n' "$3" "$2" "$T" >"$1"
    chmod +x "$1"
}
BUNDLED="$T/root/node_modules/@oven/bun-fake/bin/bun"

run() {
    rm -f "$T/out" "$T/stderr"
    (cd "$T/cwd" && env -i HOME="$T/home" PATH="$T/fakebin:/usr/bin:/bin" LOKI_TELEMETRY_DISABLED=1 \
        LOKI_TS_ENTRY="$T/entry.ts" ${TO[@]+"${TO[@]}"} bash "$T/root/bin/loki" "fix the login bug") >/dev/null 2>"$T/stderr"
    rc=$?
    out="$(cat "$T/out" 2>/dev/null || true)"
}
PLAIN='loki: the Loki 10 engine cannot run on this machine: no working bun (none on PATH, and the bundled bun for'

# (a) bundled bun routes to engine10
mkbun "$BUNDLED" BUNDLED 0
run
case "$out" in "BUNDLED $T/entry.ts engine10 "*) ok "(a) bundled bun routes to engine10" ;; *) bad "(a) got '$out'" ;; esac
grep -q "cannot run on this machine" "$T/stderr" && bad "(a) printed fallback line" || ok "(a) no fallback line"

# (b) bundled bun that crashes
mkbun "$BUNDLED" BUNDLED 132
run
[ -z "$out" ] && [ "$rc" = "1" ] && ok "(b) nothing ran, exit 1" || bad "(b) out='$out' rc=$rc"
head -1 "$T/stderr" | grep -qF "$PLAIN" && head -1 "$T/stderr" | grep -qF "is failed to start, exit 132). To fix: reinstall with npm install -g loki-mode (it includes bun), or install bun from https://bun.sh." \
    && ok "(b) plain line says failed to start, exit 132" || bad "(b) stderr: $(cat "$T/stderr")"

# (c) no candidate
rm -rf "$T/root/node_modules"
run
[ -z "$out" ] && [ "$rc" = "1" ] && ok "(c) nothing ran, exit 1" || bad "(c) out='$out' rc=$rc"
head -1 "$T/stderr" | grep -qF "$PLAIN" && head -1 "$T/stderr" | grep -qE "is missing\)\. To fix: reinstall with npm install -g loki-mode" \
    && ok "(c) plain line says missing" || bad "(c) stderr: $(cat "$T/stderr")"

# (d) PATH bun wins over a bundled one
mkbun "$BUNDLED" BUNDLED 0
mkbun "$T/fakebin/bun" PATHBUN 0
run
case "$out" in "PATHBUN "*) ok "(d) PATH bun takes precedence" ;; *) bad "(d) got '$out'" ;; esac

# (e) postinstall location node_modules/bun/bin/bun.exe works
rm -f "$T/fakebin/bun"; rm -rf "$T/root/node_modules"
mkbun "$T/root/node_modules/bun/bin/bun.exe" EXE 0
run
case "$out" in "EXE $T/entry.ts engine10 "*) ok "(e) bun.exe location routes to engine10" ;; *) bad "(e) got '$out'" ;; esac

# (f) the --ignore-scripts stub (errors, exit 1) is rejected with the plain line
mkdir -p "$T/root/node_modules/bun/bin"
printf '#!/usr/bin/env bash\necho "postinstall script was not run" >&2\nexit 1\n' >"$T/root/node_modules/bun/bin/bun.exe"
run
[ -z "$out" ] && [ "$rc" = "1" ] && ok "(f) stub rejected, nothing ran, exit 1" || bad "(f) out='$out' rc=$rc"
head -1 "$T/stderr" | grep -qF "is failed to start, exit 1)." && ok "(f) plain line names exit 1" || bad "(f) stderr: $(cat "$T/stderr")"

# (g) Windows per-platform package ships bin/bun.exe
rm -rf "$T/root/node_modules"
mkbun "$T/root/node_modules/@oven/bun-windows-x64/bin/bun.exe" WINEXE 0
run
case "$out" in "WINEXE $T/entry.ts engine10 "*) ok "(g) @oven/bun-windows-x64 bun.exe routes to engine10" ;; *) bad "(g) got '$out'" ;; esac

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
