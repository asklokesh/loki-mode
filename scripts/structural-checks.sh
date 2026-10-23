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
        printf '%s\n' "$out" | tail -"${STRUCTURAL_TAIL:-15}" | sed 's/^/     | /'
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
# Fetch or decode output reaching an interpreter, deny by default.
#  1. Pipe: any pipe into an interpreter (under any path prefix or sudo/env/exec
#     style wrapper) fails unless that interpreter's OWN code flag comes next.
#  2. Process or command substitution: sh <(curl ...), source <(...), sh -c
#     "$(curl ...)", eval "$(...)", backticks, and "$(cat f)" or "$(<f)".
#  3. Download then run: a curl or wget followed, in the same joined snippet or
#     on a following line of the same fenced block, by running a local file
#     (sh f, python f, source f, . f, ./f, /abs/f); the name is free.
SH = r"(?:/\S*/)?(?:ba|z|da|k|c|fi|a|tc)?sh(?![\w.-])"
SHELL = r"(?:ba|z|da|k|c|fi|a|tc)?sh"
# One table, used by every rule below: command word -> the token that makes it
# read code from its own argument instead of stdin or a file (each flag carries
# its own terminator, no class is shared), or None for a builtin that executes a
# file in the current shell (source and the dot command).
INTERPS = (
    (SHELL, r"-[A-Za-z]*c(?=\s|$)"),
    (r"python[\d.]*", r"-[A-Za-z]*c(?=\s|$)"),
    (r"perl[\d.]*", r"-[A-Za-z]*[eE](?=\s|$)"),
    (r"ruby[\d.]*", r"-[A-Za-z]*e(?=\s|$)"),
    (r"node(?:js)?", r"(?:-[ep]|--eval|--print)(?=\s|$)"),
    (r"php[\d.]*", r"-r(?=\s|$)"),
    (r"(?:pwsh|powershell)", r"-(?:[Cc]ommand|c)(?=\s|$)"),
    (r"deno", r"eval(?=\s|$)"),
    (r"bun", r"(?:-e|--eval|-p|--print)(?=\s|$)"),
    (r"lua(?:jit)?[\d.]*", r"-e(?=\s|$)"),
    # awk: options (-F, -v x=1) may precede an inline program; only -f - and
    # -f /dev/stdin, or no program at all, make it read code from stdin.
    (r"(?:[gmn]?awk)", r"""(?:-(?:[Fv]\s*\S+|(?!f)[A-Za-z-]+)\s+)*['"]"""),
    (r"source", None),
    (r"(?<![\w./-])\.", None),
)
# An interpreter that is NOT followed by its own code flag.
RUN = "(?:" + "|".join(
    r"(?:/\S*/)?%s(?![\w.-])(?!\s+%s)" % (n, f) for n, f in INTERPS if f) + ")"
# A builtin that executes a file in the current shell. It is the command word
# itself, never an argument: no sudo or xargs wrapper (a builtin cannot be run
# through one), only a builtin-prefix keyword with flags.
SRC = "(?:" + "|".join(n for n, f in INTERPS if not f) + r")(?=\s)"
FETCH = r"(?:curl|wget|base64\s+(?:-d|--decode)|openssl\s+base64\s+-d)\b"
WRAP = r"(?:(?:/\S*/)?(?:sudo|doas|env|exec|command|nohup|xargs|busybox|time|nice|setsid|stdbuf)\b[^|;&\n]*?\s)?"
SRCPFX = r"(?:(?:time|command|builtin|exec)\s+(?:-\S+\s+)*)?"
# VAR=value prefixes may sit before a wrapper or an interpreter, values may be
# quoted and hold spaces. Piped, source and . also execute stdin (source
# /dev/stdin), with no code-flag exemption.
ENV = r"""(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*"""
SHVAR = r"""["']?\$(?:\{(?:SHELL|BASH|ZSH)\}|(?:SHELL|BASH|ZSH)(?!\w))["']?(?!\s+-[A-Za-z]*c(?=\s|$))"""
PIPE_RUN = ("(?:" + ENV + WRAP + ENV + r"""["']?""" + RUN + "|" + ENV + WRAP + ENV + SHVAR
            + "|" + ENV + SRCPFX + SRC + ")")
SUBST = r"(?:\$\(|`)\s*(?:" + FETCH + r"|cat\b|<)"
# A local file run: an interpreter or builtin with a file operand, or a path.
def file_run(cap):
    g = (lambda p: "(" + p + ")") if cap else (lambda p: "(?:" + p + ")")
    return (
        r"(?:" + WRAP + ENV + RUN + r"(?:\s+-\S+)*\s+" + g(r"[^\s-]\S*")
        + r"|" + SRCPFX + SRC + r"\s+" + g(r"\S+")
        + r"|" + WRAP + ENV + g(r"(?:\.{0,2}/|~/)\S+") + ")"
    )
