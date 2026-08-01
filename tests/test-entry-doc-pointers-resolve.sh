#!/usr/bin/env bash
# Every repo path the entry documents cite must actually exist.
#
# CLAUDE.md is loaded into the context of every agent that works on this
# repository, and SKILL.md is the skill's own front page. A path in either that
# does not resolve sends the reader somewhere that is not there.
#
# The case that prompted this: CLAUDE.md pointed at
# .claude/projects/-Users-lokesh-git-loki-mode/memory/CODEBASE-KNOWLEDGE-GRAPH.md
# -- a machine-local Claude memory path, under a previous repo name, neither
# tracked in git nor shipped in the npm package. It resolved on exactly one
# machine and was a dead end for every other reader, including every agent that
# loaded CLAUDE.md and went looking.
#
# SCOPE, deliberately narrow. Only paths that look like REPO paths are checked:
#   - .loki/... is runtime state that does not exist at rest
#   - bare filenames (run.sh, index.json) are prose references, not links
#   - ~ and http are external
# A checker that flagged those would be noise, and a noisy checker gets muted,
# which is worse than no checker.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: entry-document pointers resolve"

report="$(python3 - "$REPO_ROOT" <<'PY'
import os, re, sys

root = sys.argv[1]
broken = []
checked = 0

sources = ["CLAUDE.md", "SKILL.md"]
skills_dir = os.path.join(root, "skills")
if os.path.isdir(skills_dir):
    sources += [os.path.join("skills", f)
                for f in sorted(os.listdir(skills_dir)) if f.endswith(".md")]

for src in sources:
    path = os.path.join(root, src)
    if not os.path.exists(path):
        continue
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    # Strip fenced blocks before extracting. skills/compound-learning.md shows
    # an EXAMPLE learning note whose "See also" lines name files that are meant
    # to be illustrative, not real. Flagging those would be a false positive,
    # and a checker that cries wolf gets muted.
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    for ref in sorted(set(re.findall(
            r'`([A-Za-z0-9_./-]+\.(?:md|py|sh|json|ts|js))`', text))):
        # Runtime state, external, and bare prose filenames are out of scope.
        # .claude/mcp.json is the USER's own MCP config and behavioral-baseline/
        # is a heal-mode runtime artifact: both are correctly absent at rest, so
        # flagging them would train a reader to ignore this checker.
        if ref.startswith((".loki/", "http", "~", ".claude/mcp",
                           "behavioral-baseline/")):
            continue
        if "/" not in ref:
            continue
        checked += 1
        if not os.path.exists(os.path.join(root, ref)):
            broken.append("%s -> %s" % (src, ref))

print("CHECKED=%d" % checked)
for item in broken:
    print("BROKEN=%s" % item)
PY
)"

_checked="$(printf '%s\n' "$report" | sed -n 's/^CHECKED=//p')"
_broken="$(printf '%s\n' "$report" | sed -n 's/^BROKEN=//p')"

# The checker must actually be looking at something. A scope bug that examined
# zero paths would report a clean pass forever.
if [[ "${_checked:-0}" -ge 20 ]]; then
    ok "the checker examined ${_checked} repo-path pointers"
else
    ko "the checker examined enough pointers to be meaningful" \
       "only ${_checked:-0} -- the extraction is probably matching nothing"
fi

if [[ -z "$_broken" ]]; then
    ok "every repo-path pointer in CLAUDE.md and SKILL.md resolves"
else
    ko "every repo-path pointer in CLAUDE.md and SKILL.md resolves" \
       "$(printf '%s' "$_broken" | tr '\n' ' ')"
fi

# --- the specific regression -------------------------------------------------
# A machine-local memory path must not be presented as a repo reference.
if grep -q '`\.claude/projects/-Users-' "$REPO_ROOT/CLAUDE.md" 2>/dev/null; then
    ko "no machine-local Claude memory path is cited as a repo reference" \
       "that path resolves on one machine and is a dead end for everyone else"
else
    ok "no machine-local Claude memory path is cited as a repo reference"
fi

# If the knowledge graph is still mentioned, it must say where it really lives,
# rather than being silently deleted and leaving the reader wondering.
if grep -q "CODEBASE-KNOWLEDGE-GRAPH" "$REPO_ROOT/CLAUDE.md" 2>/dev/null; then
    if grep -q "not in this repository" "$REPO_ROOT/CLAUDE.md"; then
        ok "the knowledge graph reference states that it is not in the repo"
    else
        ko "the knowledge graph reference states that it is not in the repo" \
           "a reader will still go looking for a file that is not shipped"
    fi
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
