#!/usr/bin/env bash
# Every shipped entrypoint answers, offline, with the same version as VERSION:
# bin/loki, the committed Bun bundle, the bash CLI, the npm launcher; plus
# `loki --help`, `loki doctor --json` (valid JSON, same version), `loki mcp --help`
# and the bash completion file loading.
#
# CLI surface (registry truth): loki-ts/src/cli/registry.ts is the one source. Exactly 11 commands are
# visible (start chat status verify receipt stop undo deploy doctor config control), no command or alias
# name is declared twice, every FOLD and REMOVED entry names its replacement, `loki --help` rows, the
# `help all` hidden and renamed lists, completions/loki.bash, completions/_loki and the generated completion
# tree all equal the registry, each of the 11 answers --help with exit 0, and hidden commands still run.
#
# Planted defects used to prove this test can fail (each committed first, then reverted by file):
#   1. in loki-ts/dist/loki.js change the embedded version string to the previous release (a stale
#      bundle); the `bun loki-ts/dist/loki.js version` case must fail.
#   2. registry.ts: cmd("quick", "HIDE" ...) back to "KEEP": the 11-visible and the help, completion
#      and help-all list checks fail.
#   3. help-core.sh: add a `plan` row to help_core_commands: the help-rows check fails.
#   4. registry.ts: a second cmd("intent", ...) entry: the duplicate-name check fails.
#   5. registry.ts: drop migrate from one FOLD entry: the replacement check fails.
#   6. completions/loki.bash: add quick to main_commands: the bash completion check fails.
#   7. completions/_loki: add a 'plan:...' row to _loki_commands: the zsh completion check fails.
#   8. autonomy/loki show_help_all: add a `quick` line to the hidden list: the help-all hidden check fails.
#   9. bin/loki: make `plan` exit 2 (hidden command removed early): the hidden-commands-still-run check fails.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need node
need python3
cd "$ROOT" || exit 2

echo "TEST: CLI entrypoints (offline, hermetic HOME)"

# Pin the shipped bundle: a dev checkout would otherwise prefer loki-ts/src when it is newer.
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
want="Loki Mode v$VERSION_NOW"

if command -v timeout >/dev/null 2>&1; then run() { timeout 60 "$@" 2>&1; }; else run() { "$@" 2>&1; }; fi

has "bin/loki --version" "$(run bin/loki --version)" "$want"
has "bun loki-ts/dist/loki.js version" "$(run bun loki-ts/dist/loki.js version)" "$want"
has "bash autonomy/loki --version" "$(run bash autonomy/loki --version)" "$want"
has "node bin/loki-mode.js --version" "$(run node bin/loki-mode.js --version)" "$want"

help_out="$(run bin/loki --help)"
has "loki --help prints the versioned title" "$help_out" "$want"
has "loki --help lists start" "$help_out" "start"

doc_out="$(run bin/loki doctor --json)"
doc_ver="$(printf '%s' "$doc_out" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["loki_mode_version"])' 2>/dev/null)"
[ "$doc_ver" = "$VERSION_NOW" ] && ok "loki doctor --json is valid JSON at $VERSION_NOW" || bad "doctor --json version '$doc_ver' (want $VERSION_NOW)"

has "loki mcp --help" "$(run bin/loki mcp --help)" "Usage: loki mcp"

