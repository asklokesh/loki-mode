#!/usr/bin/env bash
# D44 item 3: structural checks that CI caught only after a push (missing
# shard-durations row, real home path in a fixture, unregistered test, doc
# drift, line budgets). Each check must stay under 10s; durations are printed.
# Exits nonzero if any check fails. Reuses existing suites; only the tiny
# line-budget count (same arithmetic as loki-ts/tests/engine10/budget.test.ts)
# and the SKILL.md header/footer check are inline.
#
# Pre-push recommended (too slow here): full shellcheck (bash tests/run-shellcheck.sh),
# bash tests/test-shard-coverage.sh (measured 13-20s,
# over the 10s budget), and bash scripts/local-ci.sh.
#
# Env: STRUCTURAL_ROOT overrides the tree to check (used by the tests);
# STRUCTURAL_BASE overrides the base ref for the emoji/dash scan.

set -uo pipefail
case "${1:-}" in -h|--help) sed -n "2,13p" "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac

ROOT="${STRUCTURAL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 2
FAILED=0

now() { python3 -c 'import time;print(int(time.time()*1000))'; }

# check <label> <cmd...>: run, print PASS/FAIL and duration in ms.
check() {
    local label="$1" t0 t1 out rc
    shift
    t0=$(now)
    out="$("$@" 2>&1)"; rc=$?
    t1=$(now)
    if [ "$rc" -eq 0 ] && [ "$out" = "SKIP" ]; then
        printf 'SKIP %6dms  %s\n' $((t1 - t0)) "$label"
    elif [ "$rc" -eq 0 ]; then
        printf 'PASS %6dms  %s\n' $((t1 - t0)) "$label"
    else
        printf 'FAIL %6dms  %s\n' $((t1 - t0)) "$label"
        printf '%s\n' "$out" | tail -15 | sed 's/^/     | /'
        FAILED=$((FAILED + 1))
    fi
}

# Line budgets: same split and limits as budget.test.ts (D29, D33, D42).
# Counts like the test's split("\n"): newline count plus one per file.
lines() { find "$@" -name '*.ts' -print0 2>/dev/null | xargs -0 awk 'FNR==1{f++} END{print NR+f+0}' 2>/dev/null; }
line_budgets() {
    local e=loki-ts/src/engine10 core mod ext contrib skill rc=0
    mod=$(lines "$e/modernize")
    core=$(( $(lines "$e") - mod ))
    ext=$(lines loki-ts/src/e10ext)
    contrib=$(lines loki-ts/src/contrib)
    skill=$(wc -l < SKILL.md)
    [ "$core" -lt 5000 ] || { echo "core engine10 $core >= 5000"; rc=1; }
    [ "$mod" -lt 4000 ] || { echo "modernize $mod >= 4000"; rc=1; }
    [ "$ext" -lt 1500 ] || { echo "e10ext $ext >= 1500"; rc=1; }
    contrib=${contrib:-0}
    [ "$contrib" -lt 1200 ] || { echo "contrib $contrib >= 1200"; rc=1; }
    [ "$skill" -lt 500 ] || { echo "SKILL.md $skill >= 500"; rc=1; }
    return $rc
}

# SKILL.md header and footer carry the VERSION, together.
skill_version() {
    local v
    v=$(tr -d '[:space:]' < VERSION)
    grep -q "^# Loki Mode v$v\$" SKILL.md || { echo "SKILL.md header != VERSION $v"; return 1; }
    tail -n 3 SKILL.md | grep -q "\*\*v$v |" || { echo "SKILL.md footer != VERSION $v"; return 1; }
}

# Emoji/dash scan (emoji pattern from local-ci.sh). "Changed" is
# everything since the merge-base with the base ref (STRUCTURAL_BASE, else
# origin/main, else main) plus the working tree, so committed slices and CI
# checkouts are scanned too. No resolvable base falls back to HEAD.
# perl, not grep -P: BSD/macOS grep has no -P and the scan silently matched nothing.
BASE=""
for ref in "${STRUCTURAL_BASE:-}" origin/main main; do
    [ -n "$ref" ] || continue
    BASE=$(git merge-base "$ref" HEAD 2>/dev/null) && break
    BASE=""
done
if [ -z "$BASE" ]; then
    echo "structural-checks: no base ref, scanning the working tree only" >&2
    BASE=HEAD
