#!/usr/bin/env bash
# Hard repo rule: no emoji and no en or em dashes in any tracked or new text file
# (code, docs, UI strings, workflows). Scans every non-binary, non-vendored file
# for U+2013, U+2014 and the emoji ranges. Built output and fixtures that need the
# character are excluded by path (see EXCLUDES).
#
# Second check: every repo-relative path named in README.md, SKILL.md, CLAUDE.md,
# skills, references, docs and wiki markdown (backticked or linked, rooted at a
# top-level repo directory) must exist in git. Paths under tests/ count only when
# they look like repo tests (test-*, run-*, check-*, or a known test directory), so
# example paths for a user's own project (tests/users.test.ts) are not flagged;
# the allowlist below covers other user-side or illustrative paths.
#
# Third check: internal strategy never ships. No tracked file may sit under
# internal/ (the gitignored home for roadmap, moat, competitor and strategy docs),
# no tracked doc may be named like one (ROADMAP, BACKLOG, STRATEGY, MOAT,
# COMPETITIVE, SCORECARD), and no shipped markdown (README.md, SKILL.md, docs,
# references, skills, wiki) may use the internal words "moat", "8090" or
# "factory.ai". internal/ must stay gitignored.
#
# Fourth check: no shipped text (outside CHANGELOG.md) tells a user to run
# `claude login`, which the Claude CLI does not have; the command is
# `claude auth login`.
#
# Sixth check: claims Loki no longer makes never come back in shipped text (CHANGELOG.md keeps
# history verbatim; .gitignore names a generated directory): "tamper-evident" (the receipt is
# signed and `loki verify` re-checks it offline; the audit logs are hash-chained) and "HumanEval"
# (no benchmark figure) or the "41 agent types" count in any tracked text; and no compliance claim ("SOC 2", "SOC2", "GDPR", any
# case) in user-facing text: every markdown file, agents/*.json, and the echo/printf lines of the
# bash CLI. No file is allowed. Code identifiers (the soc2/iso27001/gdpr report ids in src/audit,
# dashboard/server.py and swarm/) are not user-facing and are not scanned, and neither is a markdown
# line that is only a Python raw-string regex (r"..."), which matches a user's own task text. The
# report output itself names no framework: the three src/audit/compliance.js generators run on a
# small fixture and the JSON of each must not match SOC 2, GDPR, ISO 27001 or Type II. The
# always-HIGH regex in skills/model-selection.md must still match GDPR, HIPAA, SOC2 and PCI task
# text. Planted defects: add "tamper-evident" to README.md, then "SOC2" to agents/types.json, then
# echo "GDPR ready" to autonomy/loki; each must be reported by file and line. Set reportType back
# to 'SOC2_TYPE_II' in src/audit/compliance.js; drop hipaa from the model-selection regex.
#
# Fifth check: every loki-ts/src path named in any tracked text file (code comments included, not
# only docs) exists, so a deleted module cannot live on as a pointer or a mirror note.
#
# Planted defects used to prove this test can fail: add one en dash (U+2013) to
# README.md, and separately one emoji (U+2705) to docs/INSTALLATION.md; each must be
# reported by file and line. For the path check, add the sentence "See
# `tests/test-plant.sh`." to README.md. For the fifth check, add to loki-ts/src/cli.ts a comment naming a
# file that does not exist under loki-ts/src (for example runner/plant_gone.ts, written with the prefix). For the internal check, add the word
# "moat" to docs/QUICKSTART.md, and separately create docs/ROADMAP-PLANT.md and
# `git add -f internal/plant.md`. For the login check, change "claude auth login"
# to "claude login" in loki-ts/src/util/run_summary.ts. Reverted afterwards.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need python3
need node
cd "$ROOT" || exit 2

echo "TEST: no emoji, no en or em dashes"

out="$(python3 -I - <<'PY'
import re, subprocess, sys

# (kind, pattern): paths that are generated or must hold the character.
EXCLUDES = [
    ("suffix", ".min.js"), ("suffix", ".map"), ("suffix", ".lock"),
    ("contains", "/assets/"), ("contains", "/fixtures/"),
    ("exact", "tests/min/hygiene.sh"),
]
EMOJI = [
    (0x1F300, 0x1FAFF), (0x2600, 0x26FF),
    (0x2705, 0x2705), (0x2728, 0x2728), (0x274C, 0x274C), (0x274E, 0x274E),
    (0x2753, 0x2755), (0x2757, 0x2757), (0x2764, 0x2764),
    (0x1F000, 0x1F2FF), (0xFE0F, 0xFE0F),
]
RANGES = EMOJI + [(0x2013, 0x2013), (0x2014, 0x2014)]
BAD = re.compile("[" + "".join("%s-%s" % (chr(a), chr(b)) for a, b in RANGES) + "]")