FILE_RUN = file_run(False)
# Every interpreter code flag followed by a command or process substitution
# (python3 -c "$(curl ...)"), built from the same table.
SUBST_FLAG = "(?:" + "|".join(
    r"(?:/\S*/)?%s(?![\w.-])\s+(?:-\S+\s+)*?%s\s*[\"']?\s*" % (n, f) for n, f in INTERPS if f
) + ")" + SUBST
# xargs that hands the fetched bytes to an interpreter code flag as its program:
# the flag ends the command or takes {} as its argument.
XARGS_C = (r"(?:(?:/\S*/)?(?:sudo|doas|env)\b[^|;&\n]*?\s)?xargs\b[^|;&\n]*?\s(?:" + "|".join(
    r"(?:/\S*/)?%s(?![\w.-])\s+%s\s*[\"']?(?:$|[|;&)}]|\{\})" % (n, f) for n, f in INTERPS if f) + ")")
pipe = re.compile(
    r"\b" + FETCH + r"[^\n|]*(?:\|[^\n|]*)*?\|&?\s*(?:[({]\s*)?" + PIPE_RUN
    + r"|\b" + FETCH + r"[^\n|]*(?:\|[^\n|]*)*?\|&?\s*(?:[({]\s*)?" + XARGS_C
    + r"|(?:(?<=\s)|^)" + SUBST_FLAG
    + r"|(?:(?<=\s)|^)(?:" + SH + r"|source|eval|\.)\s[^\n]*<\(\s*" + FETCH
    + r"|(?:(?<=\s)|^)(?:" + SH + r"|eval)\s[^\n]*" + SUBST
    + r"|\b(?:curl|wget)\b[^\n]*?(?:&&|;|\|\|)\s*(?:chmod\b[^\n;&]*(?:&&|;)\s*)?" + FILE_RUN
)
# The same download-then-run across lines of one fenced block: the fetch line
# opens the statement (an optional shell prompt and a sudo style wrapper aside)
# and the run line follows within eight lines. Only a run of the file that fetch
# wrote counts (named by -o, -O, a redirect, tee, or the URL basename for wget
# and curl -O), so a data download followed by a script that merely reads it
# (wget data.csv, then python3 analyze.py data.csv) stays clean, as does a
# tarball fetch followed by ./configure (the extracted file is not the download;
# not flagged, an accepted gap that cannot be told apart from a build step).
split_fetch = re.compile(
    r"^[ \t]*(?:\$[ \t]+)?(?:(?:sudo|doas|env|exec|command|time|nohup|nice|setsid|stdbuf)\b[^\n|;&]*?\s)?(?P<cmd>curl|wget)\b(?P<rest>[^\n]*)$")
split_run = re.compile(r"^[ \t]*(?:\$[ \t]+)?(?:[^\n]*?(?:&&|;)\s*)?" + file_run(True), re.M)
SPLIT_WINDOW = 8

def fetched_names(cmd, rest):
    toks = rest.replace(">", " > ").split()
    names = set()
    for k, t in enumerate(toks):
        nxt = toks[k + 1] if k + 1 < len(toks) else ""
        if t in ("--output", "--output-document", ">", ">>", "tee") and nxt:
            names.add(nxt)
        elif t.startswith("--output=") or t.startswith("--output-document="):
            names.add(t.split("=", 1)[1])
        elif t == "--remote-name" or re.fullmatch(r"-[A-Za-z]*[oO]", t):
            if (cmd == "curl" and t[-1] == "o") or (cmd == "wget" and t[-1] == "O"):
                if nxt:
                    names.add(nxt)
            elif cmd == "curl" and t[-1] == "O" or t == "--remote-name":
                names.add("@url")
    if cmd == "wget" and not names:
        names.add("@url")
    out = set()
    for n in names:
        if n == "@url":
            for t in toks:
                if re.match(r"https?://", t):
                    out.add(re.sub(r"[?#].*", "", t).rstrip("/").rsplit("/", 1)[-1] or "index.html")
        else:
            out.add(n.strip("\"'").rsplit("/", 1)[-1])
    return out

def split_flagged(block):
    for k, ln in enumerate(block):
        m = split_fetch.match(ln)
        if not m:
            continue
        names = fetched_names(m.group("cmd"), m.group("rest"))
        if not names:
            continue
        for run in block[k + 1:k + 1 + SPLIT_WINDOW]:
            r = split_run.search(run)
            if r:
                op = next((g for g in r.groups() if g), "").strip("\"'").rsplit("/", 1)[-1]
                if op in names:
                    return True
    return False
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
    # Fenced blocks as multi-line snippets for the cross-line download-then-run.
    fence, block, bstart, mark = False, [], 0, ""
    for i, ln in enumerate(text.split("\n"), 1):
        st = ln.lstrip()
        fm_ = st[:3] if st[:3] in ("```", "~~~") else ""
        if fm_ and (not fence or fm_ == mark):
            if fence and any("skill-lint-ok" in b for b in block):
                block = []
            if fence and block and split_flagged(block):
                bad.append("%s:%d: download piped into a shell" % (f, bstart))
            fence, block, bstart, mark = not fence, [], i + 1, fm_
        elif fence:
            block.append(ln)
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
