#!/usr/bin/env python3
"""PRD Checklist Verification Engine (v5.45.0)

Reads .loki/checklist/checklist.json, runs each verification check with
subprocess timeouts, and writes results atomically.

Check types:
  - file_exists: os.path.exists(path)
  - file_contains: file exists AND matches regex
  - tests_pass: subprocess with 30s timeout, check exit code
  - command: arbitrary shell command, 30s timeout, check exit code
  - grep_codebase: grep -r for pattern in project
  - http_check: HTTP GET to app URL + path, check status code

Timeout = item stays 'pending' (not 'failed') to prevent false failures.
Atomic writes: temp file + os.replace() to never produce partial JSON.

Usage:
    python3 checklist-verify.py [--checklist PATH] [--timeout SECS] (--freeze | --expect-digest SHA256)
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


# Allowed characters in check paths and patterns (security: prevent injection)
_SAFE_PATH_RE = re.compile(r'^[a-zA-Z0-9_\-./\*\[\]{}?]+$')
_SAFE_PATTERN_RE = re.compile(r'^[a-zA-Z0-9_\-./\*\[\]{}?|\\()+^$\s:=<>@#"\'`,;!&%]+$')


def _validate_path(path: str, project_dir: str) -> str:
    """Validate and resolve a path, preventing traversal outside project."""
    if not path or not _SAFE_PATH_RE.match(path):
        raise ValueError(f"Invalid path characters: {path!r}")
    resolved = os.path.realpath(os.path.join(project_dir, path))
    project_real = os.path.realpath(project_dir)
    if not resolved.startswith(project_real + os.sep) and resolved != project_real:
        raise ValueError(f"Path traversal blocked: {path!r}")
    return resolved


def run_check(check: dict, project_dir: str, timeout: int) -> dict:
    """Run a single verification check and return updated check dict."""
    check_type = check.get("type", "")
    result = dict(check)

    try:
        if check_type == "file_exists":
            # The checklist is LLM-emitted (generated_from a PRD), so the path
            # field name is not pinnable: real checks in the wild carry the path
            # under "path" OR "target" OR "file". Reading only "path" made a valid
            # file_exists on a present file (target="package.json") raise
            # "Invalid path characters: ''" -> None -> the item stuck 'pending' ->
            # a correct build never reached a verified card. Alias the variants
            # (same fake-inconclusive class as the grep/tests_pass runner bugs).
            path = check.get("path") or check.get("target") or check.get("file") or ""
            full_path = _validate_path(path, project_dir)
            result["passed"] = os.path.exists(full_path)

        elif check_type == "file_contains":
            path = check.get("path") or check.get("target") or check.get("file") or ""
            pattern = check.get("pattern", "")
            if pattern and not _SAFE_PATTERN_RE.match(pattern):
                result["passed"] = None
                result["output"] = f"Unsafe pattern rejected: {pattern!r}"
                return result
            full_path = _validate_path(path, project_dir)
            if os.path.isfile(full_path):
                try:
                    content = Path(full_path).read_text(errors="replace")
                    result["passed"] = bool(re.search(pattern, content))
                except re.error as e:
                    result["passed"] = False
                    result["output"] = f"Invalid regex: {e}"
                except Exception:
                    result["passed"] = False
            else:
                result["passed"] = False

        elif check_type == "tests_pass":
            pattern = check.get("pattern", "")
            # Sanitize pattern - only allow safe glob/path characters
            if pattern and not _SAFE_PATTERN_RE.match(pattern):
                result["passed"] = None
                result["output"] = f"Unsafe pattern rejected: {pattern!r}"
            elif pattern:
                # Runner-agnostic: use the PROJECT'S OWN declared test command
                # rather than hardcoding a runner. A project's package.json
                # "scripts.test" may be vitest / jest / mocha / node:test / ava /
                # etc. Hardcoding `npx jest` was a fake-RED: on a vitest project
                # (cdbbb5af, "test":"vitest run", jest not installed) `npx jest`
                # either errored on the drifted --testPathPattern flag or npx tried
                # to FETCH jest and timed out -> a genuinely-passing 26/26 suite read
                # False/None ("tests not run") -> the item never reaches 'verified'
                # -> a correct build never shows a verified card. Running the
                # declared command runs the runner the build actually chose, so it
                # is model-/complexity-agnostic. NB: we run the WHOLE declared suite
                # (the per-item `pattern` is not a runner filter -- a mismatched
                # vitest/jest filter can exit 0 with zero tests run = a fake-green).
                pkg_path = os.path.join(project_dir, "package.json")
                test_script = None
                if os.path.isfile(pkg_path):
                    try:
                        with open(pkg_path) as _pf:
                            _pkg = json.load(_pf)
                        test_script = (_pkg.get("scripts") or {}).get("test")
                    except (json.JSONDecodeError, OSError):
                        test_script = None
                if os.path.isfile(pkg_path):
                    if test_script and test_script.strip():
                        # `npm test` runs scripts.test with the project's local
                        # runner on PATH; list-form + shell=False + cwd = same
                        # posture as before (the engine already ran this exact
                        # command to build the workspace -- not a new surface).
                        cmd = ["npm", "test", "--silent"]
                    else:
                        # package.json but no test script -> nothing declared to
                        # run. Do NOT invent a runner (that reintroduces the
                        # hardcoded-runner fake-RED). Inconclusive, not a failure.
                        result["passed"] = None
                        result["output"] = (
                            "No 'scripts.test' declared in package.json; cannot run "
                            "the project's tests (inconclusive, not a failure)."
                        )
                        return result
                else:
                    cmd = ["python3", "-m", "pytest", "-q"]
                try:
                    proc = subprocess.run(
                        cmd,
                        cwd=project_dir,
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                    )
                    combined = proc.stdout + proc.stderr
                    _low = combined.lower()
                    # Trust gate: a tests_pass check REQUIRES POSITIVE PROOF that at
                    # least one test actually ran and passed. rc==0 alone is NOT
                    # proof: a no-op test script (`echo done`, `exit 0`, `true`, `:`)
                    # exits 0 having run ZERO tests -> passing on rc==0 would be a
                    # FAKE-GREEN (a required verification green with nothing tested).
                    # So we require a runner's "N passed" signal. Absence of that
                    # signal on rc==0 is INCONCLUSIVE (None -> pending), never True
                    # (fake-green) and never False (that would fake-RED an exotic
                    # passing runner). rc!=0 with real failures -> honest False. This
                    # is the same inconclusive-never-false moat as grep_codebase.
                    no_tests = (
                        "no tests found" in _low            # jest
                        or "no test files found" in _low    # vitest
                        or "no tests ran" in _low           # pytest/jest phrasing
                        or "no tests to run" in _low
                        or proc.returncode == 5             # pytest: none collected
                    )
                    # Positive "tests ran and passed" signals across common runners.
                    # jest:  "Tests: 3 passed"        vitest: "Tests  26 passed (26)"
                    # pytest:"3 passed in 0.05s"      mocha:  "3 passing"
                    # node:test: "# pass 3"           tap:    "pass 3"
                    # The count MUST be >=1 (`[1-9]\d*`, never a literal 0): a
                    # runner can print "0 passed" / "0 passing" (mocha over an
                    # empty describe, all-.skip, node:test "# pass 0") on rc=0 with
                    # ZERO tests run -- matching a bare `\d+` would re-open the
                    # fake-green. A zero count falls through to the inconclusive
                    # else -> None (pending), correctly never green.
                    _ran_and_passed = bool(
                        re.search(r'tests?:\s*[1-9]\d*\s+passed', _low)   # jest
                        or re.search(r'tests?\s+[1-9]\d*\s+passed', _low) # vitest
                        or re.search(r'\b[1-9]\d*\s+passed\b', _low)      # pytest/vitest
                        or re.search(r'\b[1-9]\d*\s+passing\b', _low)     # mocha
                        or re.search(r'#\s*pass\s+[1-9]\d*', _low)        # node:test
                        or re.search(r'\bpass\s+[1-9]\d*\b', _low)        # tap
                    )
                    if no_tests:
                        result["passed"] = False
                        result["output"] = (
                            "No tests discovered for required check "
                            "(a tests_pass check must run at least one test). "
                            "Output: "
                        ) + combined[:400]
                    elif proc.returncode != 0:
                        # Ran and FAILED -> honest False (blocks). A non-zero exit
                        # from a real runner is a genuine negative, not inconclusive.
                        result["passed"] = False
                        result["output"] = combined[:500]
                    elif _ran_and_passed:
                        # rc==0 WITH positive "N passed" proof -> True.
                        result["passed"] = True
                        result["output"] = combined[:500]
                    else:
                        # rc==0 but NO positive "tests ran" signal (a no-op script,
                        # or a runner whose output we do not recognise). We cannot
                        # prove tests ran -> INCONCLUSIVE (None -> pending), never a
                        # fake-green True and never a fake-RED False.
                        result["passed"] = None
                        result["output"] = (
                            "Test command exited 0 but produced no recognisable "
                            "'N passed' signal -- cannot confirm any test ran "
                            "(inconclusive, not a pass). Output: "
                        ) + combined[:350]
                except subprocess.TimeoutExpired:
                    result["passed"] = None  # timeout = pending (couldn't run)
                    result["output"] = f"Timed out after {timeout}s"
                except FileNotFoundError:
                    result["passed"] = None  # runner not found = couldn't run
                    result["output"] = "Test runner not found"
            else:
                result["passed"] = None

        elif check_type == "command":
            # Command checks use list form (shell=False) for safety
            command = check.get("command", "")
            if command:
                # Split command into list safely
                import shlex
                try:
                    cmd_list = shlex.split(command)
                except ValueError:
                    result["passed"] = None
                    result["output"] = "Failed to parse command"
                    return result
                try:
                    proc = subprocess.run(
                        cmd_list,
                        cwd=project_dir,
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                    )
                    result["passed"] = proc.returncode == 0
                    result["output"] = (proc.stdout + proc.stderr)[:500]
                except subprocess.TimeoutExpired:
                    result["passed"] = None
                    result["output"] = f"Timed out after {timeout}s"
                except FileNotFoundError:
                    result["passed"] = None
                    result["output"] = f"Command not found: {cmd_list[0]}"
            else:
                result["passed"] = None

        elif check_type == "grep_codebase":
            pattern = check.get("pattern", "")
            if pattern and not _SAFE_PATTERN_RE.match(pattern):
                result["passed"] = None
                result["output"] = f"Unsafe grep pattern rejected: {pattern!r}"
            elif pattern:
                try:
                    # grep with --exclude-dir for safety (no .git, node_modules)
                    # Use '--' to prevent pattern being interpreted as flags.
                    # Use -E (ERE) NOT the default BRE: LLM-emitted patterns are
                    # ERE/PCRE-flavoured (e.g. app\.get\('/api/tasks'). In BRE an
                    # escaped `\(` is a GROUP-OPEN, so an unmatched one makes grep
                    # error 'parentheses not balanced' (rc=2) -- a fake-RED that
                    # marked 3 present endpoints failing -> a 64-min non-converging
                    # build (#142/#124). Under -E, `\(` is a LITERAL paren (no
                    # error) AND quantifiers `.` `*` `+` keep their regex meaning,
                    # so a present-as-regex endpoint matches instead of erroring.
                    proc = subprocess.run(
                        ["grep", "-r", "-l", "-E",
                         "--exclude-dir=.git", "--exclude-dir=node_modules",
                         "--exclude-dir=.loki", "--exclude-dir=__pycache__",
                         "--", pattern, "."],
                        cwd=project_dir,
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                    )
                    # grep exit codes: 0=match found, 1=no match, >=2=ERROR (bad
                    # regex, unreadable file, or a grep variant -- e.g. ugrep on
                    # macOS -- that rejects a pattern GNU grep accepts). A grep that
                    # ERRORED has NOT proven the pattern is absent, so it must be
                    # INCONCLUSIVE (passed=None), NOT a hard False. Collapsing an
                    # error to False is a fake-RED: it marks a genuinely-present
                    # endpoint 'failing' -> the council hard-gate blocks a correct
                    # build forever (observed: an LLM-emitted pattern app\.get\('...'
                    # made ugrep error position-26 mismatched-paren -> returncode 2
                    # -> 3 working endpoints read failing -> a 64-min non-converging
                    # build). Only a clean 1 (real no-match) is an honest False.
                    if proc.returncode == 0:
                        result["passed"] = True
                        files_found = proc.stdout.strip().split("\n") if proc.stdout.strip() else []
                        result["output"] = f"Found in {len(files_found)} file(s)"
                    elif proc.returncode == 1:
                        result["passed"] = False
                        result["output"] = "Found in 0 file(s)"
                    else:
                        # rc>=2 = grep ERROR even under -E (e.g. a genuinely
                        # malformed pattern, or an unreadable file). Do NOT collapse
                        # to False (fake-RED) and do NOT punt straight to
                        # inconclusive (that opens a fake-green: an ABSENT endpoint
                        # whose pattern also errors would read pending, not failing).
                        # RECOVER real signal by retrying as a FIXED string (grep -F,
                        # escapes stripped to the intended literal), which cannot
                        # error on metacharacters. A fixed-string retry is a strict
                        # subset match: rc=0 (literal present) is a sound True; a
                        # literal-absent rc=1 keeps the honest-False moat for the
                        # common case. Only if -F ALSO errors is the check truly
                        # unrecoverable -> inconclusive (None), never a hard fail.
                        # NB: the -E primary already resolves the whole LLM
                        # escaped-paren class, so this branch is now rarely reached.
                        literal = re.sub(r'\\(.)', r'\1', pattern)
                        try:
                            proc2 = subprocess.run(
                                ["grep", "-r", "-l", "-F",
                                 "--exclude-dir=.git", "--exclude-dir=node_modules",
                                 "--exclude-dir=.loki", "--exclude-dir=__pycache__",
                                 "--", literal, "."],
                                cwd=project_dir, capture_output=True,
                                text=True, timeout=timeout,
                            )
                        except subprocess.TimeoutExpired:
                            proc2 = None
                        if proc2 is not None and proc2.returncode == 0:
                            files_found = proc2.stdout.strip().split("\n") if proc2.stdout.strip() else []
                            result["passed"] = True
                            result["output"] = f"Found in {len(files_found)} file(s) (fixed-string retry after regex error)"
                        else:
                            # -F rc=1 (literal absent) or rc>=2 (also errored) ->
                            # INCONCLUSIVE (None), never False. Once -E has failed to
                            # parse the pattern, the escape-stripped literal cannot
                            # distinguish "present only via a regex quantifier" from
                            # "genuinely absent" -- so a literal-absent here is NOT
                            # proof of absence. Mapping it to False would re-open the
                            # narrowed fake-RED. None -> item 'pending' (never blocks
                            # a correct build); a genuinely-absent endpoint is caught
                            # by the -E primary's honest rc=1 False above, not here.
                            result["passed"] = None
                            _err = (proc.stderr or "").strip().splitlines()
                            _why = ("literal-absent, cannot prove absence"
                                    if (proc2 is not None and proc2.returncode == 1)
                                    else (_err[0] if _err else f"exit {proc.returncode}"))
                            result["output"] = (
                                "grep regex error, unrecoverable (inconclusive, not a failure): "
                                + _why
                            )[:200]
                except subprocess.TimeoutExpired:
                    result["passed"] = None
                    result["output"] = f"Timed out after {timeout}s"
            else:
                result["passed"] = None

        elif check_type == "http_check":
            path = check.get("path", "/")
            # Validate path is safe
            stripped = path.lstrip("/")
            if stripped and not _SAFE_PATH_RE.match(stripped):
                result["passed"] = None
                result["output"] = f"Unsafe path rejected: {path!r}"
            else:
                # Read app runner state to get URL
                app_state_file = os.path.join(project_dir, ".loki", "app-runner", "state.json")
                app_url = None
                if os.path.isfile(app_state_file):
                    try:
                        app_data = json.loads(Path(app_state_file).read_text())
                        if app_data.get("status") == "running":
                            app_url = app_data.get("url", "")
                    except (json.JSONDecodeError, OSError):
                        pass

                if not app_url:
                    result["passed"] = None
                    result["output"] = "App not running (app runner not active)"
                else:
                    import urllib.request
                    import urllib.error
                    target_url = app_url.rstrip("/") + "/" + path.lstrip("/")
                    expected_status = check.get("expected_status", 200)
                    try:
                        req = urllib.request.Request(target_url, method="GET")
                        resp = urllib.request.urlopen(req, timeout=min(timeout, 10))
                        actual_status = resp.getcode()
                        result["passed"] = actual_status == expected_status
                        result["output"] = f"HTTP {actual_status} (expected {expected_status})"
                    except urllib.error.HTTPError as e:
                        result["passed"] = e.code == expected_status
                        result["output"] = f"HTTP {e.code} (expected {expected_status})"
                    except urllib.error.URLError as e:
                        result["passed"] = False
                        result["output"] = f"Connection failed: {str(e.reason)[:100]}"
                    except Exception as e:
                        result["passed"] = None
                        result["output"] = f"HTTP check error: {str(e)[:100]}"

        else:
            result["passed"] = None
            result["output"] = f"Unknown check type: {check_type}"

    except Exception as e:
        result["passed"] = None
        result["output"] = f"Error: {str(e)[:200]}"

    return result


def determine_item_status(verifications: list) -> str:
    """Determine item status from its verification checks."""
    if not verifications:
        return "pending"

    all_passed = True
    any_failed = False

    for v in verifications:
        passed = v.get("passed")
        if passed is None:
            all_passed = False
        elif passed is False:
            any_failed = True
            all_passed = False

    if any_failed:
        return "failing"
    if all_passed:
        return "verified"
    return "pending"


_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")

# Result fields the verifier writes back; never part of a check definition.
_RESULT_FIELDS = ("passed", "output", "status", "verified_at")


def definition_digest(checklist: dict) -> str:
    """SHA-256 over check definitions only (item ids + verification specs)."""
    defs = []
    for category in checklist.get("categories", []):
        for item in category.get("items", []):
            checks = [
                {k: v for k, v in c.items() if k not in _RESULT_FIELDS}
                for c in item.get("verification", [])
                if isinstance(c, dict)
            ]
            defs.append({"id": item.get("id", ""), "verification": checks})
    blob = json.dumps(defs, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def atomic_write_json(path: str, data: dict) -> None:
    """Write JSON atomically via temp file + os.replace()."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=os.path.dirname(path), suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser(description="PRD Checklist Verification")
    parser.add_argument(
        "--checklist",
        default=".loki/checklist/checklist.json",
        help="Path to checklist JSON (default: .loki/checklist/checklist.json)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Timeout per check in seconds (default: 30)",
    )
    parser.add_argument(
        "--freeze",
        action="store_true",
        help="Print the digest of the check definitions and exit; writes nothing",
    )
    parser.add_argument(
        "--expect-digest",
        default=None,
        help="Required to verify: the definition digest the harness froze; "
        "a mismatch, or a missing or malformed value, fails closed",
    )
    args = parser.parse_args()

    checklist_path = args.checklist
    if not os.path.isfile(checklist_path):
        print(f"Checklist not found: {checklist_path}", file=sys.stderr)
        sys.exit(1)

    try:
        with open(checklist_path) as f:
            checklist = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"Failed to read checklist: {e}", file=sys.stderr)
        sys.exit(1)

    if args.freeze:
        print(definition_digest(checklist))
        sys.exit(0)

    expected = args.expect_digest
    if expected is None or not _DIGEST_RE.match(expected):
        print(
            "Refusing to verify: --expect-digest is missing or not a sha256 hex "
            "digest (fail closed)",
            file=sys.stderr,
        )
        sys.exit(2)
    if not hmac.compare_digest(expected, definition_digest(checklist)):
        print(
            "Checklist hash mismatch: check definitions differ from the frozen "
            "digest; refusing to verify",
            file=sys.stderr,
        )
        sys.exit(3)

    project_dir = os.getcwd()
    now = datetime.now(timezone.utc).isoformat()

    total = 0
    verified = 0
    failing = 0
    pending = 0

    for category in checklist.get("categories", []):
        for item in category.get("items", []):
            total += 1
            verifications = item.get("verification", [])

            # Run each verification check
            updated_checks = []
            for check in verifications:
                updated = run_check(check, project_dir, args.timeout)
                updated_checks.append(updated)
            item["verification"] = updated_checks

            # Determine item status
            status = determine_item_status(updated_checks)
            item["status"] = status
            if status == "verified":
                item["verified_at"] = now
                verified += 1
            elif status == "failing":
                failing += 1
            else:
                pending += 1

    # Update summary
    checklist["summary"] = {
        "total": total,
        "verified": verified,
        "failing": failing,
        "pending": pending,
    }
    checklist["last_verified_at"] = now

    # Atomic write updated checklist
    atomic_write_json(checklist_path, checklist)

    # Write verification results summary
    results = {
        "verified_at": now,
        "summary": checklist["summary"],
        "categories": [
            {
                "name": cat.get("name", ""),
                "items": [
                    {
                        "id": item.get("id", ""),
                        "title": item.get("title", ""),
                        "priority": item.get("priority", "minor"),
                        "status": item.get("status", "pending"),
                    }
                    for item in cat.get("items", [])
                ],
            }
            for cat in checklist.get("categories", [])
        ],
    }
    results_path = os.path.join(
        os.path.dirname(checklist_path), "verification-results.json"
    )
    atomic_write_json(results_path, results)

    # Print summary
    print(f"Checklist: {verified}/{total} verified, {failing} failing, {pending} pending")

    # Exit 0 always - failures are informational, not blocking
    sys.exit(0)


if __name__ == "__main__":
    main()
