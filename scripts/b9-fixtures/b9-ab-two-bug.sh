#!/usr/bin/env bash
# scripts/b9-fixtures/two-bug.sh <dir> [hidden-dir] -- the B9 two-bug fixture: stats.js has mean() dividing by
# length-1 and max() seeded with 0 (wrong for all-negative input). The visible test covers one case of each.
# With hidden-dir, also writes hidden.test.js there: the extra cases (empty input, negatives) the scoreboard
# copies in AFTER the arm finished, so an arm cannot see or overfit them.
# Task used with it: "mean() and max() in stats.js return wrong results; fix both".
set -euo pipefail
[ $# -ge 1 ] && [ -n "$1" ] || { echo "usage: $0 <dir> [hidden-dir]" >&2; exit 2; }
if [ -e "$1" ] && { [ ! -d "$1" ] || [ -n "$(ls -A "$1")" ]; }; then
    echo "two-bug: refusing non-empty existing path: $1" >&2
    exit 2
fi
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
mkdir -p "$1" && cd "$1" && git init -q
printf '{"name":"r","version":"1.0.0","scripts":{"test":"node --test"}}' > package.json
printf 'function mean(xs){let t=0;for(const x of xs)t+=x;return t/(xs.length-1)}\nfunction max(xs){let m=0;for(const x of xs)if(x>m)m=x;return m}\nmodule.exports={mean,max}\n' > stats.js
printf "const t=require('node:test');const a=require('node:assert');const {mean,max}=require('./stats');\nt('mean',()=>a.strictEqual(mean([2,4,6]),4));\nt('max',()=>a.strictEqual(max([-5,-2,-9]),-2));\n" > stats.test.js
git add package.json stats.js stats.test.js && git -c user.name=d -c user.email=d@e.x commit -qm i
if [ $# -ge 2 ] && [ -n "$2" ]; then
    mkdir -p "$2"
    printf "const t=require('node:test');const a=require('node:assert');const {mean,max}=require('./stats');\nt('mean single',()=>a.strictEqual(mean([5]),5));\nt('mean fractions',()=>a.strictEqual(mean([1,2]),1.5));\nt('max mixed',()=>a.strictEqual(max([-1,3,2]),3));\nt('max single negative',()=>a.strictEqual(max([-7]),-7));\n" > "$2/hidden.test.js"
fi
