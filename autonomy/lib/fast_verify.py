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
    B. ONE PROCESS      - the static detectors are pure functions in ONE process.
                          Startup is paid once, not 25 times. The only subprocesses
                          are git discovery and the Wall run (see below).
    C. CONTENT-ADDRESSED- cache each file's findings by content hash. An unchanged
                          file is never re-read. Warm runs approach cache-read cost.
    D. DIFF-SCOPED      - verifying a change needs the changed files, not the repo.
    E. NO LLM           - no model call and no network on this path, ever. The
                          static rules are deterministic and reproducible. The
                          Wall run executes loki_wall_* files, which are repo code:
                          a Wall file can FAIL a verdict, but only one that is
                          tracked, unchanged and matches an engine10 seal hash can
                          supply the behavioral signal that earns PASS.

WHAT THIS DELIBERATELY DOES NOT DO
    It does not run the project's test suite, call a model, or render judgment.
    It does execute loki_wall_* files (repo code, 60 s total budget, no pytest
    cache written). Model judgment is slower and not exogenous. This module answers
    only the question a machine can answer deterministically, which is exactly the
    question worth answering in milliseconds.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable

SCHEMA_VERSION = 2

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
    # FC-FAST-VERIFY-PASS-WITHOUT-DETECTION: a verdict names the signals behind it.
    # PASS needs a behavioral signal (a Wall file that ran and passed); static rules
    # alone cannot see a logic, spec, test-fitting or security defect, so a clean
    # static scan is INCONCLUSIVE with static_clean=True, never a bare PASS.
    signals: dict = field(default_factory=dict)
    static_clean: bool = False
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


# --- Rule C: a Python test that patches the function it then calls -----------
# `with mock.patch.object(src, 'discount', return_value=90.0): assert src.discount(100) == 90.0`
# asserts the mock, not the code, so it can never fail. Flagged only when the patched
# name is also called in the same test file; patching a dependency of the unit under
# test does not call the patched name from the test and stays quiet.

_PATCH_OBJECT = re.compile(r"""\bpatch\.object\(\s*[\w.]+\s*,\s*['"](\w+)['"]""")
_PATCH_PATH = re.compile(r"""\bpatch\(\s*['"][\w.]*?\.(\w+)['"]""")


def _rule_mock_target(path: str, text: str) -> list:
    out = []
    if not text or "patch" not in text:
        return out
    for rx in (_PATCH_OBJECT, _PATCH_PATH):
        for m in rx.finditer(text):
            name = m.group(1)
            if re.search(r"(?<![\w'\"])(?:[\w.]+\.)?" + re.escape(name) + r"\s*\(", text[m.end():]):
                out.append(Finding(
                    rule="mock_target", path=path,
                    line=text[:m.start()].count("\n") + 1,
                    message=(f"test patches '{name}' and then calls it; the assertion checks the "
                             "mock, not the code under test, so it cannot fail"),
                ))
    return out


RULES = (_rule_mock_render, _rule_toothless_test, _rule_mock_target)


# --- Behavioral signal: Wall files that already exist ------------------------
# The Wall is authored per run by an LLM (engine10 stages/wall.ts) and cannot be
# authored here. When loki_wall_* files are present in the working tree they are
# run (this EXECUTES repo code): a failing one is a FAIL. .py runs under pytest;
# ts/js go through the engine10 Wall runner (RQ-64). A file with no real result
# (no bun, no runner) is counted as skipped, not as a pass. Only a file whose
# provenance checks out (_wall_trusted) can earn the behavioral signal: an agent can
# write `assert True` into an untracked loki_wall_ok.py, so an unattested Wall can
# FAIL a run but never PASS one.

WALL_PREFIX = "loki_wall_"
WALL_TIMEOUT_S = 20
WALL_JS_TIMEOUT_S = 60  # per file, the engine10 Wall runner's own BASE_RUN_TIMEOUT_MS
WALL_TOTAL_BUDGET_S = 60  # whole Wall stage


def _wall_files(root: str) -> list:
    raw = _git(["ls-files", "-co", "--exclude-standard"], root)
    if raw:
        names = raw.splitlines()
    else:
        names = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if not EXCLUDE_RE.search(d) and not d.startswith(".")]
            names.extend(os.path.relpath(os.path.join(dirpath, fn), root) for fn in filenames)
    return [n for n in names
            if os.path.basename(n).startswith(WALL_PREFIX) and not EXCLUDE_RE.search(n)]