# ---- CLI surface: registry is the source ----
CORE="start chat status verify receipt stop undo deploy doctor config control"
words() { tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' '; }
rb() { (cd "$ROOT/loki-ts" && bun -e "$1" 2>&1); }
reg_visible="$(rb 'import { visibleCommands } from "./src/cli/registry.ts"; console.log(visibleCommands().map((c) => c.name).join(" "))')"
[ "$reg_visible" = "$CORE" ] && ok "registry: exactly the 11 core commands are visible, in front-page order" || bad "registry visible commands: '$reg_visible' (want: $CORE)"
reg_dups="$(rb 'import { REGISTRY, allNames } from "./src/cli/registry.ts"; const n = REGISTRY.flatMap((c) => allNames(c)); console.log([...new Set(n.filter((x, i) => n.indexOf(x) !== i))].join(" "))')"
[ -z "$reg_dups" ] && ok "registry: no command or alias name is declared twice" || bad "registry duplicate names: $reg_dups"
reg_bad="$(rb 'import { REGISTRY } from "./src/cli/registry.ts"; const ok = ["KEEP", "HIDE", "FOLD", "REMOVED"]; console.log(REGISTRY.filter((c) => !ok.includes(c.cls ?? "") || ((c.cls === "FOLD" || c.cls === "REMOVED") && !c.migrate) || ((c.cls === "KEEP" || c.cls === "HIDE") && c.migrate)).map((c) => c.name).join(" "))')"
[ -z "$reg_bad" ] && ok "registry: every entry has a class; FOLD and REMOVED name a replacement" || bad "registry entries with a bad class or replacement: $reg_bad"
reg_hide="$(rb 'import { REGISTRY } from "./src/cli/registry.ts"; console.log(REGISTRY.filter((c) => c.cls === "HIDE" && !["help", "version", "internal", "completion", "__complete"].includes(c.name)).map((c) => c.name).join(" "))' | words)"
reg_fold="$(rb 'import { REGISTRY } from "./src/cli/registry.ts"; console.log(REGISTRY.filter((c) => c.cls === "FOLD").map((c) => c.name).join(" "))' | words)"
reg_tree="$(rb 'import { completionTree } from "./src/cli/completions.ts"; console.log(completionTree().children.map((c) => c.names[0]).join(" "))' | words)"
core_sorted="$(printf '%s' "$CORE" | words)"
help_rows="$(printf '%s\n' "$help_out" | awk '/^  [a-z]/ && $1 != "loki" { print $1 }' | words)"
[ "$help_rows" = "$core_sorted" ] && ok "loki --help rows are exactly the 11 core commands" || bad "loki --help rows: '$help_rows' (want: $core_sorted)"
all_out="$(run bin/loki help all)"
all_core="$(printf '%s\n' "$all_out" | sed -n '1,/^Integration and maintenance/p' | awk '/^  [a-z]/ && $1 != "loki" { print $1 }' | words)"
all_hide="$(printf '%s\n' "$all_out" | sed -n '/^Integration and maintenance/,/^Renamed/p' | sed '1d;$d' | words)"
all_fold="$(printf '%s\n' "$all_out" | awk '/^  [a-z][a-z0-9-]* +->/ { print $1 }' | words)"
[ "$all_core" = "$core_sorted" ] && ok "loki help all starts with the same 11" || bad "loki help all core rows: '$all_core'"
[ "$all_hide" = "$reg_hide" ] && ok "loki help all hidden list equals the registry HIDE class" || bad "help all hidden list differs from registry HIDE: '$all_hide' vs '$reg_hide'"
[ "$all_fold" = "$reg_fold" ] && ok "loki help all renamed list equals the registry FOLD class" || bad "help all renamed list differs from registry FOLD: '$all_fold' vs '$reg_fold'"
case "$help_out$all_out" in *"review queue"*) bad "help lists a review queue command (it is a section of loki status, not a command)" ;; *) ok "help does not list a review queue command" ;; esac
bash_words="$(sed -n 's/^    local main_commands="\(.*\)"$/\1/p' "$ROOT/completions/loki.bash" | words)"
[ "$bash_words" = "$core_sorted" ] && ok "completions/loki.bash top-level words are the 11" || bad "completions/loki.bash top-level words: '$bash_words'"
zsh_words="$(sed -n '/^function _loki_commands/,/^}/p' "$ROOT/completions/_loki" | sed -n "s/^        '\([a-z0-9-]*\):.*/\1/p" | words)"
[ "$zsh_words" = "$core_sorted" ] && ok "completions/_loki top-level words are the 11" || bad "completions/_loki top-level words: '$zsh_words'"
[ "$reg_tree" = "$core_sorted" ] && ok "generated completion tree top-level words are the 11" || bad "generated completion tree: '$reg_tree'"
for c in $CORE; do
    run bin/loki "$c" --help >/dev/null; rc=$?
    [ "$rc" -eq 0 ] && ok "loki $c --help exits 0" || bad "loki $c --help exited $rc"
done
for c in quick plan proof resume steer review trigger merge workspace magic test cost explain ship backlog; do
    run bin/loki "$c" --help >/dev/null; rc=$?
    [ "$rc" -eq 0 ] && ok "hidden loki $c --help still runs" || bad "hidden loki $c --help exited $rc"
done

check "completions/loki.bash loads" bash -c "source '$ROOT/completions/loki.bash'"

finish
