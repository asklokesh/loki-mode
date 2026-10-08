#!/usr/bin/env bash
# shellcheck disable=SC2016  # workflow expressions are literal text, never expanded
# FC-57: a CI job or step must not hide a real failure from the workflow
# conclusion. Nightly run 37780519439 concluded SUCCESS while the pinned
# "Bun tests on macos-latest bun=1.3.13" leg failed, because the job carried a
# job-level `continue-on-error: true`. D90 and release.yml required-ci read the
# workflow conclusion, so they saw green.
#
# Rules, applied to every .github/workflows/*.yml (override dir: WORKFLOW_DIR):
#   R1 no unconditional `continue-on-error: true` on a job or step, except the
#      justified allowlist below (an expression such as
#      `${{ matrix.experimental == true }}` is allowed and is evaluated per
#      matrix leg, see R2).
#   R2 a matrix leg that is allowed to fail must be an `experimental` leg of an
#      unpinned toolchain (bun-version latest); a pinned leg may never be
#      experimental.
#   R3 a step that runs a test command must not mask it with `|| true`.
#   R4 a step that pipes a test command into tee/head/grep must set pipefail
#      (in the script, or via `shell: bash`), else the pipe hides the rc.
#   R5 a job gated by `if: always()` (`!cancelled()` run-gates are fine) is a result aggregator
#      and must be on the reviewed allowlist.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
WFDIR="${1:-${WORKFLOW_DIR:-.github/workflows}}"

echo "test-workflow-no-masked-failures ($WFDIR)"

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import yaml' 2>/dev/null; then
    echo "  FAIL: python3 + PyYAML unavailable: workflows were not measured (unmeasured, not clean)"
    exit 1
fi

python3 -I - "$WFDIR" <<'PY'
import glob, itertools, os, re, sys, yaml

wfdir = sys.argv[1]

# (file, job, step name or None for the job itself) -> justification.
COE_ALLOW = {
    ("test.yml", "version-bump-gate", "Reuse a train run's verdict for this exact SHA"):
        "reuse lookup; a failure means reuse=false and the full suite runs",
    ("security-audit.yml", "train-reuse", "Reuse a train run's verdict for this exact SHA"):
        "reuse lookup; a failure means no reuse and the audit runs in full",
    ("security-audit.yml", "python-audit", "pip-audit every requirements file"):
        "findings reported; the next step asserts a parseable report for every manifest",
    ("release.yml", "publish-docker", "Update Docker Hub description"):
        "cosmetic; the image publish already succeeded and PAT scope can 403",
}
ALWAYS_ALLOW = {
    ("post-release-smoke.yml", "notify"):
        "notifier only; the smoke jobs it reports on fail the run themselves",
}
TEST_CMD = re.compile(
    r"(bun test|npm test|npm run test|pytest|node --test|bash tests/|run-all-tests|"
    r"bun run typecheck|tsc --noEmit|first-run-gate|select-tests)")

fails = []
def fail(msg): fails.append(msg)

def truthy_literal(v):
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")

def legs(matrix):
    """Expand a matrix the way Actions does: cross product, minus excludes, with
    include entries merged into legs whose original keys all match."""
    if not isinstance(matrix, dict):
        return [{}]
    axes = {k: v for k, v in matrix.items() if k not in ("include", "exclude") and isinstance(v, list)}
    base = [dict(zip(axes, c)) for c in itertools.product(*axes.values())] if axes else [{}]
    for ex in matrix.get("exclude") or []:
        base = [l for l in base if not all(l.get(k) == v for k, v in ex.items())]
    out = [dict(l) for l in base]
    for inc in matrix.get("include") or []:
        matched = False
        for l in out:
            if all(l.get(k) == v for k, v in inc.items() if k in axes):
                l.update(inc)
                matched = True
        if not matched:
            out.append(dict(inc))
    return out

COE_EXPR = re.compile(r"\$\{\{\s*matrix\.(\w+)\s*==\s*true\s*\}\}")

