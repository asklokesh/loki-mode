#!/usr/bin/env bash
# Syntax gate: bash -n on every shipped shell script, ast parse on every shipped
# Python module, node --check on the JS entrypoints, bash -n on the completions.
# Python is parsed with ast (not py_compile) so no __pycache__ is written into the tree.
#
# Planted defect used to prove this test can fail: append the line `if then fi`
# to providers/claude.sh (bash -n must name it), and separately append `def (:`
# to dashboard/__init__.py (the Python parse must name it). Both reverted with
# git checkout after the proof.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need python3
need node
cd "$ROOT" || exit 2

echo "TEST: syntax of shipped shell, Python and JS"

sh_list="$T/sh.list"
{
    ls autonomy/*.sh autonomy/loki autonomy/lib/*.sh providers/*.sh bin/loki scripts/*.sh \
        tests/*.sh tests/min/*.sh claude/hooks/*.sh .github/actions/*/check.sh \
        plugins/loki-mode/scripts/*.sh completions/loki.bash .githooks/pre-push .githooks/pre-commit 2>/dev/null
} | sort -u > "$sh_list"

n=0; badlist=""
while IFS= read -r f; do
    n=$((n + 1))
    bash -n "$f" 2>"$T/err" || badlist="$badlist $f"
done < "$sh_list"
[ "$n" -gt 40 ] && ok "bash -n covers $n shell files" || bad "only $n shell files found (expected more than 40)"
[ -z "$badlist" ] && ok "bash -n clean" || bad "bash -n failed:$badlist"

py_list="$T/py.list"
ls dashboard/*.py mcp/*.py memory/*.py autonomy/*.py autonomy/lib/*.py web-app/*.py tools/*.py \
    api/*.py events/*.py learning/*.py magic/*.py state/*.py 2>/dev/null | sort -u > "$py_list"
py_out="$(python3 -I - "$py_list" <<'PY' 2>&1
import ast, sys
bad = []
files = [l.strip() for l in open(sys.argv[1]) if l.strip()]
for f in files:
    try:
        ast.parse(open(f, encoding="utf-8").read(), f)
    except SyntaxError as e:
        bad.append("%s:%s" % (f, e.lineno))
print("N=%d" % len(files))
print("BAD=" + " ".join(bad))
PY
)"
py_n="$(printf '%s\n' "$py_out" | sed -n 's/^N=//p')"
py_bad="$(printf '%s\n' "$py_out" | sed -n 's/^BAD=//p')"
[ "${py_n:-0}" -gt 100 ] && ok "python parse covers $py_n files" || bad "only ${py_n:-0} python files found"
[ -z "$py_bad" ] && ok "python parse clean" || bad "python syntax errors: $py_bad"

for j in bin/loki-mode.js bin/loki-postinstall.js; do
    check "node --check $j" node --check "$j"
done

finish