def excluded(p):
    for kind, pat in EXCLUDES:
        if kind == "suffix" and p.endswith(pat): return True
        if kind == "prefix" and p.startswith(pat): return True
        if kind == "contains" and pat in "/" + p: return True
        if kind == "exact" and p == pat: return True
    return False

files = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0")
scanned, hits = 0, []
for p in files:
    if not p or excluded(p):
        continue
    try:
        data = open(p, "rb").read()
    except OSError:
        continue
    if b"\0" in data:
        continue
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        continue
    scanned += 1
    for n, line in enumerate(text.split("\n"), 1):
        m = BAD.search(line)
        if m:
            hits.append("%s:%d U+%04X" % (p, n, ord(m.group())))

print(("OK scanned %d files" % scanned) if scanned >= 300 else ("NO only %d files scanned (need 300 or more)" % scanned))
print("OK no U+2013, U+2014 or emoji codepoints" if not hits else "NO %d line(s) with dash or emoji codepoints: %s" % (len(hits), " ".join(hits[:20])))
PY
)"
while IFS= read -r l; do
    case "$l" in
        "OK "*) ok "${l#OK }" ;;
        "NO "*) bad "${l#NO }" ;;
        *) [ -n "$l" ] && bad "unexpected output: $l" ;;
    esac
done <<< "$out"

paths_out="$(python3 -I - <<'PY'
import os, re, subprocess
ROOTS = ["tests", "scripts", "docs", "skills", "loki-ts", "benchmarks", "eval", "examples", "demo", "references", "autonomy",
         "providers", "tools", "wiki", "packages", "dashboard", "deploy", "vscode-extension"]
ALLOW = [r"^deploy/loki-", r"^docs/(comments|prd\.md|api\.html|AGENTS\.md)$", r"^\.github/", r"^wiki/My-Page\.md$",
         r"^dashboard/(terminal|static/?)$", r"^scripts/CI$", r"^loki-ts/runner$", r"^loki-ts/dist(/.*)?$", r"^packages/control-plane/ui/dist(/.*)?$",  # built at publish time, not tracked
         r"^tests/(a\.py|Quick|monitoring|unit/?|load\.js)$", r"^autonomy/hooks/$"]
TEST_REPO = re.compile(r"^tests/(test[-_][^/]*|run-[^/]*|check-[^/]*|(moat|managed|managed_memory|real-run|workspace|commands|fixtures|cli|council|memory|e2e|plugins|dashboard)(/.*)?)$")
tracked = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0") if f]
tset = set(tracked)
dirs = {"/".join(t.split("/")[:i]) for t in tracked for i in range(1, len(t.split("/")))}
docs = [t for t in tracked if t.endswith(".md")
        and (t in ("README.md", "SKILL.md", "CLAUDE.md") or t.startswith(("skills/", "references/", "docs/", "wiki/")))]
rx = re.compile(r"(?<![A-Za-z0-9_./~$-])((?:%s)/[A-Za-z0-9_./@+-]*[A-Za-z0-9_/])" % "|".join(ROOTS))
bad = []
for f in docs:
    for n, line in enumerate(open(f, encoding="utf-8").read().split("\n"), 1):
        for m in rx.finditer(line):
            p = m.group(1).rstrip(".")
            q = p.rstrip("/")
            if any(c in p for c in "*<>{}") or "..." in p or q in tset or q in dirs:
                continue
            if os.path.normpath(os.path.join(os.path.dirname(f), p)) in tset:
                continue
            if any(re.search(a, p) for a in ALLOW) or (p.startswith("tests/") and not TEST_REPO.match(p)):
                continue
            bad.append("%s:%d %s" % (f, n, p))
print(("OK checked %d markdown files, every named repo path exists" % len(docs)) if not bad
      else "NO %d dangling path(s): %s" % (len(bad), " ".join(bad[:15])))
PY
)"
case "$paths_out" in
    "OK "*) ok "${paths_out#OK }" ;;
    *) bad "${paths_out#NO }" ;;
esac