def check_coe(where, value, matrix, allow_key):
    """ONE rule for job and step level. absent/false is fine; literal true needs
    the allowlist; any other string must be exactly `matrix.<key> == true` and
    then no pinned leg may have that key true (R2). `${{ true }}`, event-name
    conditions and every other expression are rejected (R1)."""
    if value is None or value is False:
        return
    if truthy_literal(value):
        if allow_key not in COE_ALLOW:
            fail(f"{where}: unconditional continue-on-error: true hides a failure from the run conclusion (R1)")
        return
    if isinstance(value, str) and value.strip().lower() == "false":
        return
    m = COE_EXPR.fullmatch(value.strip()) if isinstance(value, str) else None
    if not m:
        fail(f"{where}: unsupported continue-on-error {value!r}; only matrix.<key> == true is allowed (R1)")
        return
    for leg in legs(matrix):
        if leg.get(m.group(1)) is True and str(leg.get("bun-version")) != "latest":
            fail(f"{where}: pinned leg {leg} is experimental, so its failure would not fail the run (R2)")

# A test command followed by `||` is masked unless the WHOLE handler fails.
# A small shell-aware tokenizer reads quotes (a quoted "exit 1" is one word, not
# a command), comments and operators. The handler is the group after the first
# top-level `||` up to the next `;` or newline (a `{ ... }` group is flattened).
# It is then interpreted as a flat command list tracking the status `$?` would
# hold: `false` -> nonzero; `true`, `:`, echo and any other command -> zero;
# `VAR=$?` copies the current status into VAR; any other assignment overwrites
# it. The handler fails only if it ends nonzero, or runs `exit` with a nonzero
# literal, `exit $?` while the status is still nonzero, or `exit $VAR` while VAR
# still holds the nonzero status. Any further `||`, `&&`, `|`, `&`, subshell,
# nested group or control keyword makes the handler too complex to trust, which
# counts as masked (fail safe). A handler that only captures (`|| rc=$?`) must be
# followed by `exit $rc` with no reassignment in between.
def lex(text):
    toks, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t":
            i += 1
        elif c == "\n":
            toks.append(("op", ";")); i += 1
        elif c == "#":
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("||", i) or text.startswith("&&", i):
            toks.append(("op", text[i:i + 2])); i += 2
        elif c in ";|&()":
            toks.append(("op", c)); i += 1
        else:
            word, kind = "", "plain"
            while i < n and text[i] not in " \t\n;|&" and not (text[i] in "()" and not word):
                ch = text[i]
                if ch == "'":
                    j = text.find("'", i + 1); j = n if j < 0 else j
                    word += text[i + 1:j]; kind = "single"; i = j + 1
                elif ch == '"':
                    j = i + 1
                    while j < n and text[j] != '"':
                        j += 2 if text[j] == "\\" else 1
                    word += text[i + 1:j]; kind = "quoted" if kind == "plain" else kind; i = j + 1
                else:
                    word += ch; i += 1
            toks.append(("word", word, kind))
    return toks

KEYWORDS = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac", "!", "function", "time"}
ASSIGN = re.compile(r"(\w+)=(.*)", re.S)

def var_of(word):
    m = re.fullmatch(r"\$(\w+|\{\w+\})", word)
    return m.group(1).strip("{}") if m else None

def commands(toks):
    out, cur = [], []
    for t in toks:
        if t[0] == "op" and t[1] == ";":
            out.append(cur); cur = []
        else:
            cur.append(t)
    out.append(cur)
    return [c for c in out if c]

def handler_fails(handler):
    """True only when every path through the handler ends nonzero."""
    if handler and handler[0] == ("word", "{", "plain"):
        if handler[-1] != ("word", "}", "plain"):
            return False
        handler = handler[1:-1]
    if not handler or any(t[0] == "op" and t[1] != ";" for t in handler):
        return False
    if any(t[0] == "word" and t[1] in ("{", "}") and t[2] == "plain" for t in handler):
        return False
    last, state = "fail", {}
    for cmd in commands(handler):
        w = [t[1] for t in cmd]
        if w[0] in KEYWORDS or cmd[0][2] != "plain" and w[0] in ("exit", "false"):
            return False
        m = ASSIGN.fullmatch(w[0]) if cmd[0][2] == "plain" else None
        if m and len(w) == 1:
            val = m.group(2)
            if val == "$?" or cmd[0][2] == "quoted" and val == "$?":
                state[m.group(1)] = last
            else:
                state[m.group(1)] = "fail" if re.fullmatch(r"[1-9]\d*", val) else "zero"
            last = "zero"
        elif w[0] == "false" and len(w) == 1:
            last = "fail"
        elif w[0] == "exit":
            if len(w) == 1:
                return last == "fail"
            if len(w) != 2:
                return False
            a = w[1]
            if re.fullmatch(r"[1-9]\d*", a) and cmd[1][2] == "plain":
                return True
            if a == "$?" and cmd[1][2] != "single":
                return last == "fail"
            v = var_of(a) if cmd[1][2] != "single" else None
            return v is not None and state.get(v) == "fail"
        else:
            last = "zero"
    return last == "fail"

