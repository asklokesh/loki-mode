#!/usr/bin/env python3
"""Find documentation claims the repo itself contradicts.

WHY THIS EXISTS. This repo's standing rule is "verify, then document", and it
was written down because documenting first kept shipping. A doc claim rots
silently: nothing imports it, no test runs it, and the only reader who can tell
it went stale is a user who has already followed it and lost an hour. Meanwhile
every other honesty surface here -- the receipt, the cost figure, the tool
index -- is machine-checked. Prose was the one place a false claim could sit
indefinitely and still look like documentation.

Three claim kinds are checkable against the repo without running anything:

  A `tools/<name>` PATH either exists or it does not.
  A documented `LOKI_*` VAR either occurs in source or it does not.
  A CURRENT-VERSION string either matches VERSION or it does not.

THE THREE-STATE RULE, which is the whole design. A claim this tool cannot check
is reported UNCHECKABLE -- never as passing, and never as a finding. Collapsing
that third state in either direction is a lie in one of the two available
directions:

  Call it PASSING and the audit becomes a rubber stamp: `LOKI_JIRA_` "verified",
  meaning only that nobody looked.
  Call it a FINDING and the output fills with noise until a reader stops
  reading, which loses the real findings too.

So UNCHECKABLE is a first-class, counted, printed outcome.

WHERE EACH CHECK MUST FAIL. The env check is the one with an arms race in it,
and this deliberately does not enter it. A read-pattern allowlist ($VAR,
${VAR}, env["VAR"], getenv("VAR"), os.environ, export VAR=) is used ONLY to
promote a var to PASS. It is NEVER used to demote one to a finding, because a
read form the allowlist has not seen yet is a bug in the allowlist, not a
defect in the docs. A finding requires the strictly stronger evidence of ZERO
occurrences of the token anywhere in source -- no read syntax, no mention, no
test. Everything between those two poles is UNCHECKABLE.

That asymmetry also handles documented PREFIXES for free. `LOKI_SDK_COUNCIL` is
not a variable; the real ones are `LOKI_SDK_COUNCIL_V2` and
`LOKI_SDK_COUNCIL_VOTE`. Substring containment sees those, so the prefix is not
a finding. An extracted-token comparison would have called all eight prefix
families in this repo false. That was measured, not imagined.

WHAT IS NOT SCANNED, and why. CHANGELOG.md and artifacts/ are HISTORICAL
RECORD, not claims about today. "v8.40.0 fixed the dist check" is true forever
and its version string disagrees with VERSION by construction. Auditing them
would produce hundreds of findings that are all correct statements. The
exclusion list is printed with the output, because an exclusion nobody can see
is one nobody can challenge.

VACUITY. The scanned-file count is printed on every run, and an empty docs set
exits 3 rather than 0. Scanning nothing is not a clean bill of health -- it is
an absent measurement, and this repo has paid four releases to learn that a
substring search over an empty listing reports nothing missing.

Exit codes follow the tools/ convention:
  0  checked, every claim held
  1  checked, at least one claim is FALSE
  2  the scan itself could not run
  3  nothing to check (no docs, or no checkable claims in them)
  64 usage error
  66 the given docs root does not exist

Reads the filesystem only. Starts nothing, spends nothing, contacts nothing.

Usage:
  tools/audit-docs.py [docs-root] [--json]
"""

import argparse
import json
import os
import re
import sys

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

# Where evidence that a LOKI_* var is read may live. The list is deliberately
# WIDE, because every directory missing from it pushes a var toward FALSE --
# the unsafe direction. An omission here does not weaken a check, it invents a
# finding.
#
# That is not hypothetical. An earlier draft listed eleven directories and
# omitted `src/` and `deploy/`. It reported 116 distinct vars as undocumented-
# and-unread; searching the WHOLE repo with no extension filter found 22 of
# them present, including `LOKI_SERVICE_NAME` at src/observability/otel.js:425
# under a plain `process.env` read. 19% of the findings were the scan's own
# blind spot. The evidence line says "0 occurrences across ..." and it must
# mean it, so the list is enumerated and printed with every run.
#
# tests/ is included ON PURPOSE: a test doing env["LOKI_MAX_TIER"] = "low" is
# evidence some runtime reads it. Counting it can only turn a finding into
# UNCHECKABLE, never the reverse.
SOURCE_DIRS = ("autonomy", "loki-ts/src", "loki-ts/test", "loki-ts/tests",
               "src", "tools", "dashboard", "dashboard-ui/src", "mcp",
               "memory", "events", "bin", "providers", "scripts", "deploy",
               "tests", "benchmarks", "web-app/src", ".github")

SOURCE_EXTS = (".sh", ".py", ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx",
               ".json", ".yml", ".yaml", ".toml", ".env", ".example",
               ".conf", ".cfg", ".ini", ".txt", "Dockerfile")