def _lokits_entries() -> list:
    """argv prefixes that run `loki internal ...` in bun: the shipped dist, then the source tree. Empty when bun is absent."""
    bun = shutil.which("bun")
    ts = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "loki-ts")
    return [[bun, os.path.join(ts, rel)] for rel in ("dist/loki.js", "src/cli.ts")
            if bun and os.path.exists(os.path.join(ts, rel))]


def _sealed_wall_records(root: str) -> dict:
    """{(basename, sha256): [(base_sha, head_sha), ...]} for every Wall file an engine10 run sealed: the `wall.sealed`
    event in .loki/runs/*/events.jsonl (stages/wall.ts installCore). base_sha and head_sha come from the SAME
    events.jsonl: the intake `stage.completed` (data.base_sha) and the commit `stage.completed` (data.head_sha); a
    missing one is None. No second record format."""
    out = {}
    for ev in Path(root, ".loki", "runs").glob("*/events.jsonl"):
        base = head = None
        sealed = []
        try:
            for line in ev.read_text(encoding="utf-8", errors="replace").splitlines():
                if '"wall.sealed"' not in line and '"stage.completed"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                data = rec.get("data") or {}
                if rec.get("type") == "wall.sealed":
                    for f in data.get("files") or []:
                        if isinstance(f, dict) and isinstance(f.get("path"), str) and isinstance(f.get("sha256"), str):
                            sealed.append((os.path.basename(f["path"]), f["sha256"]))
                elif rec.get("type") == "stage.completed" and rec.get("stage") == "intake" and isinstance(data.get("base_sha"), str):
                    base = data["base_sha"]
                elif rec.get("type") == "stage.completed" and rec.get("stage") == "commit" and isinstance(data.get("head_sha"), str):
                    head = data["head_sha"]
        except OSError:
            continue
        for key in sealed:
            out.setdefault(key, []).append((base, head))
    return out


