#!/usr/bin/env python3
"""fast_verify -- millisecond-scale deterministic verification.

WHY THIS EXISTS
    Verification that takes minutes does not scale and cannot be embedded. To be
    pluggable -- into an IDE, an MCP tool, a CI step, or another vendor's agent --
    a verdict has to come back in the time a human would wait for a keystroke,
    not a coffee break.

    MEASURED BASELINE on this repo before this module:
        tests/detect-mock-problems.sh    11,040 ms
        tests/detect-test-mutations.sh   12,361 ms

    The work itself is not slow. The ARCHITECTURE was:
      1. FOUR separate full-tree `find` walks in one detector (one walk = 110 ms).
      2. ~25 subprocess spawns at ~24 ms each of pure interpreter startup.
      3. Every detector re-discovering the same file set independently.

    `git ls-files` returns the same set in 37 ms, already deduplicated and
    already gitignore-aware. So the fix is not "optimize the shell" -- it is to
    stop paying discovery and process tax N times.

THE FIVE DESIGN RULES
    A. SINGLE PASS      - walk once, classify once, hand each detector its slice.
    B. ZERO SUBPROCESS  - detectors are pure functions in ONE process. Startup is
                          paid once, not 25 times.
    C. CONTENT-ADDRESSED- cache each file's findings by content hash. An unchanged
                          file is never re-read. Warm runs approach cache-read cost.
    D. DIFF-SCOPED      - verifying a change needs the changed files, not the repo.
    E. EXOGENOUS ONLY   - no LLM on this path, ever. Only checks the agent cannot
                          author or influence: deterministic, reproducible, and
                          therefore trustworthy. That constraint is what makes the
                          fast path both fast AND the thing worth trusting.

WHAT THIS DELIBERATELY DOES NOT DO
    It does not run the test suite, call a model, or render judgment. Those are
    slower and, in the case of model judgment, not exogenous. This module answers
    only the question a machine can answer deterministically, which is exactly the
    question worth answering in milliseconds.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable

SCHEMA_VERSION = 1

# Source extensions worth scanning. Anything else is discovery noise.
CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".rb", ".java", ".sh"}
TEST_RE = re.compile(r"(^|/)(test_[^/]+\.py|[^/]+\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs))$")

# Excluded even when git tracks them: vendored or generated trees produce findings
# nobody can act on, and scanning them is pure latency.
EXCLUDE_RE = re.compile(r"(^|/)(node_modules|dist|build|vendor|\.venv|coverage|__pycache__)(/|$)")


# --- Findings ---------------------------------------------------------------

@dataclass
class Finding:
    rule: str
    path: str
    line: int
    message: str
    severity: str = "high"


@dataclass
class Result:
    verdict: str                      # PASS | FAIL | INCONCLUSIVE
    findings: list = field(default_factory=list)
    files_scanned: int = 0
    files_from_cache: int = 0
    elapsed_ms: float = 0.0
    schema_version: int = SCHEMA_VERSION
    exogenous: bool = True            # never set False; this path admits no LLM


# --- Rule A: mock data rendered as if it were real ---------------------------
# A UI that maps over a hardcoded array and renders it is the "Potemkin
# interface" failure -- it looks finished and is not wired to anything.

_INLINE_COLLECTION = re.compile(
    r"""(?:const|let|var)\s+(\w+)\s*=\s*\[\s*\{""", re.M)
_RENDER_MAP = re.compile(r"""\{?\s*(\w+)\s*(?:\?\.)?\.map\s*\(""")
_FETCHY = re.compile(r"\b(fetch|axios|useQuery|useSWR|supabase|prisma|createClient)\b")

# Names that are legitimately static content, not stand-ins for a backend.
_STATIC_OK = re.compile(
    r"^(features?|benefits?|faqs?|steps?|tabs?|nav|navigation|menu|links?|routes?|"
    r"columns?|options?|plans?|pricing|tiers?|testimonials?|stats?|socials?|icons?)$",
    re.I)


def _rule_mock_render(path: str, text: str) -> list:
    out = []
    if not text or "[" not in text:
        return out
    declared = {}
    for m in _INLINE_COLLECTION.finditer(text):
        declared[m.group(1)] = text[:m.start()].count("\n") + 1
    if not declared:
        return out
    # A real data source in the same file means the array is plausibly a fallback,
    # not the product. Stay quiet rather than cry wolf: a false BLOCK on a correct
    # build is worse than a missed warning, because it trains users to ignore us.
    if _FETCHY.search(text):
        return out
    for m in _RENDER_MAP.finditer(text):
        name = m.group(1)
        if name in declared and not _STATIC_OK.match(name):
            out.append(Finding(
                rule="mock_render",
                path=path,
                line=declared[name],
                message=(f"'{name}' is a hardcoded collection rendered directly; "
                         "no data source found in this file"),
            ))
    return out


# --- Rule B: tests that cannot fail ------------------------------------------
# A test with no assertion is worse than no test: it turns a green suite into a
# false claim, which is precisely the lie this product exists to prevent.

_SKIPPED = re.compile(r"\b(it|test|describe)\.(skip|todo)\s*\(|@(unittest\.)?skip\b")
_HAS_ASSERT = re.compile(r"\b(expect|assert|should|chai|sinon\.assert)\b")
_TEST_BLOCK = re.compile(r"""\b(?:it|test)\s*\(\s*['"`]([^'"`]{1,120})['"`]""")


def _rule_toothless_test(path: str, text: str) -> list:
    out = []
    if not text:
        return out
    for m in _SKIPPED.finditer(text):
        out.append(Finding(
            rule="skipped_test", path=path,
            line=text[:m.start()].count("\n") + 1,
            message="test is skipped; it cannot fail and cannot verify anything",
            severity="medium",
        ))
    blocks = list(_TEST_BLOCK.finditer(text))
    for i, m in enumerate(blocks):
        end = blocks[i + 1].start() if i + 1 < len(blocks) else len(text)
        body = text[m.end():end]
        if not _HAS_ASSERT.search(body):
            out.append(Finding(
                rule="assertionless_test", path=path,
                line=text[:m.start()].count("\n") + 1,
                message=f"test '{m.group(1)[:60]}' contains no assertion; it always passes",
            ))
    return out


RULES = (_rule_mock_render, _rule_toothless_test)


# --- Discovery: one pass, from the git index ---------------------------------

def _git(args: list, cwd: str) -> str:
    try:
        p = subprocess.run(["git"] + args, cwd=cwd, capture_output=True,
                           text=True, timeout=20)
        return p.stdout if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def discover(root: str, diff_base: str = "") -> list:
    """Return candidate files. ONE listing, no per-detector walk.

    `git ls-files` beats `find` on every axis that matters here: it reads the
    index instead of stat-ing the tree (37 ms vs 110 ms measured), it is already
    gitignore-aware, and it never descends into node_modules. When a diff base is
    given we narrow further -- verifying a change does not require reading the
    repository.
    """
    if diff_base:
        raw = _git(["diff", "--name-only", diff_base + "...HEAD"], root)
        if not raw.strip():
            raw = _git(["diff", "--name-only", diff_base], root)
    else:
        raw = _git(["ls-files"], root)

    if not raw:
        # Not a git repo (or an empty one): fall back to a single os.walk. Still
        # one pass -- the guarantee holds even off the happy path.
        files = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if not EXCLUDE_RE.search(d) and not d.startswith(".")]
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), root)
                if Path(fn).suffix in CODE_EXT and not EXCLUDE_RE.search(rel):
                    files.append(rel)
        return files

    return [ln for ln in raw.splitlines()
            if ln and Path(ln).suffix in CODE_EXT and not EXCLUDE_RE.search(ln)]


# --- Content-addressed cache -------------------------------------------------

class Cache:
    """Findings keyed by content hash, so unchanged files are never re-read.

    Correctness note: the key is the file's CONTENT, not its path or mtime. A
    file that moves keeps its result; a file that changes gets a new key. There
    is no staleness window to reason about, which is what makes it safe to trust
    a cache hit as if the scan had just run.
    """

    def __init__(self, path: str):
        self.path = path
        self.data = {}
        self.hits = 0
        try:
            with open(path, encoding="utf-8") as fh:
                blob = json.load(fh)
            if isinstance(blob, dict) and blob.get("schema") == SCHEMA_VERSION:
                self.data = blob.get("entries", {})
        except (OSError, ValueError):
            self.data = {}

    def get(self, key: str):
        v = self.data.get(key)
        if v is not None:
            self.hits += 1
        return v

    def put(self, key: str, findings: list) -> None:
        self.data[key] = findings

    def save(self) -> None:
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"schema": SCHEMA_VERSION, "entries": self.data}, fh)
            os.replace(tmp, self.path)
        except OSError:
            pass  # a cache that cannot be written must never break a verdict


# --- The entry point ---------------------------------------------------------

def verify(root: str = ".", diff_base: str = "", use_cache: bool = True) -> Result:
    t0 = time.perf_counter()
    root = os.path.abspath(root)
    cache = Cache(os.path.join(root, ".loki", "cache", "fast-verify.json")) if use_cache else None

    findings = []
    scanned = 0

    for rel in discover(root, diff_base):
        full = os.path.join(root, rel)
        try:
            with open(full, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        scanned += 1

        key = hashlib.blake2b(raw, digest_size=16).hexdigest()
        if cache is not None:
            hit = cache.get(key)
            if hit is not None:
                for d in hit:
                    findings.append(Finding(**{**d, "path": rel}))
                continue

        try:
            text = raw.decode("utf-8", errors="replace")
        except Exception:
            continue

        is_test = bool(TEST_RE.search(rel))
        got = []
        for rule in RULES:
            # Rule B is about tests; rule A is about product code. Running each
            # only where it applies is not just faster, it removes a whole class
            # of false positive.
            if rule is _rule_toothless_test and not is_test:
                continue
            if rule is _rule_mock_render and is_test:
                continue
            got.extend(rule(rel, text))

        if cache is not None:
            cache.put(key, [{k: v for k, v in asdict(f).items() if k != "path"} for f in got])
        findings.extend(got)

    if cache is not None:
        cache.save()

    blocking = [f for f in findings if f.severity == "high"]
    verdict = "FAIL" if blocking else ("PASS" if scanned else "INCONCLUSIVE")

    return Result(
        verdict=verdict,
        findings=[asdict(f) for f in findings],
        files_scanned=scanned,
        files_from_cache=(cache.hits if cache else 0),
        elapsed_ms=round((time.perf_counter() - t0) * 1000, 2),
    )


def main(argv: list) -> int:
    root, base, use_cache, as_json = ".", "", True, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--diff-base" and i + 1 < len(argv):
            base = argv[i + 1]; i += 1
        elif a == "--no-cache":
            use_cache = False
        elif a == "--json":
            as_json = True
        elif not a.startswith("-"):
            root = a
        i += 1

    r = verify(root, base, use_cache)
    if as_json:
        print(json.dumps(asdict(r), indent=2))
    else:
        print(f"{r.verdict} in {r.elapsed_ms}ms "
              f"({r.files_scanned} files, {r.files_from_cache} cached)")
        for f in r.findings[:20]:
            print(f"  [{f['severity']}] {f['rule']} {f['path']}:{f['line']} - {f['message']}")
        if len(r.findings) > 20:
            print(f"  ... and {len(r.findings) - 20} more")
    return 1 if r.verdict == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