# EXTENSIONLESS EXECUTABLES ARE SOURCE. The main CLI is `autonomy/loki` --
# 32,000 lines, no extension. An extension allowlist skipped it entirely, and
# six variables it genuinely reads (LOKI_NOTIFY_CHANNELS at autonomy/loki:12887
# among them) were reported as false doc claims. Anything with a shebang counts.
_SHEBANG = "#!"

# .loki/ is THIS repo's own run state, and it holds a bash audit log that
# records every command anyone ran -- including greps for the very variable
# names being audited. Counting it would let the tool's own investigation
# supply the evidence that clears a claim. Self-contamination, not a consumer.
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "__pycache__",
             ".venv", "venv", "coverage", ".loki"}

# Repo-root files that are not under any SOURCE_DIRS entry but do read env.
SOURCE_ROOT_FILES = ("docker-compose.yml", "Dockerfile", "Dockerfile.sandbox",
                     "package.json", "server.json")

# Markdown trees excluded from the scan, each with the reason a reader can
# argue with. Printed on every run.
DOC_EXCLUSIONS = (
    ("CHANGELOG.md", "release history; its version strings are true forever"),
    ("artifacts/", "frozen point-in-time reports, not claims about today"),
    ("node_modules/", "third-party"),
    ("wiki/_Footer.md", "generated navigation chrome"),
)

# Files that carry a CURRENT-version claim, per the Release Workflow section of
# CLAUDE.md. Scoping the version check to this list is what separates a claim
# ("Current Version: 8.0.0") from history ("fixed in v8.40.0") without needing
# a classifier for English tense.
VERSION_CLAIM_FILES = (
    "SKILL.md", "CLAUDE.md", "README.md", "docs/INSTALLATION.md",
    "wiki/Home.md", "wiki/_Sidebar.md", "wiki/API-Reference.md",
)

# A version string is a CLAIM ABOUT NOW only in these exact shapes. Everything
# else in the same file is history ("DEPRECATED in v7.2.0", "zero config
# (v7.45.0)") and is skipped outright rather than bucketed UNCHECKABLE -- if
# history landed in that bucket it would fill with hundreds of true statements
# and the bucket would stop meaning anything.
#
# Each pattern was derived from a real line, not guessed:
#   SKILL.md:6     "# Loki Mode v9.8.1"
#   SKILL.md:472   "**v9.8.1 | [Autonomi]..."
#   CLAUDE.md:338  "- Current: v9.8.1 (see [CHANGELOG.md]...)"
#   wiki/Home.md   "Current Version: **8.0.0** ([CHANGELOG]...)"
#
# A loose cue was tried first and produced three false findings: an IP address
# (127.0.0.1 in "http://127.0.0.1:57374") and two historical mentions on lines
# beginning with "#" inside fenced shell blocks. Anchoring on the claim phrase
# rather than on line shape removed all three.
_VERSION_CLAIMS = (
    re.compile(r"current\s+version[^0-9\n]{0,20}v?(\d+\.\d+\.\d+)", re.I),
    re.compile(r"current:\s*v?(\d+\.\d+\.\d+)", re.I),
    re.compile(r"^#\s+Loki Mode\s+v?(\d+\.\d+\.\d+)", re.I),
    re.compile(r"^\*\*v?(\d+\.\d+\.\d+)\s*\|"),
)

_TOOL_PATH = re.compile(r"\btools/([A-Za-z0-9_.<>*\[\]{}-]+\.(?:py|sh))")
_ENV_VAR = re.compile(r"\b(LOKI_[A-Z0-9_]*)")

# A placeholder, not a real path: tools/<name>.py, tools/*.py, tools/{x}.py.
_PLACEHOLDER = re.compile(r"[<>*{}\[\]]")

# Promotes a var to PASS. Never demotes one to a finding -- see the docstring.
_READ = re.compile(
    r"\$\{?(LOKI_[A-Z0-9_]+)"                                  # $VAR ${VAR}
    r"|env(?:iron)?(?:\.get)?[\[\(]\s*[\"'](LOKI_[A-Z0-9_]+)"  # env["VAR"]
    r"|getenv\(\s*[\"'](LOKI_[A-Z0-9_]+)"                      # getenv("VAR")
    r"|[\"'](LOKI_[A-Z0-9_]+)[\"']\s*,"                        # helper(e,"VAR",d)
    r"|^[ \t]*(?:export[ \t]+|local[ \t]+)?(LOKI_[A-Z0-9_]+)=",  # VAR=
    re.M)

PASS, FALSE, UNCHECKABLE = "pass", "false", "uncheckable"


