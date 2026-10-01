#!/usr/bin/env bash
# E-165 guard: no test may run `loki start` (bare, "$LOKI", bin/loki,
# autonomy/loki) or $ROOT/autonomy/run.sh with the repo root as cwd. Incident:
# test-mirofish-integration.sh launched a live autonomous build in the repo
# root. An invocation is allowed only when the NEAREST preceding `cd` (within
# 60 lines) targets a directory created by mktemp (a variable assigned from
# mktemp, or built from one). A `cd` to the repo root / SCRIPT_DIR/.. / any
# other path is not a fixture. A `# start-guard-allow: <reason>` comment
# exempts ONLY the single line directly below it. --help, comments and text
# lines (echo/printf/log/grep) are skipped.
# Usage: test-no-start-against-repo-root.sh [file ...]   (default: tests/*.sh)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

scan() {
    awk '
    # Join backslash continuations so a multi-line command is one logical line.
    { if (cont) { line[n] = line[n] " " $0 } else { line[++n] = $0 }
      cont = ($0 ~ /\\[ \t]*$/); if (cont) sub(/\\[ \t]*$/, "", line[n]) }
    END {
        NR = n
        # Pass 1: variables created by mktemp, then variables built from them.
        for (i = 1; i <= NR; i++) if (line[i] ~ /^[ \t]*loki_run_tmp_create( |$)/) safe["LOKI_RUN_TMP"] = 1
        for (pass = 0; pass < 3; pass++)
            for (i = 1; i <= NR; i++) {
                if (match(line[i], /^[ \t]*(local +|export +|readonly +)?[A-Za-z_][A-Za-z0-9_]*=/)) {
                    v = substr(line[i], RSTART, RLENGTH); sub(/^[ \t]*(local +|export +|readonly +)?/, "", v); sub(/=$/, "", v)
                    rhs = substr(line[i], RSTART + RLENGTH)
                    if (rhs ~ /mktemp/) safe[v] = 1
                    else for (s in safe) if (index(rhs, "$" s) || index(rhs, "${" s "}")) safe[v] = 1
                }
            }
        for (i = 1; i <= NR; i++) {
            l = line[i]
            if (l ~ /^[ \t]*#/ || l ~ /--help/ || l ~ /(echo|printf|log_[a-z_]*|run_test|pass|ok|bad|grep|probe_case)[ (]/) continue
            isstart = (l ~ /(^|[^A-Za-z0-9_.\/-])(loki|"?\$LOKI"?|"?\$\{LOKI\}"?|[^ ]*\/bin\/loki"?|[^ ]*\/autonomy\/loki"?|bin\/loki|autonomy\/loki) +start( |$)/) \
                || (l ~ /(bash|exec|sh) +"?[^ ]*(PROJECT_ROOT|REPO_ROOT|ROOT_DIR|SCRIPT_DIR\/\.\.)[^ ]*\/run\.sh/)
            if (!isstart) continue
            if (i > 1 && line[i-1] ~ /^[ \t]*# start-guard-allow: ./) continue
            ok = 0
            for (j = i; j >= 1 && j >= i - 60; j--) {
                cl = line[j]; if (j == i) cl = substr(cl, 1, match(cl, /( start( |$)|run\.sh)/))
                if (cl ~ /(^|[ ;(&{])cd +[^ ]/) {
                    t = cl; sub(/.*(^|[ ;(&{])cd +/, "", t)
                    gsub(/["{}]/, "", t); sub(/[ ;).&|].*/, "", t)
                    if (t ~ /^\$/) { sub(/^\$/, "", t); sub(/\/.*/, "", t); if (t in safe) ok = 1 }
                    break
                }
            }
            if (!ok) printf "%d:%s\n", i, l
        }
    }' "$1"
}

if [ "${1:-}" = "--scan" ]; then scan "$2"; exit 0; fi

# Negative fixtures: every form must be flagged; positive forms must pass.
MUT="$(mktemp -d "$(cd "${TMPDIR:-/tmp}" && pwd -P)/loki-run.XXXXXXXX")" || exit 1
trap 'rm -rf "$MUT"' EXIT
FAILS=0
expect() { # name want(flag|clean) body
    printf '%s\n' "$3" > "$MUT/case.sh"
    local out; out="$(scan "$MUT/case.sh")"
    if { [ "$2" = flag ] && [ -n "$out" ]; } || { [ "$2" = clean ] && [ -z "$out" ]; }; then return 0; fi
    echo "SELFTEST FAIL: $1 (wanted $2, got: ${out:-nothing})"; FAILS=$((FAILS + 1))
}
expect root-var-bin   flag 'bash "$PROJECT_ROOT/bin/loki" start x'
expect dollar-LOKI    flag '"$LOKI" start x'
expect bare-bin-loki  flag 'bin/loki start x'
expect bare-loki      flag 'loki start x'
expect cd-repo-root   flag $'cd "$REPO_ROOT"\n"$LOKI" start x'
expect cd-script-up   flag $'cd "$SCRIPT_DIR/.."\nloki start x'
expect cd-nonmktemp   flag $'D=/tmp/x\ncd "$D"\nloki start x'
expect fixture-after-root-cd flag $'FX=$(mktemp -d)\ncd "$FX"\ncd "$REPO_ROOT"\nloki start x'
expect allow-two-lines-up flag $'# start-guard-allow: why\n\nloki start x'
expect fixture-cd     clean $'FX=$(mktemp -d)\n( cd "$FX" || exit 1; loki start x )'
expect derived-fixture clean $'S=$(mktemp -d)\nFX="$S/fx"\ncd "$FX"\n"$LOKI" start x'
expect allow-next-line clean $'# start-guard-allow: why\nloki start x'
expect help-text      clean 'loki start --help'
if [ "$FAILS" -gt 0 ]; then echo "FAIL: guard self-test ($FAILS)"; exit 1; fi

if [ "$#" -gt 0 ]; then FILES=("$@"); else FILES=("$HERE"/*.sh); fi
BAD=0
for f in "${FILES[@]}"; do
    [ "$(basename "$f")" = "test-no-start-against-repo-root.sh" ] && continue
    out="$(scan "$f")"
    if [ -n "$out" ]; then
        BAD=$((BAD + 1))
        while IFS= read -r row; do echo "OFFENDER: $f:$row"; done <<<"$out"
    fi
done
if [ "$BAD" -gt 0 ]; then echo "FAIL: $BAD file(s) start a build against the repo root"; exit 1; fi
echo "PASS: no test starts a build against the repo root"