def capture_var(handler):
    """VAR for a handler that is exactly `VAR=$?`, else None."""
    if len(handler) == 1 and handler[0][0] == "word" and handler[0][2] != "single":
        m = ASSIGN.fullmatch(handler[0][1])
        if m and m.group(2) == "$?":
            return m.group(1)
    return None

def exits_with(var, after):
    """Next exit in `after` must be `exit $var`, with no earlier write to var."""
    for cmd in commands(lex(after)):
        w = [t for t in cmd if not (t[0] == "word" and t[2] == "plain" and t[1] in ("{", "}", "then", "do", "else"))]
        if any(t[0] == "word" and t[2] == "plain" and re.match(re.escape(var) + r"=", t[1]) for t in w):
            return False
        if w and w[0][0] == "word" and w[0][1] == "exit":
            return len(w) == 2 and w[1][2] != "single" and var_of(w[1][1]) == var
    return False

def masked(lines, i):
    """lines[i] holds a test command; masked when its `||` handler can exit 0."""
    text = lines[i]
    j = i
    while lex(text).count(("word", "{", "plain")) > lex(text).count(("word", "}", "plain")) and j + 1 < len(lines):
        j += 1
        text += "\n" + lines[j]
    toks = lex(text)
    idx = [k for k, t in enumerate(toks) if t == ("op", "||")]
    if not idx:
        return False
    rest = toks[idx[0] + 1:]
    end = len(rest)
    depth = 0
    for k, t in enumerate(rest):
        if t[0] == "word" and t[2] == "plain" and t[1] == "{":
            depth += 1
        elif t[0] == "word" and t[2] == "plain" and t[1] == "}":
            depth -= 1
        elif t == ("op", ";") and depth == 0:
            end = k
            break
    handler = rest[:end]
    if handler_fails(handler):
        return False
    var = capture_var(handler)
    return not (var and exits_with(var, "\n".join(lines[j + 1:])))

ALWAYS_COND = re.compile(r"\b(always|failure)\(\)")

for path in sorted(glob.glob(os.path.join(wfdir, "*.yml"))):
    fn = os.path.basename(path)
    try:
        doc = yaml.safe_load(open(path))
    except yaml.YAMLError as e:
        fail(f"{fn}: invalid YAML, cannot be checked (R0): {str(e).splitlines()[0]}")
        continue
    jobs = (doc or {}).get("jobs") or {}
    for jname, job in jobs.items():
        matrix = (job.get("strategy") or {}).get("matrix")
        check_coe(f"{fn}:{jname}", job.get("continue-on-error"), matrix, (fn, jname, None))
        if ALWAYS_COND.search(str(job.get("if", ""))) and (fn, jname) not in ALWAYS_ALLOW:
            fail(f"{fn}:{jname}: if: always()/failure() aggregator not on the reviewed allowlist (R5)")
        for st in job.get("steps") or []:
            sname = st.get("name") or st.get("id") or "?"
            check_coe(f"{fn}:{jname}: step {sname!r}", st.get("continue-on-error"), matrix, (fn, jname, sname))
            run = st.get("run")
            if not isinstance(run, str) or not TEST_CMD.search(run):
                continue
            pipefail = "pipefail" in run or st.get("shell") == "bash"
            rlines = [x.strip() for x in run.replace("\\\n", " ").splitlines()]
            for li, s in enumerate(rlines):
                if s.startswith("#") or not TEST_CMD.search(s):
                    continue
                if masked(rlines, li):
                    fail(f"{fn}:{jname}: step {sname!r}: test command masked by '||': {s[:90]} (R3)")
                if re.search(r"\|\s*(tee|head|grep|sed|awk|cat)\b", s) and not pipefail:
                    fail(f"{fn}:{jname}: step {sname!r}: test command piped without pipefail: {s[:90]} (R4)")

# Positive control: the files this guard exists for were actually parsed.
want = ["nightly.yml", "test.yml", "release.yml", "full-suite.yml", "post-release-smoke.yml"]
if os.path.basename(wfdir.rstrip("/")) == "workflows" and wfdir == ".github/workflows":
    for w in want:
        if not os.path.exists(os.path.join(wfdir, w)):
            fail(f"expected workflow {w} missing: sweep would be vacuous")

