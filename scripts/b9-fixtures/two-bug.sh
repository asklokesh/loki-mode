#!/usr/bin/env bash
# scripts/b9-fixtures/two-bug.sh <dir> -- a one-file repo with two independent bugs (sum() skips the first
# element, max() starts from 0 so all-negative input is wrong). Three tracked files, one commit.
# Task used with it: "sum() skips the first element and max() is wrong for negative numbers; fix both".
set -euo pipefail
[ $# -ge 1 ] && [ -n "$1" ] || { echo "usage: $0 <dir>" >&2; exit 2; }
if [ -e "$1" ] && { [ ! -d "$1" ] || [ -n "$(ls -A "$1")" ]; }; then
    echo "two-bug: refusing non-empty existing path: $1" >&2
    exit 2
fi
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
mkdir -p "$1" && cd "$1" && git init -q
printf '{"name":"r","version":"1.0.0","scripts":{"test":"node --test"}}' > package.json
printf 'function sum(xs){let t=0;for(let i=1;i<xs.length;i++)t+=xs[i];return t}\nfunction max(xs){let m=0;for(const x of xs)if(x>m)m=x;return m}\nmodule.exports={sum,max}\n' > lib.js
printf "const t=require('node:test');const a=require('node:assert');const {sum,max}=require('./lib');t('sum',()=>a.strictEqual(sum([1,2,3]),6));t('max',()=>a.strictEqual(max([-3,-1,-2]),-1));\n" > lib.test.js
git add package.json lib.js lib.test.js && git -c user.name=d -c user.email=d@e.x commit -qm i