class ScanError(Exception):
    """The scan could not run. Exit 2, never a verdict."""


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error, and 2 already means something else.

    In this convention 2 is "could NOT check" -- a real answer about the docs.
    A typo in a flag is not that; it is 64. Left alone, `--jsno` would report
    as a failed scan and a CI job could not tell the two apart.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _excluded(rel):
    for prefix, _reason in DOC_EXCLUSIONS:
        if rel == prefix or rel.startswith(prefix):
            return True
    return False


def find_docs(root):
    """Every markdown file under root, minus the documented exclusions."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if not name.endswith(".md"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if not _excluded(rel):
                out.append((rel, full))
    return sorted(out)


def source_corpus(root):
    """Concatenated source text, used only for occurrence containment.

    One walk, not one grep per variable. 279 documented vars against 300 source
    files is 83,700 greps the naive shape would have run.
    """
    chunks = []
    for rel in SOURCE_DIRS:
        base = os.path.join(root, rel)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                full = os.path.join(dirpath, name)
                try:
                    if name.endswith(SOURCE_EXTS):
                        chunks.append(_read(full))
                    elif "." not in name:
                        # Extensionless: read it only if it is a script. This
                        # is how autonomy/loki (the main CLI) gets counted.
                        body = _read(full)
                        if body.startswith(_SHEBANG):
                            chunks.append(body)
                except OSError:
                    continue  # unreadable file is not evidence of absence
    for name in SOURCE_ROOT_FILES:
        full = os.path.join(root, name)
        if os.path.isfile(full):
            try:
                chunks.append(_read(full))
            except OSError:
                continue
    text = "\n".join(chunks)
    reads = set()
    for match in _READ.finditer(text):
        reads.add(next(g for g in match.groups() if g))
    return text, reads


def repo_version(root):
    """The VERSION file, or None when it cannot be read.

    None means the version check reports UNCHECKABLE for every version claim.
    A missing baseline is not evidence that the docs are right.
    """
    try:
        value = _read(os.path.join(root, "VERSION")).strip()
    except OSError:
        return None
    return value or None


def _finding(kind, doc, line, claim, status, evidence):
    return {"kind": kind, "file": doc, "line": line, "claim": claim,
            "status": status, "evidence": evidence}


def check_tool_paths(root, doc, text):
    for lineno, line in enumerate(text.splitlines(), 1):
        for match in _TOOL_PATH.finditer(line):
            name = match.group(1)
            claim = "tools/" + name
            if _PLACEHOLDER.search(name):
                yield _finding(
                    "tool_path", doc, lineno, claim, UNCHECKABLE,
                    "placeholder or glob, not a literal path")
                continue
            full = os.path.join(root, "tools", name)
            if os.path.exists(full):
                yield _finding("tool_path", doc, lineno, claim, PASS,
                               "file exists: " + claim)
            else:
                yield _finding("tool_path", doc, lineno, claim, FALSE,
                               "no such file: " + claim)


def check_env_vars(doc, text, corpus, reads):
    """A var is FALSE only on zero occurrences anywhere in source.

    Three outcomes, and the middle one is the point:
      read syntax found            -> PASS
      token occurs, no read syntax -> UNCHECKABLE (a mention is not a consumer,
                                      but neither is it proof of absence)
      token occurs nowhere at all  -> FALSE
    """
    for lineno, line in enumerate(text.splitlines(), 1):
        # One claim per (line, var). A var named twice on one line -- common in
        # `export LOKI_X=${LOKI_X:-0}` -- is a single claim, and counting it
        # twice inflates the headline number a reader will quote.
        seen = set()
        for match in _ENV_VAR.finditer(line):
            name = match.group(1)
            if name in seen:
                continue
            seen.add(name)
            # LOKI_ or LOKI_JIRA_ is an extraction artifact of a prefix family,
            # not a variable anyone can set. Never a claim.
            if name.endswith("_") or name == "LOKI":
                yield _finding("env_var", doc, lineno, name, UNCHECKABLE,
                               "prefix family, not a concrete variable name")
                continue
            if name in reads:
                yield _finding("env_var", doc, lineno, name, PASS,
                               "read by source (env read syntax found)")
            elif name in corpus:
                yield _finding(
                    "env_var", doc, lineno, name, UNCHECKABLE,
                    "occurs in source but under no recognised read syntax; "
                    "the allowlist may be incomplete")
            else:
                yield _finding(
                    "env_var", doc, lineno, name, FALSE,
                    "0 occurrences across " + ", ".join(SOURCE_DIRS))


def check_versions(doc, text, version):
    if doc not in VERSION_CLAIM_FILES:
        return
    for lineno, line in enumerate(text.splitlines(), 1):
        for pattern in _VERSION_CLAIMS:
            match = pattern.search(line)
            if not match:
                continue  # history or unrelated number, not a claim about now
            found = match.group(1)
            if version is None:
                yield _finding("version", doc, lineno, found, UNCHECKABLE,
                               "VERSION file unreadable; no baseline to "
                               "compare against")
            elif found == version:
                yield _finding("version", doc, lineno, found, PASS,
                               "matches VERSION (" + version + ")")
            else:
                yield _finding("version", doc, lineno, found, FALSE,
                               "VERSION says " + version + ", doc says "
                               + found)


def audit(root, docs_root):
    if not os.path.isdir(docs_root):
        raise ScanError("docs root does not exist: " + docs_root)
    docs = find_docs(docs_root)
    corpus, reads = source_corpus(root)
    if not corpus:
        raise ScanError(
            "no source files found under " + root + "; every env-var claim "
            "would read as false against an empty corpus")
    version = repo_version(root)

    results = []
    for rel, full in docs:
        try:
            text = _read(full)
        except OSError as exc:
            results.append(_finding("file", rel, 0, rel, UNCHECKABLE,
                                    "unreadable: %s" % exc))
            continue
        results.extend(check_tool_paths(root, rel, text))
        results.extend(check_env_vars(rel, text, corpus, reads))
        results.extend(check_versions(rel, text, version))
    return docs, results


def _summary(docs, results):
    return {
        "docs_scanned": len(docs),
        "claims_checked": len(results),
        "false": sum(1 for r in results if r["status"] == FALSE),
        "passed": sum(1 for r in results if r["status"] == PASS),
        "uncheckable": sum(1 for r in results if r["status"] == UNCHECKABLE),
        "excluded": [{"path": p, "reason": why} for p, why in DOC_EXCLUSIONS],
        "source_dirs": list(SOURCE_DIRS),
    }


def _exit_code(docs, results):
    if not docs:
        return 3
    if not results:
        return 3  # docs present, nothing checkable: still an absent measurement
    return 1 if any(r["status"] == FALSE for r in results) else 0


def _render(summary, results, code):
    lines = ["DOC AUDIT"]
    lines.append("  docs scanned:  %d" % summary["docs_scanned"])
    lines.append("  claims checked: %d  (false %d, passed %d, uncheckable %d)"
                 % (summary["claims_checked"], summary["false"],
                    summary["passed"], summary["uncheckable"]))
    for item in summary["excluded"]:
        lines.append("  excluded: %-16s %s" % (item["path"], item["reason"]))

    false = [r for r in results if r["status"] == FALSE]
    if false:
        lines.append("")
        lines.append("FALSE CLAIMS (%d)" % len(false))
        for r in false:
            lines.append("  %s:%d  %s" % (r["file"], r["line"], r["claim"]))
            lines.append("      evidence: %s" % r["evidence"])

    unchecked = [r for r in results if r["status"] == UNCHECKABLE]
    if unchecked:
        lines.append("")
        lines.append("UNCHECKABLE (%d) -- not passing, not failing"
                     % len(unchecked))
        for r in unchecked[:20]:
            lines.append("  %s:%d  %s -- %s"
                         % (r["file"], r["line"], r["claim"], r["evidence"]))
        if len(unchecked) > 20:
            lines.append("  ... %d more (use --json for all)"
                         % (len(unchecked) - 20))

    if code == 3:
        lines.append("")
        lines.append("NOTHING TO CHECK -- scanning nothing is not a clean bill.")
    elif not false:
        lines.append("")
        lines.append("No false claim found.")
    return "\n".join(lines)


def main(argv=None):
    parser = _Parser(
        description="Find documentation claims the repo contradicts.")
    parser.add_argument("docs_root", nargs="?", default=None,
                        help="directory of markdown to audit (default: repo root)")
    parser.add_argument("--json", action="store_true",
                        help="emit machine-readable output")
    args = parser.parse_args(argv)

    docs_root = args.docs_root or _ROOT
    if args.docs_root is not None and not os.path.exists(args.docs_root):
        # 66 input missing. Emitted as JSON under --json: a consumer that asked
        # for machine output must not get a bare line it cannot parse.
        payload = {"status": "input_missing", "exit_code": 66,
                   "error": "no such path: " + args.docs_root}
        print(json.dumps(payload, indent=2) if args.json
              else "INPUT MISSING -- no such path: " + args.docs_root)
        return 66

    try:
        docs, results = audit(_ROOT, docs_root)
    except ScanError as exc:
        payload = {"status": "scan_failed", "exit_code": 2, "error": str(exc)}
        print(json.dumps(payload, indent=2) if args.json
              else "CANNOT SCAN -- " + str(exc))
        return 2

    code = _exit_code(docs, results)
    summary = _summary(docs, results)
    if args.json:
        print(json.dumps({"status": "no_claims" if code == 3 else "audited",
                          "exit_code": code, "summary": summary,
                          "findings": results}, indent=2))
    else:
        print(_render(summary, results, code))
    return code


if __name__ == "__main__":
    sys.exit(main())