for f in fails:
    print("  FAIL: " + f)
if not fails:
    print("  PASS: no masked failures across", len(glob.glob(os.path.join(wfdir, '*.yml'))), "workflows")
sys.exit(1 if fails else 0)
PY
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

# Self-test: every masking shape must turn the guard red on a mutated copy of
# the real workflows (skipped when a directory argument is given).
[ -z "${1:-}" ] || exit 0
SELF="$(mktemp -d "${TMPDIR:-/tmp}/loki-nomask.XXXXXX")" || exit 1
trap 'rm -rf -- "$SELF"' EXIT
SELF_FAIL=0
mut() { # name file old new
    local d="$SELF/$1"
    mkdir -p "$d" && cp .github/workflows/*.yml "$d/"
    python3 -I - "$d/$2" "$3" "$4" <<'MP'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
assert a in s, "mutation anchor missing: " + a
open(p, "w").write(s.replace(a, b, 1))
MP
    bash "$0" "$d" >/dev/null 2>&1
    if [ $? -eq 1 ]; then echo "  PASS: $1 turns the guard red"; else echo "  FAIL: $1 not caught"; SELF_FAIL=1; fi
}
ok() { # name file old new: a legitimate failing handler must stay green
    local d="$SELF/$1"
    mkdir -p "$d" && cp .github/workflows/*.yml "$d/"
    python3 -I - "$d/$2" "$3" "$4" <<'MP'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
assert a in s, "mutation anchor missing: " + a
open(p, "w").write(s.replace(a, b, 1))
MP
    bash "$0" "$d" >/dev/null 2>&1
    if [ $? -eq 0 ]; then echo "  PASS: $1 stays green"; else echo "  FAIL: $1 wrongly flagged"; SELF_FAIL=1; fi
}
JOB='    continue-on-error: ${{ matrix.experimental == true }}'
STEP='        run: bun test
'
mut M04-job-expr-true nightly.yml "$JOB" '    continue-on-error: ${{ true }}'
mut M05-job-event-name nightly.yml "$JOB" "    continue-on-error: \${{ github.event_name == 'schedule' }}"
mut M06-step-expr-true nightly.yml "$STEP" '        continue-on-error: ${{ true }}
        run: bun test
'
mut M07-exit-0 nightly.yml "$STEP" '        run: bun test || exit 0
'
mut M08-echo nightly.yml "$STEP" '        run: bun test || echo ignored
'
mut M09-true-then nightly.yml "$STEP" '        run: bun test || true; echo next
'
mut M10-true-comment nightly.yml "$STEP" '        run: bun test || true  # tolerated
'
mut M11-success-or-failure release.yml '    needs: [gate, required-ci]
' '    needs: [gate, required-ci]
    if: success() || failure()
'
mut N01-exit-in-string nightly.yml "$STEP" '        run: bun test || echo "gate failed (exit 1), tolerated"
'
mut N02-false-in-string nightly.yml "$STEP" '        run: bun test || echo "false alarm, ignoring"
'
mut N03-exit-var-zero nightly.yml "$STEP" '        run: |
          SOFT=0
          bun test || exit $SOFT
'
mut N08-exit-arith-zero nightly.yml "$STEP" '        run: bun test || exit $((0))
'
mut R01-false-or-true nightly.yml "$STEP" '        run: bun test || false || true
'
mut R02-group-false-or-true nightly.yml "$STEP" '        run: bun test || { false || true; }
'
mut R03-exit-after-echo nightly.yml "$STEP" '        run: bun test || { echo "gate failed"; exit $?; }
'
mut R04-capture-reassigned nightly.yml "$STEP" '        run: bun test || { rc=$?; rc=0; exit $rc; }
'
ok C01-capture-echo-exit nightly.yml "$STEP" '        run: bun test || { rc=$?; echo failed; exit $rc; }
'
ok C02-exit-status nightly.yml "$STEP" '        run: bun test || exit $?
'
ok C03-echo-false nightly.yml "$STEP" '        run: bun test || { echo "::error::gate failed"; false; }
'
ok C04-echo-exit-1 nightly.yml "$STEP" '        run: bun test || { echo "x"; exit 1; }
'
mut M12-always release.yml '    needs: [gate, required-ci]
' '    needs: [gate, required-ci]
    if: always()
'
exit "$SELF_FAIL"