fi
has_match() { perl -CSD -ne 'BEGIN{$p=shift} $f=1 if /$p/; END{exit !$f}' "$1" 2>/dev/null; }
changed_chars() {
    local f rc=0 files base="$BASE"
    # Vendored bytes: upstream refdiffs must stay byte-exact; dist maps embed third-party sources.
    local excl=(. ":(exclude)loki-ts/dist/**" ":(exclude)eval/loki10/refdiff/**")
    # Emoji and dash scans see added lines only, so pre-existing text in a
    # touched file never blocks a slice; untracked files are scanned whole.
    local emoji='[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' dash='[\x{2013}\x{2014}]'
    if git diff "$base" -U0 -- "${excl[@]}" 2>/dev/null | has_match "^\\+(?!\\+\\+ ).*$emoji"; then
        echo "emoji in added lines (diff vs $base)"; rc=1
    fi
    if git diff "$base" -U0 -- "${excl[@]}" 2>/dev/null | has_match "^\\+(?!\\+\\+ ).*$dash"; then
        echo "em/en dash in added lines (diff vs $base)"; rc=1
    fi
    files=$(git ls-files -o --exclude-standard -- "${excl[@]}" 2>/dev/null)
    for f in $files; do
        [ -f "$f" ] || continue
        if has_match "$emoji|$dash" < "$f"; then echo "emoji/dash in untracked: $f"; rc=1; fi
    done
    return $rc
}