# Every loki-ts/src path named anywhere (code comments included, not only docs) must exist: a deleted module
# must not live on as a pointer or a "mirrors X" note. CHANGELOG.md is history; built bundles and lock files are skipped.
srcpaths_out="$(python3 -I - <<'PY'
import os, re, subprocess
tracked = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0") if f]
tset = set(tracked)
dirs = {"/".join(t.split("/")[:i]) for t in tracked for i in range(1, len(t.split("/")))}
SKIP = re.compile(r"^(CHANGELOG\.md|benchmarks/h2h/results/)|node_modules/|package-lock\.json$|\.lock$")
rx = re.compile(r"(?<![A-Za-z0-9_.~$/-])(loki-ts/src/[A-Za-z0-9_./-]*[A-Za-z0-9_])")
bad, n_files = [], 0
for f in tracked:
    if SKIP.search(f) or not os.path.isfile(f):
        continue
    try:
        txt = open(f, encoding="utf-8").read()
    except (UnicodeDecodeError, OSError):
        continue
    n_files += 1
    for n, line in enumerate(txt.split("\n"), 1):
        for m in rx.finditer(line):
            q = m.group(1).rstrip(".")
            if q not in tset and q not in dirs:
                bad.append("%s:%d %s" % (f, n, q))
print(("OK checked %d text files, every named loki-ts/src path exists" % n_files) if not bad
      else "NO %d dangling loki-ts/src path(s): %s" % (len(bad), " ".join(bad[:15])))
PY
)"
case "$srcpaths_out" in
    "OK "*) ok "${srcpaths_out#OK }" ;;
    *) bad "${srcpaths_out#NO }" ;;
esac

internal_out="$(python3 -I - <<'PY'
import re, subprocess
files = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0") if f]
bad = []
bad += ["tracked under internal/: " + f for f in files if f.startswith("internal/")]
NAME = re.compile(r"(ROADMAP|BACKLOG|STRATEGY|MOAT|COMPETITIVE|SCORECARD)[^/]*\.(md|html|txt|json)$", re.I)
bad += ["internal-looking doc name: " + f for f in files if NAME.search(f.split("/")[-1])]
WORD = re.compile(r"\bmoat\b|\b8090\b|factory\.ai", re.I)
shipped = [f for f in files if f.endswith(".md") and (f in ("README.md", "SKILL.md") or f.startswith(("docs/", "references/", "skills/", "wiki/")))]
for f in shipped:
    try:
        text = open(f, encoding="utf-8").read()
    except OSError:
        continue
    for n, line in enumerate(text.split("\n"), 1):
        if WORD.search(line):
            bad.append("internal word in %s:%d" % (f, n))
if subprocess.run(["git", "check-ignore", "-q", "internal/x.md"]).returncode != 0:
    bad.append("internal/ is not gitignored")
print(("OK no internal strategy docs or words in %d shipped markdown files; internal/ is ignored" % len(shipped)) if not bad
      else "NO %d internal-strategy leak(s): %s" % (len(bad), "; ".join(bad[:10])))
PY
)"
case "$internal_out" in
    "OK "*) ok "${internal_out#OK }" ;;
    *) bad "${internal_out#NO }" ;;
esac

login_out="$(python3 -I - <<'PY'
import re, subprocess
# The Claude CLI has no `login` subcommand: `claude login` starts a session with
# the prompt "login". The command is `claude auth login`. CHANGELOG.md keeps
# history verbatim; the built bundle is shipped, so it is scanned too.
BAD = re.compile(r"(?<![-\w])claude login\b|[\"']claude[\"'],\s*[\"']login[\"']")
files = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0")
         if f and f not in ("CHANGELOG.md", "tests/min/hygiene.sh")]
hits, scanned = [], 0
for f in files:
    try:
        data = open(f, "rb").read()
    except OSError:
        continue
    if b"\0" in data:
        continue
    text = data.decode("utf-8", "replace")
    scanned += 1
    for n, line in enumerate(text.split("\n"), 1):
        if BAD.search(line):
            hits.append("%s:%d" % (f, n))
print(("OK no shipped text says claude login without auth (%d files)" % scanned) if not hits
      else "NO %d line(s) say claude login (use claude auth login): %s" % (len(hits), " ".join(hits[:15])))
PY
)"
case "$login_out" in
    "OK "*) ok "${login_out#OK }" ;;
    *) bad "${login_out#NO }" ;;
esac

claims_out="$(python3 -I - <<'PY'
import re, subprocess
CLAIMS = [(re.compile(r"tamper-evident", re.I), ()), (re.compile(r"HumanEval"), (".gitignore",)), (re.compile(r"\b41 (specialized )?agent (types|roles)\b", re.I), ())]
COMPLIANCE = re.compile(r"SOC ?2|GDPR", re.I)
TASK_REGEX = re.compile(r'\s*r"[^"]*",?\s*$')
def user_facing(f, line):
    if f.endswith(".md") and TASK_REGEX.match(line):
        return False
    if f.endswith(".md") or (f.startswith("agents/") and f.endswith(".json")):
        return True
    return f == "autonomy/loki" and re.match(r"\s*(echo|printf)\b", line) is not None
files = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0")
         if f and f not in ("CHANGELOG.md", "tests/min/hygiene.sh")]
hits, scanned = [], 0
for f in files:
    try:
        data = open(f, "rb").read()
    except OSError:
        continue
    if b"\0" in data:
        continue
    text = data.decode("utf-8", "replace")
    scanned += 1
    for n, line in enumerate(text.split("\n"), 1):
        for rx, allowed in CLAIMS:
            if f not in allowed and rx.search(line):
                hits.append("%s:%d (%s)" % (f, n, rx.pattern))
        if COMPLIANCE.search(line) and user_facing(f, line):
            hits.append("%s:%d (compliance claim)" % (f, n))
print(("OK no shipped text claims tamper-evident or a HumanEval figure, and no user-facing text makes a SOC 2, SOC2 or GDPR claim (%d files)" % scanned) if not hits
      else "NO %d line(s) bring back a dropped claim: %s" % (len(hits), " ".join(hits[:15])))
PY
)"
case "$claims_out" in
    "OK "*) ok "${claims_out#OK }" ;;
    *) bad "${claims_out#NO }" ;;
esac

report_out="$(node -e '
var c = require(process.argv[1]);
var entries = [
  { seq: 1, timestamp: "2026-01-01T00:00:00Z", who: "agent-a", what: "agent_start", metadata: { containsPii: true, dataType: "logs" } },
  { seq: 2, timestamp: "2026-01-01T00:00:01Z", who: "agent-b", what: "test_run" },
];
var rx = /SOC ?2|GDPR|ISO ?27001|Type II/i;
var hits = [];
["generateSoc2Report", "generateIso27001Report", "generateGdprReport"].forEach(function (n) {
  var m = JSON.stringify(c[n](entries, {})).match(rx);
  if (m) hits.push(n + " (" + m[0] + ")");
});
console.log(hits.length ? "NO audit report output names a framework: " + hits.join(" ") : "OK the three audit report generators name no compliance framework in their output");
' "$ROOT/src/audit/compliance.js" 2>&1)"
case "$report_out" in
    "OK "*) ok "${report_out#OK }" ;;
    *) bad "${report_out#NO }" ;;
esac

tier_out="$(python3 -I - <<'PY'
import re
text = open("skills/model-selection.md", encoding="utf-8").read()
block = re.search(r"ALWAYS_HIGH_PATTERNS = \[(.*?)\]\n", text, re.S)
pats = re.findall(r'r"([^"]*)"', block.group(1)) if block else []
tasks = ["add GDPR consent banner", "add HIPAA audit logging", "SOC2 evidence export", "PCI card storage"]
miss = [t for t in tasks if not any(re.search(p, t, re.I) for p in pats)]
print(("OK the always-HIGH regex in skills/model-selection.md matches GDPR, HIPAA, SOC2 and PCI task text (%d patterns)" % len(pats))
      if pats and not miss else "NO always-HIGH regex misses: %s" % (", ".join(miss) or "no patterns found"))
PY
)"
case "$tier_out" in
    "OK "*) ok "${tier_out#OK }" ;;
    *) bad "${tier_out#NO }" ;;
esac

[ ! -e "$ROOT/action.yml" ] && ! grep -rqE --exclude-dir=archive 'uses: asklokesh/loki-mode@' "$ROOT/docs" "$ROOT/README.md" \
    && ok "no review Action ships: no root action.yml and no doc teaches uses: asklokesh/loki-mode@<tag>" || bad "the removed review Action is still present or still documented"

CW="$ROOT/deploy/docker-compose/loki-watch.yml"
grep -q '^name: loki-watch' "$CW" && grep -q '"issues", "watch", "\${LOKI_WATCH_REPO:?' "$CW" && grep -q 'LOKI_WATCH_SETUP_GIT: "1"' "$CW" && grep -q 'GH_TOKEN: "\${GH_TOKEN:?' "$CW" && ! grep -qE '^[[:space:]]+ports:' "$CW" \
    && grep -q 'loki-watch.yml' "$ROOT/docs/DOCKER.md" && grep -q 'no-follow-up' "$ROOT/docs/DOCKER.md" && grep -q '^## Verified mode' "$ROOT/docs/v10/GUIDE.md" \
    && ! grep -q 'loki backlog "\${GITHUB_REPOSITORY}"' "$ROOT/docs/v10/GUIDE.md" \
    && ok "watch deploy: the Compose file runs issues watch for the repository named in .env, refuses to start without the two credentials, opens no port, and the guides name it, the follow-up switch and verified mode" \
    || bad "the watch Compose file or its docs are missing a required line"

finish
