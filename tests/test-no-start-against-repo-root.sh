#!/usr/bin/env bash
# E-165 guard: no test may run `loki start` / `bin/loki start` / run.sh with the
# repo root as cwd. Incident: test-mirofish-integration.sh launched a live
# autonomous build in the repo root. An invocation is allowed only when a
# fixture `cd` appears within the 60 lines before it (the cd that resolves the
# repo root itself does not count), a `# start-guard-allow: <reason>` comment
# sits within 4 lines above, or the line is --help / a comment / text.
# Usage: test-no-start-against-repo-root.sh [file ...]   (default: tests/*.sh)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -gt 0 ]; then FILES=("$@"); else FILES=("$HERE"/*.sh); fi

scan() {
    awk '
    { line[NR] = $0 }
    END {
        for (i = 1; i <= NR; i++) {
            l = line[i]
            if (l ~ /^[ \t]*#/ || l ~ /--help/ || l ~ /(echo|printf|log_|pass|ok|bad|grep|probe_case)[ (]/) continue
            if (l !~ /(PROJECT_ROOT|REPO_ROOT|ROOT_DIR|SCRIPT_DIR\/\.\.)[^ ]*\/(autonomy|bin)\/loki"? +start/ && l !~ /(bash|exec) +"?[^ ]*(PROJECT_ROOT|REPO_ROOT|ROOT_DIR|SCRIPT_DIR\/\.\.)[^ ]*\/run\.sh/) continue
            safe = 0
            for (j = i - 1; j >= 1 && j >= i - 4; j--) if (line[j] ~ /start-guard-allow:/) safe = 1
            for (j = i - 1; j >= 1 && j >= i - 60; j--) {
                if (line[j] ~ /(^|[ ;(&])cd +[^ ]/ && line[j] !~ /BASH_SOURCE|dirname|\$0|SCRIPT_DIR/) { safe = 1; break }
            }
            if (!safe) printf "%d:%s\n", i, l
        }
    }' "$1"
}

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