# P12-40 (M10): an added doc line may not state a speed or cost multiple or
# percentage without citing a measurement (METRICS, ROUTING-EVIDENCE or a
# .loki/metrics path on the same line). Scans added *.md lines only, so the
# patterns in this script never match themselves.
# P12-40b: text inside inline code spans and fenced code blocks is skipped
# (quoted requirements), and a line carrying the explicit escape token
# <!-- claim-ok --> is skipped. Also caught: "50 % fewer", "cuts cost by 50%",
# "4x as fast", a bold **3x**, and "half the cost". Fence state comes from the
# full new file content, looked up by each added line's number.
unmeasured_claims() {
    local base="$BASE" cite='METRICS|ROUTING-EVIDENCE|\.loki/metrics'
    { git diff "$base" -U0 -- '*.md' ":(exclude)loki-ts/dist/**" ":(exclude)eval/loki10/refdiff/**" 2>/dev/null || true; } \
        | perl -ne '
            BEGIN { $k = shift @ARGV; @ARGV = ();
              $n = q{\d+(?:\.\d+)?};
              @c = ( qr/\b$n\s?(?:x|%)\s+(?:faster|cheaper|fewer|less|lower|as\s+(?:fast|cheap))\b/i,
                     qr/\b(?:cuts?|reduc\w*|lowers?|saves?|slash\w*|drops?)\b[^.]{0,40}\bby\s+$n\s?(?:x|%)/i,
                     qr/\bhalf\s+(?:the|of\s+the)\s+(?:cost|price|latency|tokens)\b/i,
                     qr/\*\*$n\s?x\*\*/i ); }
            if (/^\+\+\+ b\/(.*)$/) { $file = $1; %in = (); $o = 0; $i = 0;
              if (open(F, "<", $file)) { while (<F>) { $i++; if (/^\s*(```|~~~)/) { $in{$i} = 1; $o = !$o } elsif ($o) { $in{$i} = 1 } } close F }
              next }
            if (/^@@ -\S+ \+(\d+)(?:,\d+)? @@/) { $ln = $1; next }
            next unless /^\+(?!\+\+ )(.*)$/;
            $l = $1; $cur = $ln++;
            next if $in{$cur} || $l =~ /<!-- claim-ok -->/ || $l =~ /$k/;
            $t = $l; $t =~ s/`[^`]*`//g;
            for $re (@c) { if ($t =~ $re) { print "unmeasured claim: $l\n"; $bad = 1; last } }
            END { exit $bad ? 1 : 0 }' "$cite"
}

# w2-10: lint every tracked SKILL.md (git ls-files: the shipped set, never
# worktrees or run state under .claude/ or .loki/; no hardcoded list). Frontmatter
# needs a name (lowercase, digits, hyphens, at most 64 chars, no reserved word
# anthropic or claude) and a description (non-empty, at most 1024 chars, no XML
# tags); names must be unique; skill text may not pipe a download into a shell,
# carry an instruction-override phrase, or hold an inline key. A line carrying
# <!-- skill-lint-ok --> is skipped (documented examples).
skill_lint() {
    local files
    files=$(git ls-files '*SKILL.md' | sort)
    [ -n "$files" ] || { echo SKIP; return 0; }
    # shellcheck disable=SC2086
    python3 - $files <<'PY'
import re, sys
bad = []
names = {}
override = re.compile(r"ignore (all |any )?(previous|prior|above) (instructions|rules)|disregard (all |any )?(previous|prior) instructions|you are now in (developer|dan) mode", re.I)
# Fetch or decode output reaching a shell interpreter: through a pipe (tee or
# filter stages between, optional sudo/env wrapper and flags), process
# substitution (sh <(curl ...), source <(...)) or command substitution
# (sh -c "$(curl ...)", eval "$(...)", backticks).
SH = r"(?:/\S*/)?(?:ba|z|da|k|c|fi|a|tc)?sh(?![\w.-])"
# Interpreters read a script from stdin only when bare or given "-"; with -c, -e,
# -p, -m or -r they take code from the argument, so python -c and node -e pass.
INAME = r"(?:/\S*/)?(?:python[\d.]*|node(?:js)?|perl|ruby)(?![\w.-])"
INTERP = INAME + r"(?:\s+-[^ceEpmrl\s]\S*)*(?=\s*(?:$|[|;&)}]|-(?:\s|$)))"
RUN = "(?:" + SH + "|" + INTERP + ")"
FETCH = r"(?:curl|wget|base64\s+(?:-d|--decode)|openssl\s+base64\s+-d)\b"
WRAP = r"(?:(?:sudo|doas|env|exec|command|nohup|xargs|busybox|time|nice|setsid|stdbuf)\b[^|;&\n]*?\s)?"
pipe = re.compile(
    r"\b" + FETCH + r"[^\n|]*(?:\|[^\n|]*)*?\|&?\s*(?:[({]\s*)?" + WRAP + RUN
    + r"|(?:(?<=\s)|^)(?:" + SH + r"|source|eval|\.)\s[^\n]*<\(\s*" + FETCH
    + r"|(?:(?<=\s)|^)(?:" + SH + r"|eval)\s[^\n]*(?:\$\(|`)\s*" + FETCH
    # download then run: curl -o f ... && sh f / python f / ./f
    + r"|\b(?:curl|wget)\b[^\n|]*?(?:-[A-Za-z]*[oO]|--output(?:-document)?)[ =]+(?:\./)?(?P<f>[^\s;&|]+)"
    + r"[^\n]*?(?:&&|;|\|\|)\s*(?:chmod\b[^\n;&]*(?:&&|;)\s*)?"
    + r"(?:" + WRAP + "(?:" + SH + "|" + INAME + ")" + r"(?:\s+-\S+)*\s+(?:\./)?|\./)(?P=f)(?![\w.-])"
)
key = re.compile(r"\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)")
for f in sys.argv[1:]:
    text = open(f, encoding="utf-8", errors="replace").read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        bad.append(f + ": no frontmatter")
        continue
    fm = {}
    for ln in m.group(1).split("\n"):
        k = re.match(r"^([A-Za-z_]+):\s*(.*)$", ln)
        if k:
            fm[k.group(1)] = k.group(2).strip().strip("\"'")
    name, desc = fm.get("name", ""), fm.get("description", "")
    if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
        bad.append(f + ": invalid name " + repr(name))
    elif re.search(r"anthropic|claude", name):
        bad.append(f + ": reserved word in name " + name)
    if not desc:
        bad.append(f + ": empty description")
    elif len(desc) > 1024:
        bad.append("%s: description %d chars > 1024" % (f, len(desc)))
    if re.search(r"</?[A-Za-z][^>]*>", name + " " + desc):
        bad.append(f + ": XML tag in name or description")
    if name:
        if name in names:
            bad.append("%s: duplicate name %s (also %s)" % (f, name, names[name]))
        else:
            names[name] = f
    # Join backslash-newline continuations so a split command is one line.
    logical, cur, start = [], "", 1
    for i, ln in enumerate(text.split("\n"), 1):
        if not cur:
            start = i
        if ln.endswith("\\"):
            cur += ln[:-1] + " "
            continue
        logical.append((start, cur + ln))
        cur = ""
    if cur:
        logical.append((start, cur))
    for i, ln in logical:
        if "skill-lint-ok" in ln:
            continue
        for what, rx in (("download piped into a shell", pipe), ("instruction-override phrase", override), ("inline key", key)):
            if rx.search(ln):
                bad.append("%s:%d: %s" % (f, i, what))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
}

# Typecheck is ~2s with deps installed; skipped (not failed) when loki-ts has no
# node_modules, e.g. CI before its bun install (Tier A R4 typechecks later).
typecheck() {
    [ -d loki-ts/node_modules ] || { echo SKIP; return 0; }
    (cd loki-ts && bun run typecheck)
}

check "shard-durations drift"   bash tests/test-shard-durations-drift.sh
check "no hardcoded paths"      bash tests/test-no-hardcoded-paths.sh
check "test registration"       bash tests/test-registration-coverage.sh
check "SKILL.md version sync"   skill_version
check "line budgets"            line_budgets
check "readme no stale version" bash tests/test-readme-no-stale-version.sh
check "emoji/dash on changes"   changed_chars
check "unmeasured Nx claims"    unmeasured_claims
check "SKILL.md lint"           skill_lint
check "loki-ts typecheck"       typecheck

if [ "$FAILED" -gt 0 ]; then echo "structural-checks: $FAILED failed"; exit 1; fi
echo "structural-checks: all passed"
