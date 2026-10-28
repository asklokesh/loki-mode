#!/usr/bin/env python3
"""Check-author context (moat P3, interface A in tests/moat/p3-the-wall.sh).

  check_author.py context --spec <file> --repo <dir>
  check_author.py accept  --spec <file> --repo <dir> --out <dir> [--context <file>] [--attempts N]

context: prints ONE JSON object on stdout: the exact and complete input handed to the
check-authoring model. No model call, no network, deterministic.

  {"spec_sha256": "<hex>", "inputs": [{"path", "sha256"}...], "prompt": "<text>"}

Input selection mirrors the engine10 Wall (loki-ts/src/features/wall_manifest_wire.ts,
the manifest builder wallManifestFor) and is deliberately narrower: of the files
the Wall manifest reads, only the CONFIG class (runner and project config, same
regex as CONFIG there, applied anchored to the whole repo-relative path, so
only root-level config files qualify) is kept. Files come from git ls-files
(tracked regular files, no symlinks), never a filesystem walk, so untracked and
ignored files cannot reach the author. A non-git --repo fails closed: spec only.
Same MAX_BLOB size cap and control-character path rule as the Wall. The Wall's
other two classes are implementation-bearing and are excluded here: TESTISH test
sources (style examples) and "named" source files (signatures of files the task
names). Anything outside the spec and CONFIG files never reaches the author.

accept: reads the author model's stdout from stdin, extracts exactly one JSON
object (prose or a fenced block around it is tolerated; zero or several objects
fail), validates it against the schema the verifier runs, and writes
<out>/checklist.json plus <out>/author.json {status: "authored"} atomically. Any
failure writes <out>/author.json {status: "unknown", reason} and the critical
failing verification-results.json sentinel (same shape as council_reverify_checklist
in autonomy/completion-council.sh), never a checklist.json, and exits non-zero.
accept reads only the spec file (for its sha256) and the optional --context file;
--repo is accepted for symmetry and is never opened.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

# Mirrors CONFIG, MAX_BLOB, MAX_FILES in wall_manifest_wire.ts.
CONFIG = re.compile(
    r"^(package\.json|bunfig\.toml|(vitest|jest)\.config\.[cm]?[jt]s|pytest\.ini|"
    r"pyproject\.toml|setup\.cfg|tox\.ini|go\.mod|Cargo\.toml)$"
)
MAX_BLOB = 200_000
MAX_FILES = 300
# Mirrors TESTISH in wall_manifest_wire.ts.
TESTISH = re.compile(r"(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[jt]sx?$|(^|/)test_[^/]*\.py$|_test\.(py|go)$")
CTRL = re.compile(r"[\x00-\x1f\x7f]")

# Verification types the verifier dispatches in autonomy/checklist-verify.py
# run_check(): file_exists :57, file_contains :69, tests_pass :89, command :218,
# grep_codebase :249, http_check :350. Each maps to the fields that make the check
# runnable (a check missing them can only ever stay pending).
VERIFY_TYPES = {
    "file_exists": ("path|target|file",),
    "file_contains": ("path|target|file", "pattern"),
    "tests_pass": ("pattern",),
    "command": ("command",),
    "grep_codebase": ("pattern",),
    "http_check": (),
}
PRIORITIES = ("critical", "major", "minor")
MAX_ITEMS = 60
MAX_INPUT_BYTES = 2_000_000
RESULT_FIELDS = ("passed", "output", "status", "verified_at")
SENTINEL = ('{"categories":[{"items":[{"id":"check_authoring_unknown","title":'
            '"acceptance checks could not be authored","priority":"critical","status":"failing"}]}]}')

PROMPT_HEAD = (
    "You are the acceptance check author. You see only the specification and the "
    "project's runner configuration below. You cannot see the implementation. "
    "Write acceptance checks that prove the specification is met.\n\n"
    "Reply with exactly ONE JSON object and nothing else of substance, in this format:\n"
    '{"categories":[{"name":"<group>","items":[{"id":"<unique id>","title":"<requirement>",'
    '"priority":"critical|major|minor","verification":[{"type":"<type>", ...}]}]}]}\n'
    "Every item needs id, title, priority and at least one verification. Allowed "
    "verification types and their fields: file_exists {path}; file_contains {path, pattern}; "
    "tests_pass {pattern}; command {command}; grep_codebase {pattern}; http_check {path}. "
    "Use at most %d items. Do not include pass or result fields." % MAX_ITEMS
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def config_files(repo: str, spec_real: str):
    found = []
    for rel in tracked_regular_files(repo) or []:
        # Anchored CONFIG against the whole repo-relative path, as the Wall does
        # (CONFIG.test(e.path)): only root-level config files qualify.
        if not CONFIG.match(rel) or TESTISH.search(rel) or CTRL.search(rel):
            continue
        full = os.path.join(repo, rel)
        if os.path.islink(full) or not os.path.isfile(full) or os.path.realpath(full) == spec_real:
            continue
        try:
            if os.path.getsize(full) > MAX_BLOB:
                continue
        except OSError:
            continue
        found.append((rel, full))
        if len(found) >= MAX_FILES:
            break
    return found


def tracked_regular_files(repo: str):
    """git ls-files regular blobs (modes 100644/100755), like the Wall's ls-tree
    read. None when repo is not a git repo or git fails: the caller fails closed."""
    # Hardening mirrors SAFE_GIT_CONFIG in loki-ts/src/util/safe_git.ts: a repo-planted
    # fsmonitor, hook or ssh command must never run, and a caller GIT_DIR must not
    # redirect the listing.
    env = {k: v for k, v in os.environ.items() if k not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    try:
        r = subprocess.run(["git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null",
                            "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never",
                            "-C", repo, "--no-replace-objects", "ls-files", "-s", "-z"],
                           capture_output=True, timeout=10, check=False, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    out = []
    for raw in r.stdout.split(b"\0"):
        if not raw:
            continue
        meta, _, path = raw.partition(b"\t")
        if meta.split(b" ")[0] not in (b"100644", b"100755"):
            continue
        try:
            out.append(path.decode("utf-8"))
        except UnicodeDecodeError:
            continue
    return out


def build_context(spec: str, repo: str) -> dict:
    spec_bytes = read_bytes(spec)
    spec_real = os.path.realpath(spec)
    repo_real = os.path.realpath(repo)
    if spec_real.startswith(repo_real + os.sep):
        spec_path = os.path.relpath(spec_real, repo_real).replace(os.sep, "/")
    else:
        spec_path = spec_real
    inputs = [{"path": spec_path, "sha256": sha256(spec_bytes)}]
    parts = [PROMPT_HEAD, "Specification (%s):\n%s" % (spec_path, spec_bytes.decode("utf-8", "replace"))]
    for rel, full in config_files(repo, spec_real):
        data = read_bytes(full)
        inputs.append({"path": rel, "sha256": sha256(data)})
        parts.append("Runner config (%s):\n%s" % (rel, data.decode("utf-8", "replace")))
    return {"spec_sha256": inputs[0]["sha256"], "inputs": inputs, "prompt": "\n\n".join(parts)}


class Reject(Exception):
    pass


def extract_one_object(text: str) -> dict:
    """The single top-level JSON object in text; zero or several is a Reject."""
    dec = json.JSONDecoder()
    found = []
    i = 0
    while True:
        i = text.find("{", i)
        if i < 0:
            break
        try:
            obj, end = dec.raw_decode(text, i)
        except ValueError:
            i += 1
            continue
        found.append(obj)
        i = end
    if not found:
        raise Reject("no JSON object in author output")
    if len(found) > 1:
        raise Reject("%d JSON objects in author output, expected exactly one" % len(found))
    return found[0]


def validate_checklist(doc: dict) -> dict:
    cats = doc.get("categories")
    if not isinstance(cats, list) or not cats:
        raise Reject("categories must be a non-empty list")
    out_cats, seen, count = [], set(), 0
    for ci, cat in enumerate(cats):
        items = cat.get("items") if isinstance(cat, dict) else None
        if not isinstance(items, list):
            raise Reject("category %d has no items list" % ci)
        out_items = []
        for it in items:
            count += 1
            if count > MAX_ITEMS:
                raise Reject("more than %d items" % MAX_ITEMS)
            if not isinstance(it, dict):
                raise Reject("item is not an object")
            iid, title = it.get("id"), it.get("title")
            if not isinstance(iid, str) or not iid.strip() or not isinstance(title, str) or not title.strip():
                raise Reject("item needs a non-empty string id and title")
            if iid in seen:
                raise Reject("duplicate item id: %s" % iid)
            seen.add(iid)
            if it.get("priority") not in PRIORITIES:
                raise Reject("item %s: priority must be one of %s" % (iid, "/".join(PRIORITIES)))
            ver = it.get("verification")
            if not isinstance(ver, list) or not ver:
                raise Reject("item %s: needs at least one verification" % iid)
            out_ver = []
            for v in ver:
                if not isinstance(v, dict) or v.get("type") not in VERIFY_TYPES:
                    raise Reject("item %s: verification type must be one of %s"
                                 % (iid, ", ".join(sorted(VERIFY_TYPES))))
                for need in VERIFY_TYPES[v["type"]]:
                    if not any(isinstance(v.get(k), str) and v.get(k).strip() for k in need.split("|")):
                        raise Reject("item %s: %s check needs %s" % (iid, v["type"], need))
                out_ver.append({k: x for k, x in v.items() if k not in RESULT_FIELDS})
            out_items.append({"id": iid, "title": title, "priority": it["priority"], "verification": out_ver})
        name = cat.get("name")
        out_cats.append({"name": name if isinstance(name, str) else "", "items": out_items})
    return {"categories": out_cats}


def atomic_write(path: str, text: str) -> None:
    tmp = "%s.tmp.%d" % (path, os.getpid())
    try:
        with open(tmp, "w") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def run_accept(args) -> int:
    out = args.out
    os.makedirs(out, exist_ok=True)
    spec_sha = sha256(read_bytes(args.spec))
    inputs, prompt_sha = [{"path": os.path.realpath(args.spec), "sha256": spec_sha}], None
    try:
        if args.context:
            try:
                with open(args.context) as fh:
                    ctx = json.load(fh)
                inputs, prompt_sha = ctx["inputs"], sha256(ctx["prompt"].encode("utf-8"))
                ctx_spec = ctx.get("spec_sha256")
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                raise Reject("context file unreadable or malformed")
            if ctx_spec != spec_sha:
                raise Reject("context spec_sha256 does not match the spec")
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise Reject("author output exceeds %d bytes" % MAX_INPUT_BYTES)
        text = raw.decode("utf-8", "replace")
        if not text.strip():
            raise Reject("empty author output")
        checklist = validate_checklist(extract_one_object(text))
    except Reject as e:
        try:
            os.unlink(os.path.join(out, "checklist.json"))
        except OSError:
            pass
        atomic_write(os.path.join(out, "author.json"), json.dumps(
            {"status": "unknown", "reason": str(e), "spec_sha256": spec_sha, "attempts": args.attempts},
            sort_keys=True) + "\n")
        atomic_write(os.path.join(out, "verification-results.json"), SENTINEL + "\n")
        print("check_author: unknown: %s" % e, file=sys.stderr)
        return 1
    atomic_write(os.path.join(out, "checklist.json"), json.dumps(checklist, sort_keys=True, indent=2) + "\n")
    atomic_write(os.path.join(out, "author.json"), json.dumps(
        {"status": "authored", "spec_sha256": spec_sha, "inputs": inputs,
         "prompt_sha256": prompt_sha, "attempts": args.attempts}, sort_keys=True) + "\n")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="check_author.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("context", help="print the exact check-author input as JSON")
    c.add_argument("--spec", required=True)
    c.add_argument("--repo", required=True)
    a = sub.add_parser("accept", help="validate the author model's stdout and write the checklist")
    a.add_argument("--spec", required=True)
    a.add_argument("--repo", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--context", help="saved context output, for inputs and prompt_sha256")
    a.add_argument("--attempts", type=int, default=1)
    args = ap.parse_args(argv)
    if not os.path.isfile(args.spec):
        print("check_author: spec not found: %s" % args.spec, file=sys.stderr)
        return 2
    if not os.path.isdir(args.repo):
        print("check_author: repo not a directory: %s" % args.repo, file=sys.stderr)
        return 2
    if args.cmd == "accept":
        return run_accept(args)
    json.dump(build_context(args.spec, args.repo), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
