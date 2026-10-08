#!/usr/bin/env bash
# scripts/b9-fixtures/trivial-sum.sh <dir> -- the B9 trivial fixture: a one-file repo whose sum()
# skips the first element, so `node --test` fails until it is fixed. Three tracked files, one commit.
# Task used with it: "sum() skips the first element; fix it" (loki start; no PR unless --pr).
set -euo pipefail
[ $# -ge 1 ] && [ -n "$1" ] || { echo "usage: $0 <dir>" >&2; exit 2; }
if [ -e "$1" ] && { [ ! -d "$1" ] || [ -n "$(ls -A "$1")" ]; }; then
    echo "trivial-sum: refusing non-empty existing path: $1" >&2
    exit 2
fi
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
mkdir -p "$1" && cd "$1" && git init -q
printf '{"name":"r","version":"1.0.0","scripts":{"test":"node --test"}}' > package.json
printf 'function sum(xs){let t=0;for(let i=1;i<xs.length;i++)t+=xs[i];return t}\nmodule.exports={sum}\n' > sum.js
printf "const t=require('node:test');const a=require('node:assert');const {sum}=require('./sum');t('adds',()=>a.strictEqual(sum([1,2,3]),6));\n" > sum.test.js
git add package.json sum.js sum.test.js && git -c user.name=d -c user.email=d@e.x commit -qm i
