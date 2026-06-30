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
    python3 checklist-verify.py [--checklist PATH] [--timeout SECS]
"""

import argparse
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
            path = check.get("path", "")
            full_path = _validate_path(path, project_dir)
            result["passed"] = os.path.exists(full_path)

        elif check_type == "file_contains":
            path = check.get("path", "")
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
                # Use list form (shell=False) to prevent injection
                if os.path.isfile(os.path.join(project_dir, "package.json")):
                    cmd = ["npx", "jest", "--testPathPattern", pattern, "--passWithNoTests"]
                else:
                    cmd = ["python3", "-m", "pytest", "-q", pattern]
                try:
                    proc = subprocess.run(
                        cmd,
                        cwd=project_dir,
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                    )
                    combined = proc.stdout + proc.stderr
                    # Trust gate: a tests_pass check REQUIRES that at least one
                    # test was actually discovered and run. jest is invoked with
                    # --passWithNoTests, so a zero-match pattern exits 0 ("No
                    # tests found ...") -- that would be a fake-green (a required
                    # verification passing with nothing run). pytest exits 5 when
                    # it collects no tests. Detect either no-test signal and fail
                    # the check rather than report success on an empty run.
                    no_tests = (
                        "No tests found" in combined
                        or "no tests ran" in combined.lower()
                        or "no tests to run" in combined.lower()
                        or proc.returncode == 5  # pytest: no tests collected
                    )
                    if no_tests:
                        result["passed"] = False
                        result["output"] = (
                            "No tests discovered for required check "
                            f"(pattern={pattern!r}); a tests_pass check must run "
                            "at least one test. Output: "
                        ) + combined[:400]
                    else:
                        result["passed"] = proc.returncode == 0
                        result["output"] = combined[:500]
                except subprocess.TimeoutExpired:
                    result["passed"] = None  # timeout = pending
                    result["output"] = f"Timed out after {timeout}s"
                except FileNotFoundError:
                    result["passed"] = None
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
                    # Use '--' to prevent pattern being interpreted as flags
                    proc = subprocess.run(
                        ["grep", "-r", "-l",
                         "--exclude-dir=.git", "--exclude-dir=node_modules",
                         "--exclude-dir=.loki", "--exclude-dir=__pycache__",
                         "--", pattern, "."],
                        cwd=project_dir,
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                    )
                    result["passed"] = proc.returncode == 0
                    files_found = proc.stdout.strip().split("\n") if proc.stdout.strip() else []
                    result["output"] = f"Found in {len(files_found)} file(s)"
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
