#!/usr/bin/env python3
"""Report any surface that CLAIMS the audit chain is tamper-proof.

It is not: both chain implementations accept a fully re-forged history, because
the hash is unkeyed and the genesis is a constant. See
docs/AUDIT-CHAIN-THREAT-MODEL.md for the reproduction.

Matching is per OCCURRENCE, not per line. A line-level negative filter is
exploitable, and was: inserting "tamper-proof" into a line that already read
"not tamper-proof against ..." exempted the whole line, and the mutation test
stayed green. Each occurrence is judged by the words immediately around it, so
an honest caveat cannot launder a false claim sharing its line.

Exit 0 = no claims found. Exit 1 = claims found (printed, one per line).
Exit 2 = could not scan (reported as unmeasured, never as clean).
"""
import os
import re
import sys

# Runtime state and build output are excluded deliberately. .loki/logs/
# bash-audit.jsonl is a log of executed commands: it recorded the very mutation
# commands used to test this guard and reported them as claims. A guard over
# user runtime state fires on whatever the user happened to type.
SKIP_DIRS = {".git", "node_modules", ".loki", "__pycache__", "dist",
             "coverage", ".venv", "venv", "build", ".pytest_cache"}
# LOKI-10-BUILD-PROMPT.md is the internal operating prompt. Its only mention
# is inside a "Never do any of these" list that forbids claiming tamper-proof,
# i.e. the same rule this scanner enforces, phrased as a list item the
# denial window cannot see ("claim a certification (SOC 2, ...), "tamper-proof",
# or ..."). It is not a buyer-facing surface.
SKIP_FILES = {"CHANGELOG.md", "AUDIT-CHAIN-THREAT-MODEL.md",
              "test-audit-chain-honesty.sh", "scan-tamper-claims.py"}
# Matched by path relative to the scan root, not basename, so a copy of the
# prompt placed on a buyer-facing surface is still scanned.
SKIP_PATHS = {os.path.join("docs", "LOKI-10-BUILD-PROMPT.md")}

CLAIM = re.compile(r"tamper[- ]?proof", re.I)

# Text immediately BEFORE an occurrence that makes it a denial or a rule about
# wording rather than an assertion of the property.
OK_BEFORE = re.compile(
    r"(?:not|never|no|isn't|aren't|rather than|instead of|"
    r"describe[^.]{0,40}as|call(?:ing|ed)?[^.]{0,40}as|claim[^.]{0,40}as)"
    r"[\s\-\"'`(]*$",
    re.I,
)


def scan(root="."):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = os.path.join(dirpath, name)
            if name in SKIP_FILES or os.path.relpath(path, root) in SKIP_PATHS:
                continue
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    content = fh.read()
            except (UnicodeDecodeError, OSError):
                # Binary or unreadable: not a buyer-facing claim surface.
                continue
            lines = content.splitlines()
            for lineno, line in enumerate(lines, 1):
                for m in CLAIM.finditer(line):
                    # Prose wraps, so a denial can sit on the PREVIOUS line
                    # ("Do not describe the output of this\n function as
                    # tamper-proof."). Judging only the current line reported
                    # that as a claim. Join the previous line for context.
                    prev = lines[lineno - 2] if lineno >= 2 else ""
                    before = (prev + " " + line[: m.start()])
                    after = line[m.end():]
                    # "tamper-proof against X" draws the correct distinction
                    # (src/audit/crosslink.js:462-465 uses it exactly so).
                    if after[:8].lower().startswith(" against"):
                        continue
                    if OK_BEFORE.search(before):
                        continue
                    hits.append("%s:%d: %s" % (path, lineno, line.strip()[:110]))
    return hits


def main():
    try:
        hits = scan(sys.argv[1] if len(sys.argv) > 1 else ".")
    except Exception as exc:  # noqa: BLE001 - report unmeasured, never clean
        sys.stderr.write("UNMEASURED: %s: %s\n" % (type(exc).__name__, exc))
        return 2
    for h in hits:
        print(h)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