def _git_strict(args: list, cwd: str):
    """stdout of a git command, or None when git failed or could not run. Trust decisions use this, never
    _git: an empty string from a failed command must not read as "nothing changed"."""
    try:
        p = subprocess.run(["git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"] + args,
                           cwd=cwd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout if p.returncode == 0 else None


def _changed_code_files(root: str, diff_base: str):
    """Code files (Wall files excluded) in the verified diff, or None when the diff cannot be read."""
    if _git_strict(["rev-parse", "--verify", "--quiet", diff_base + "^{commit}"], root) is None:
        return None
    raw = _git_strict(["diff", "--name-only", diff_base + "...HEAD"], root)
    if raw is None or not raw.strip():
        raw = _git_strict(["diff", "--name-only", diff_base], root)
    if raw is None:
        return None
    return {ln for ln in raw.splitlines()
            if ln and Path(ln).suffix in CODE_EXT and not Path(ln).name.startswith("loki_wall_")}


def _run_covers(root: str, base, head, changed: set) -> bool:
    """True when the run's own changed-file set (git diff base_sha head_sha) holds every file of the verified diff."""
    if not base or not head:
        return False
    # head must descend from base (an amend or rebase after the seal breaks the record); an unreachable SHA fails too
    if _git_strict(["merge-base", "--is-ancestor", base, head], root) is None:
        return False
    # the run's head must still be in the verified history: an amended-away head is a dangling object that
    # still resolves until gc, so existence alone proves nothing
    if _git_strict(["merge-base", "--is-ancestor", head, "HEAD"], root) is None:
        return False
    raw = _git_strict(["diff", "--name-only", base, head], root)
    return raw is not None and changed <= set(raw.splitlines())


def _wall_trust(root: str, rel: str, diff_base: str, sealed: dict, changed=None) -> str:
    """"" when a Wall file may supply the behavioral signal, else the reason it may not (a NOT PROVEN line).
    An agent must not have just written it: tracked, unchanged against diff_base (or HEAD) and HEAD, and its
    sha256 matches a recorded engine10 seal. With a diff base it must also be bound to the change: the sealing
    run's own changed-file set (git diff of that run's base_sha and head_sha from the same events.jsonl) covers
    every file of the verified diff, and the Wall text names one of them (`changed`, from _changed_code_files;
    None means the diff was unreadable). Every git error fails closed. A file failing these still runs and can
    FAIL a verdict, never earn a PASS. The seal is a local attestation, not proof."""
    if _git_strict(["ls-files", "--error-unmatch", "--", rel], root) is None:
        return "%s is not tracked" % rel
    for ref in {diff_base or "HEAD", "HEAD"}:
        out = _git_strict(["diff", "--name-only", ref, "--", rel], root)
        if out is None or out.strip():
            return "%s is changed against %s or its git state is unreadable" % (rel, ref)
    try:
        with open(os.path.join(root, rel), "rb") as fh:
            raw = fh.read()
    except OSError:
        return "%s is unreadable" % rel
    runs = sealed.get((os.path.basename(rel), hashlib.sha256(raw).hexdigest()))
    if not runs:
        return "%s has no matching wall.sealed event under .loki/runs/" % rel
    if diff_base:
        if not changed:
            return "%s: the verified diff is unreadable or touches no code file a Wall could exercise" % rel
        if not any(_run_covers(root, b, h, changed) for b, h in runs):
            return ("%s: no run record lists changed files covering the diff (the sealing run's events.jsonl needs "
                    "intake base_sha and commit head_sha whose diff holds every changed file)" % rel)
        text = raw.decode("utf-8", "replace")
        if not any(re.search(r"\b%s\b" % re.escape(Path(c).stem), text) for c in changed):
            return "%s names none of the changed modules" % rel
    return ""


def _run_wall_js(root: str, rels: list, budget_s: float) -> dict:
    """RQ-64: .ts/.js Wall files go through the engine10 Wall runner (`loki internal wall-run`), not a second runner.
    Returns {rel: "pass"|"fail"}; a file with no real result (no bun, no runner, crash, over budget) is absent.
    An entry that does not know the subcommand (a stale dist) yields no JSON, so the next entry is tried."""
    results = None
    for entry in _lokits_entries():
        try:
            p = subprocess.run(entry + ["internal", "wall-run", root] + rels, cwd=root, capture_output=True, text=True,
                               timeout=max(1.0, min(WALL_JS_TIMEOUT_S * len(rels), budget_s)))
            results = json.loads(p.stdout.strip().splitlines()[-1])
            break
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            continue
    return {r["file"]: r["status"] for r in (results if isinstance(results, list) else [])
            if isinstance(r, dict) and r.get("file") in rels and r.get("status") in ("pass", "fail")}


def _run_wall(root: str, diff_base: str = "") -> tuple:
    """Returns (findings, ran, skipped, trusted, notes); notes are NOT PROVEN lines for passing Walls that earned no trust. EXECUTES loki_wall_* files, which are repo code: .py under
    pytest (no cache dir written), .ts/.js through the engine10 Wall runner. Any executed file can FAIL; only a
    trusted one (see _wall_trusted) counts toward `trusted`, the behavioral signal. WALL_TOTAL_BUDGET_S caps the
    whole stage; files left when it runs out are counted skipped."""
    findings, ran, skipped, trusted = [], 0, 0, 0
    deadline = time.monotonic() + WALL_TOTAL_BUDGET_S
    files = _wall_files(root)
    sealed = _sealed_wall_records(root) if files else {}
    changed = _changed_code_files(root, diff_base) if diff_base and files else None
    notes = []
    status = {}
    js = [r for r in files if not r.endswith(".py")]
    for rel in files:
        if rel in js:
            continue
        left = deadline - time.monotonic()
        if left <= 0:
            continue
        try:
            p = subprocess.run([sys.executable, "-B", "-m", "pytest", "-q", "-x", "--no-header", "-p", "no:cacheprovider", rel],
                               cwd=root, capture_output=True, text=True, timeout=min(WALL_TIMEOUT_S, left))
            out = p.stdout + p.stderr
            # rc 0 pass, 1 test failure; anything else (no pytest, collection error)
            # is not a result and must not be read as pass or fail.
            if p.returncode == 0:
                status[rel] = "pass"
            elif p.returncode == 1:
                status[rel] = "fail"
                findings.append(Finding(rule="wall_failed", path=rel, line=1,
                                        message="Wall test fails: " + (out.strip().splitlines() or [""])[-1][:160]))
        except (OSError, subprocess.SubprocessError):
            pass
    if js and deadline - time.monotonic() > 0:
        for rel, st in _run_wall_js(root, js, deadline - time.monotonic()).items():
            status[rel] = st
            if st == "fail":
                findings.append(Finding(rule="wall_failed", path=rel, line=1, message="Wall test fails (engine10 Wall runner)"))
    for rel in files:
        if rel not in status:
            skipped += 1
            continue
        ran += 1
        if status[rel] == "pass":
            why = _wall_trust(root, rel, diff_base, sealed, changed)
            if why:
                notes.append("NOT PROVEN: " + why)
            else:
                trusted += 1
    return findings, ran, skipped, trusted, notes


# --- Discovery: one pass, from the git index ---------------------------------

def _git(args: list, cwd: str) -> str:
    try:
        p = subprocess.run(["git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"] + args, cwd=cwd, capture_output=True,
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

def _producer_fingerprint() -> str | None:
    """Digest of this file's own bytes. Every cached verdict is bound to the
    exact rules that produced it, so any rule edit orphans old entries with no
    hand-bumped version to forget. None when the source cannot be read, in
    which case the cache is off."""
    try:
        with open(os.path.abspath(__file__), "rb") as fh:
            return hashlib.blake2b(fh.read(), digest_size=16).hexdigest()
    except OSError:
        return None


PRODUCER = _producer_fingerprint()


def cache_key(rel: str, raw: bytes) -> str:
    """A verdict depends on the rules, the path (is_test selects which rules
    run) and the content, so all three are in the key."""
    h = hashlib.blake2b(digest_size=16)
    h.update((PRODUCER or "").encode("ascii"))
    h.update(b"\0")
    h.update(rel.encode("utf-8", "replace"))
    h.update(b"\0")
    h.update(raw)
    return h.hexdigest()


def cache_dir() -> str:
    """User-owned cache root, outside every repo the agent works in
    (LOKI_FAST_VERIFY_CACHE_DIR overrides it, for tests and sandboxes)."""
    return os.environ.get("LOKI_FAST_VERIFY_CACHE_DIR") or os.path.join(
        os.path.expanduser("~"), ".loki", "cache", "fast-verify")


def cache_path(root: str) -> str:
    tag = hashlib.blake2b(os.path.realpath(root).encode("utf-8", "replace"), digest_size=8).hexdigest()
    return os.path.join(cache_dir(), tag + ".json")


def _private_dir(path: str) -> bool:
    """Create the cache dir and force it to 0700, including a pre-existing one
    created loose. A dir this user cannot chmod is not ours: refuse it."""
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
        os.chmod(path, 0o700)
        return True
    except OSError:
        return False


def _write_private(path: str, data: bytes, replace: bool) -> None:
    """Write data to a 0600 temp file in the same dir, then publish it
    atomically: os.replace, or os.link so an existing file is never clobbered
    and no reader sees a partial one."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        if replace:
            os.replace(tmp, path)
        else:
            os.link(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _read_key(path: str) -> bytes | None:
    try:
        st = os.stat(path)
        if st.st_mode & 0o077 or st.st_uid != os.getuid():
            return None  # a key others could read or write proves nothing
        with open(path, "rb") as fh:
            key = fh.read()
        return key if len(key) >= 32 else None
    except OSError:
        return None


def _cache_secret() -> bytes | None:
    """Per-user HMAC key kept beside the cache, never inside the repo. None when
    it can be neither read nor created, in which case the cache is off."""
    if PRODUCER is None or not _private_dir(cache_dir()):
        return None
    path = os.path.join(cache_dir(), "key")
    key = _read_key(path)
    if key is not None:
        return key
    try:
        _write_private(path, os.urandom(32), replace=False)
    except FileExistsError:
        pass
    except OSError:
        return None
    return _read_key(path)


class Cache:
    """Findings keyed by content hash, so unchanged files are never re-read.

    The key covers the producing rules (this file's own digest), the path and
    the content, never mtime, so there is no staleness window and a verdict
    cannot outlive a rule change or follow a file to a path where other rules
    apply. Content addressing does not make an entry trustworthy
    on its own: the key is computable by anyone, so an entry written by the
    agent under review could suppress a finding. Each entry therefore carries
    an HMAC under a per-user secret held outside the repo, and an entry whose
    MAC does not verify is a miss: the file is rescanned. Without a secret
    the cache is disabled.
    """

    def __init__(self, path: str):
        self.path = path
        self.data = {}
        self.hits = 0
        self.secret = _cache_secret()
        if self.secret is None:
            return
        try:
            with open(path, encoding="utf-8") as fh:
                blob = json.load(fh)
            if isinstance(blob, dict) and blob.get("producer") == PRODUCER:
                entries = blob.get("entries", {})
                if isinstance(entries, dict):
                    self.data = entries
        except (OSError, ValueError):
            self.data = {}

    def _mac(self, key: str, findings: list) -> str:
        body = json.dumps([PRODUCER, key, findings], sort_keys=True, separators=(",", ":"))
        return hmac.new(self.secret, body.encode("utf-8"), "sha256").hexdigest()

    def get(self, key: str):
        entry = self.data.get(key)
        if self.secret is None or not isinstance(entry, dict):
            return None
        findings, mac = entry.get("findings"), entry.get("mac")
        if not isinstance(findings, list) or not isinstance(mac, str):
            return None
        if not hmac.compare_digest(mac, self._mac(key, findings)):
            return None
        self.hits += 1
        return findings

    def put(self, key: str, findings: list) -> None:
        if self.secret is not None:
            self.data[key] = {"findings": findings, "mac": self._mac(key, findings)}

    def save(self) -> None:
        if self.secret is None:
            return
        try:
            if not _private_dir(os.path.dirname(self.path)):
                return
            blob = json.dumps({"producer": PRODUCER, "entries": self.data})
            _write_private(self.path, blob.encode("utf-8"), replace=True)
        except OSError:
            pass  # a cache that cannot be written must never break a verdict


# --- The entry point ---------------------------------------------------------

def verify(root: str = ".", diff_base: str = "", use_cache: bool = True) -> Result:
    t0 = time.perf_counter()
    root = os.path.abspath(root)
    cache = Cache(cache_path(root)) if use_cache else None

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

        key = cache_key(rel, raw)
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
            if rule is _rule_mock_target and not (is_test and rel.endswith(".py")):
                continue
            got.extend(rule(rel, text))

        if cache is not None:
            cache.put(key, [{k: v for k, v in asdict(f).items() if k != "path"} for f in got])
        findings.extend(got)

    if cache is not None:
        cache.save()

    wall_findings, wall_ran, wall_skipped, wall_trusted, wall_notes = _run_wall(root, diff_base)
    findings.extend(wall_findings)
    behavioral = wall_trusted > 0
    blocking = [f for f in findings if f.severity == "high"]
    if blocking:
        verdict = "FAIL"
    elif scanned and behavioral:
        verdict = "PASS"
    else:
        verdict = "INCONCLUSIVE"
    signals = {"rules": [r.__name__.replace("_rule_", "", 1) for r in RULES], "tests_run": 0,
               "wall_files_run": wall_ran, "wall_files_trusted": wall_trusted, "wall_files_skipped": wall_skipped,
               "behavioral": behavioral, "not_proven": wall_notes}

    return Result(
        verdict=verdict,
        findings=[asdict(f) for f in findings],
        files_scanned=scanned,
        files_from_cache=(cache.hits if cache else 0),
        elapsed_ms=round((time.perf_counter() - t0) * 1000, 2),
        signals=signals,
        static_clean=bool(scanned) and not blocking,
    )


USAGE = """usage: fast_verify.py [ROOT] [--path DIR] [--diff-base REF] [--no-cache] [--json] [-h|--help]
exit codes: 0 PASS, 1 FAIL, 2 root not found, 3 INCONCLUSIVE, 64 unknown option"""


def main(argv: list) -> int:
    root, base, use_cache, as_json = ".", "", True, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--diff-base" and i + 1 < len(argv):
            base = argv[i + 1]; i += 1
        elif a == "--path" and i + 1 < len(argv):
            root = argv[i + 1]; i += 1
        elif a in ("-h", "--help"):
            print(USAGE)
            return 0
        elif a == "--no-cache":
            use_cache = False
        elif a == "--json":
            as_json = True
        elif not a.startswith("-"):
            root = a
        else:
            print(f"fast_verify: unknown option: {a}", file=sys.stderr)
            return 64
        i += 1

    if not os.path.isdir(root):
        print(f"fast_verify: root not found: {root}", file=sys.stderr)
        return 2

    r = verify(root, base, use_cache)
    if as_json:
        print(json.dumps(asdict(r), indent=2))
    else:
        print(f"{r.verdict} in {r.elapsed_ms}ms "
              f"({r.files_scanned} files, {r.files_from_cache} cached)")
        if r.verdict == "INCONCLUSIVE" and r.static_clean:
            print("  static checks clean; no behavioral signal ran (no Wall file), so this is not a pass")
        for line in r.signals.get("not_proven", [])[:5]:
            print("  " + line)
        for f in r.findings[:20]:
            print(f"  [{f['severity']}] {f['rule']} {f['path']}:{f['line']} - {f['message']}")
        if len(r.findings) > 20:
            print(f"  ... and {len(r.findings) - 20} more")
    if r.verdict == "FAIL":
        return 1
    return 3 if r.verdict == "INCONCLUSIVE" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
