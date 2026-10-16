#!/usr/bin/env python3
"""
trigger-server.py - GitHub webhook receiver for loki-mode event-driven execution.

Listens for GitHub webhook events and automatically runs `loki start` in
response. Supports constant-time HMAC-SHA256 signature validation, a bounded
worker queue so a webhook storm cannot fork unbounded builds, child-process
reaping (no zombies), and event logging.

Also serves an authenticated remote-submit API so a local `loki` client can
enqueue a build against a deployed cluster:

    POST /jobs           {"spec": "<ref-or-brief>"}  -> 202 {"id": ...}
    GET  /jobs/<id>                                  -> job status
    GET  /jobs/<id>/proof                            -> that job's Evidence Receipt

Security note: a webhook secret is REQUIRED. If no secret is configured the
server still starts (so /health and /status stay available for operators), but
every webhook POST is rejected with 503 and an audit log line. The server never
silently accepts unauthenticated webhooks.

The SAME rule holds for the /jobs API, with a SEPARATE credential: it is
authenticated by a bearer token (LOKI_API_TOKEN / LOKI_API_TOKEN_FILE), never by
the webhook HMAC. The two have different threat models -- the HMAC authenticates
GitHub, the bearer token authenticates a human operator -- so holding one must
never grant the other. If no API token is configured the server still starts but
every /jobs request is rejected with 503 and an audit log line.

Self-healing entry point: POST /sentry accepts a Sentry integration webhook
authenticated by Sentry's own HMAC (sentry-hook-signature) under a THIRD,
separate secret (LOKI_SENTRY_WEBHOOK_SECRET or SENTRY_CLIENT_SECRET). A valid
alert enqueues `loki start "<normalized brief>" --pr --detach`: the output is a
receipt-gated PR only, never a deploy. No secret means the route answers 503.

Usage:
    python3 autonomy/trigger-server.py [--port PORT] [--secret SECRET] [--dry-run]
                                       [--workers N] [--queue-size N]
"""

import argparse
import base64
import collections
import hashlib
import hmac
import http.server
import json
import logging
import os
import queue
import re
import secrets
import signal
import socket
import socketserver
import subprocess
import tempfile
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

# Receipt attestation. Imported by path because trigger-server.py runs as a
# script from an arbitrary cwd, so a bare `import receipt_jwt` would depend on
# the caller's directory. An ImportError is NOT fatal: signing is optional, and
# a server that refused to start without it would turn an optional feature into
# a hard dependency on `cryptography`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from receipt_jwt import (
        build_jwks,
        load_retired_public_keys,
        load_signing_key,
        sign_attestation,
    )
    _ATTESTATION_AVAILABLE = True
except ImportError:  # pragma: no cover - only on a stripped install
    _ATTESTATION_AVAILABLE = False

    def build_jwks(private_key=None, retired_public_keys=None):
        return {"keys": []}

    def load_signing_key(auto_generate=True):
        return None, ""

    def load_retired_public_keys():
        return []

    def sign_attestation(*_a, **_k):
        return ""


# A GitHub repository full_name is "owner/repo". Both segments are restricted to
# the characters GitHub itself allows (letters, digits, dot, underscore, dash).
# We validate against this before ever placing a webhook-supplied value into the
# `loki start <ref>` argv. Without this guard a payload whose repository
# full_name begins with "--" (e.g. "--config=/etc/x") would inject a CLI FLAG
# into `loki start` post-HMAC, breaking the "a webhook can only start a build
# for ref X" boundary. The ref we build ("owner/repo#N") therefore can never
# begin with a dash, so it can never be parsed as an option.
REPO_FULL_NAME_RE = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._-]*/[A-Za-z0-9._-]+$")

# Bound the body read so a slow/under-delivered POST cannot tie up a worker
# thread before authentication (slow-loris). A stalled client is dropped.
BODY_READ_TIMEOUT_SECONDS = 15


def valid_repo_full_name(repo_full_name):
    """Return True if repo_full_name is a safe "owner/repo" string.

    Rejects empty, malformed, or dash-leading values so a webhook-controlled
    repository name can never be parsed as a `loki start` CLI flag.
    """
    return bool(repo_full_name) and bool(REPO_FULL_NAME_RE.match(repo_full_name))


def valid_issue_number(number):
    """Return True if number is a positive integer (issue/PR number).

    GitHub sends these as JSON integers. A non-int (or a string smuggled in via
    a crafted payload) is rejected so only a clean integer reaches the ref.
    """
    return isinstance(number, int) and not isinstance(number, bool) and number > 0


# Remote-submit ("/jobs") limits. A remotely-submitted spec is UNTRUSTED input:
# it is passed to `loki start` as a single argv element (never a shell string),
# and must additionally survive the same rigor as REPO_FULL_NAME_RE above.
MAX_SPEC_BYTES = 4096

# Control characters are rejected outright: a spec is a ref, path or one-line
# brief, so NUL/CR/LF/ESC in it is either an injection attempt or a mistake.
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")

# Pseudo-event name for a remotely-submitted job. Deliberately NOT a GitHub
# event name, and explicitly refused on the /webhook path (see do_POST): a
# holder of the webhook HMAC must never be able to submit an arbitrary spec by
# sending X-GitHub-Event: loki_job. That is the whole point of the separate
# credential.
JOB_EVENT = "loki_job"

# How many recent job records to keep for GET /jobs/<id>. Bounded so a submit
# storm cannot grow memory without limit.
DEFAULT_JOB_HISTORY = 1024

# Terminal job statuses a remote client can gate on. "queued" and "running"
# are deliberately absent: a client must be able to tell "not done yet" from
# "done and failed", which a single non-passed value could not express.
#
# Only JOB_STATUS_PASSED means the build itself succeeded. JOB_STATUS_UNKNOWN
# means the build detached past our wait window and its exit code was never
# observed -- an unobserved outcome is NOT a pass, and the client exits
# non-zero on it (fail closed).
JOB_STATUS_PASSED = "passed"
JOB_STATUS_FAILED = "failed"
JOB_STATUS_UNKNOWN = "unknown"
JOB_TERMINAL_STATUSES = (JOB_STATUS_PASSED, JOB_STATUS_FAILED, JOB_STATUS_UNKNOWN)

# A run id names a directory under .loki/proofs/. run.sh mints it as
# "run-<utc>-<pid>-<rand>" or "proof-<utc>-<pid>-<rand>"; this is the alphabet
# those forms use. Applied to the pointer file's contents (never to a request
# path) so a corrupt pointer cannot name an arbitrary path.
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def valid_spec(spec):
    """Return True if spec is a safe `loki start` argument.

    Must be a non-empty str (a dict/list/int is rejected outright rather than
    coerced, exactly like valid_issue_number), within the size cap, free of
    control characters, and not dash-leading -- a leading dash would be parsed
    by `loki start` as a CLI FLAG, the same injection REPO_FULL_NAME_RE guards
    against on the webhook path.
    """
    if not isinstance(spec, str):
        return False
    spec = spec.strip()
    if not spec:
        return False
    if len(spec.encode("utf-8")) > MAX_SPEC_BYTES:
        return False
    if CONTROL_CHARS_RE.search(spec):
        return False
    if spec.startswith("-"):
        return False
    return True


def constant_time_equals(a, b):
    """Constant-time string compare that never raises on odd input.

    hmac.compare_digest raises TypeError on a non-ASCII str, so both sides are
    encoded to bytes first: a weird header must produce a 401, not a 500.
    """
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# How long to wait for a dispatched `loki start` to finish before we stop
# waiting on it. The child is launched detached (--detach) so it backgrounds
# itself quickly; this bound only guards the worker thread against a wedged
# launch. The child keeps running independently after we stop waiting.
DISPATCH_WAIT_SECONDS = 30

# Defaults for the bounded worker queue.
DEFAULT_WORKERS = 4
DEFAULT_QUEUE_SIZE = 64

# How many recent GitHub delivery IDs to remember for idempotency.
DEFAULT_DEDUP_SIZE = 2048


def get_loki_dir():
    """Return .loki/triggers directory, creating it if needed."""
    loki_dir = Path(".loki") / "triggers"
    loki_dir.mkdir(parents=True, exist_ok=True)
    return loki_dir


def read_proof_pointer():
    """Return the run id in .loki/state/last-proof-id.txt, or "" if absent.

    run.sh's generate_proof_of_run writes this pointer atomically after emitting
    a receipt, naming the directory it wrote (.loki/proofs/<run_id>/). It is the
    ONLY durable link from a finished build to its proof: the run id is minted
    inside run.sh and is deliberately NOT derivable from LOKI_SESSION_ID (the
    persisted per-run id file wins over the env var), so the server cannot
    predict it and must observe it instead.

    The pointer is global to the working directory and is not written at all
    when LOKI_PROVEN_PR=0. Both cases are handled by the caller, which fails
    closed rather than guessing.
    """
    try:
        return Path(".loki/state/last-proof-id.txt").read_text(
            encoding="utf-8"
        ).strip()
    except (OSError, UnicodeDecodeError):
        return ""


def read_proof(run_id):
    """Return the parsed proof.json for run_id, or None if unreadable.

    run_id comes from the server-written pointer above, never from a request
    path, so there is no traversal sink here. It is still constrained to the
    id alphabet as defense in depth, since a corrupt pointer file must not be
    able to name an arbitrary path.
    """
    # RUN_ID_RE alone is not enough: it permits "." and "..", and ".." would
    # resolve to .loki/proof.json, one level above the proofs directory. The
    # dot-forms are rejected outright and the resolved path is then confined
    # under .loki/proofs, so no run id -- however corrupt -- escapes it.
    if not run_id or run_id in (".", "..") or not RUN_ID_RE.match(run_id):
        return None
    proofs_root = (Path(".loki") / "proofs").resolve()
    target = (proofs_root / run_id / "proof.json").resolve()
    if proofs_root not in target.parents:
        return None
    try:
        with open(target) as f:
            data = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def load_config():
    """Load trigger config from .loki/triggers/config.json."""
    config_path = get_loki_dir() / "config.json"
    defaults = {
        "port": 7373,
        "secret": "",
        "dry_run": False,
        "enabled_events": ["issues", "pull_request", "workflow_run"],
        "workers": DEFAULT_WORKERS,
        "queue_size": DEFAULT_QUEUE_SIZE,
    }
    if config_path.exists():
        try:
            with open(config_path) as f:
                stored = json.load(f)
            defaults.update(stored)
        except (json.JSONDecodeError, OSError):
            pass
    return defaults


def load_api_token():
    """Return the /jobs bearer token from env or a mounted file ("" if unset).

    Sources, in order: LOKI_API_TOKEN, then the file at LOKI_API_TOKEN_FILE
    (the normal Kubernetes mounted-secret path). Deliberately NOT a CLI flag --
    an argv secret is readable by any local user via the process list -- and
    never persisted to config.json.

    A mounted secret file usually ends with a newline, so the contents are
    stripped; otherwise every comparison would fail.
    """
    token = os.environ.get("LOKI_API_TOKEN", "").strip()
    if token:
        return token
    token_file = os.environ.get("LOKI_API_TOKEN_FILE", "").strip()
    if token_file:
        try:
            return Path(token_file).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError) as e:
            logging.error("Failed to read LOKI_API_TOKEN_FILE %s: %s", token_file, e)
    return ""


def save_config(config):
    """Save trigger config to .loki/triggers/config.json."""
    config_path = get_loki_dir() / "config.json"
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)


# log_event writes append lines to a shared file from multiple worker threads,
# so serialize writes to avoid interleaved JSON lines.
_log_lock = threading.Lock()


def _utc_now():
    """UTC timestamp string shared by the event log and job records."""
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def log_event(event_type, action, payload_summary, status):
    """Append event to .loki/triggers/events.log (thread-safe)."""
    log_path = get_loki_dir() / "events.log"
    timestamp = _utc_now()
    entry = {
        "timestamp": timestamp,
        "event": event_type,
        "action": action,
        "summary": payload_summary,
        "status": status,
    }
    line = json.dumps(entry) + "\n"
    with _log_lock:
        with open(log_path, "a") as f:
            f.write(line)


def validate_signature(secret, body, signature_header):
    """Validate GitHub HMAC-SHA256 webhook signature (constant-time).

    Returns False when no secret is configured: an unauthenticated webhook is
    never considered valid. The caller is responsible for refusing to dispatch
    when no secret is set; this function only answers "is this request proven
    to come from someone holding the secret?".
    """
    if not secret:
        return False
    if not signature_header:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()
    # compare_digest is constant-time and tolerates unequal-length inputs.
    return hmac.compare_digest(expected, signature_header)


def send_notification(message):
    """Send desktop notification via loki syslog. Reaps the child itself."""
    try:
        subprocess.run(
            ["loki", "syslog", message],
            timeout=5,
            capture_output=True,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass


def _reap_child(proc):
    """Wait on a child process so it is always reaped (no zombie).

    Used when the dispatch outlives our synchronous wait window: instead of
    abandoning the child (which would leave a zombie until this process exits),
    a one-shot daemon thread blocks on wait() until the child finishes. Errors
    are swallowed because the only goal is to drain the child's exit status.

    Daemon threads must not write to stdout to avoid blocking the interpreter
    shutdown with closed-pipe issues; logging goes to stderr only.
    """
    try:
        proc.wait()
    except Exception:
        pass


# Outcome of a dispatch, as distinct from "did it launch".
#
# run_loki_command already distinguished all three of these and then threw two
# of them away by returning a bool. Collapsing "exited 0" and "still detached"
# into True is what made a remotely-submitted build that STARTS and then FAILS
# report success: the client had no value to gate on. UNKNOWN is not a pass --
# an outcome we could not observe must fail closed.
# ponytail: the outcome IS the terminal job status, so they are the same three
# strings rather than two enums plus a mapping table.
OUTCOME_PASSED = JOB_STATUS_PASSED    # ran to completion and exited 0
OUTCOME_FAILED = JOB_STATUS_FAILED    # launch failed, or exited non-zero
OUTCOME_UNKNOWN = JOB_STATUS_UNKNOWN  # detached; exit code never observed


# Secrets this server holds that a spawned `loki start` must never inherit: a
# prompt-injected run could otherwise forge /sentry, /webhook or /jobs requests.
CHILD_ENV_DENYLIST = (
    "GITHUB_WEBHOOK_SECRET",
    "LOKI_API_TOKEN",
    "LOKI_API_TOKEN_FILE",
    "LOKI_SENTRY_WEBHOOK_SECRET",
    "SENTRY_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "SLACK_BOT_TOKEN",
    "LINEAR_WEBHOOK_SECRET",
    "LINEAR_API_KEY",
    "JIRA_WEBHOOK_SECRET",
    "JIRA_API_TOKEN",
    "TEAMS_SECURITY_TOKEN",
)


def _scoped_child_env():
    return {k: v for k, v in os.environ.items() if k not in CHILD_ENV_DENYLIST}


def run_loki_outcome(args, dry_run=False):
    """Run a loki command and report WHICH of the three outcomes occurred.

    Returns one of OUTCOME_PASSED / OUTCOME_FAILED / OUTCOME_UNKNOWN. This is
    the honest version of run_loki_command, which answers only "did it launch".
    """
    cmd = ["loki"] + args
    if dry_run:
        logging.info("[DRY-RUN] Would run: %s", " ".join(cmd))
        return OUTCOME_PASSED
    logging.info("Running: %s", " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_scoped_child_env(),
        )
    except (FileNotFoundError, OSError) as e:
        logging.error("Failed to launch %s: %s", " ".join(cmd), e)
        return OUTCOME_FAILED

    try:
        _, stderr = proc.communicate(timeout=DISPATCH_WAIT_SECONDS)
    except subprocess.TimeoutExpired:
        # Detached past the wait window. The reaper collects the child, but we
        # never see its exit code, so the outcome is genuinely UNKNOWN -- NOT a
        # pass. Reporting success here is exactly the defect this replaces.
        logging.info(
            "Dispatch pid=%d still running after %ds; reaping in background",
            proc.pid,
            DISPATCH_WAIT_SECONDS,
        )
        threading.Thread(
            target=_reap_child,
            args=(proc,),
            name="loki-trigger-reaper-%d" % proc.pid,
            daemon=True,
        ).start()
        return OUTCOME_UNKNOWN

    if proc.returncode == 0:
        logging.info("Dispatch pid=%d completed (exit 0)", proc.pid)
        return OUTCOME_PASSED

    stderr_text = ""
    if stderr:
        stderr_text = stderr.decode("utf-8", errors="replace").strip()
    logging.error(
        "Dispatch pid=%d exited %d: %s",
        proc.pid,
        proc.returncode,
        stderr_text or "(no stderr)",
    )
    return OUTCOME_FAILED


def run_loki_command(args, dry_run=False):
    """Run a loki command synchronously and reap it; or print it if dry_run.

    Returns True if the command was launched and exited 0 (or backgrounded
    cleanly within the wait window), False if the launch failed or it exited
    non-zero. The child is always waited on, so no zombies accumulate. stderr
    is captured on failure so a broken dispatch is diagnosable.

    This is invoked from worker threads, so blocking here does not block the
    HTTP listener.

    Kept as the bool view for the GitHub webhook handlers, which only care
    whether a dispatch started. A caller that must know whether the BUILD
    passed wants run_loki_outcome instead. Behaviour is unchanged: a detached
    dispatch (UNKNOWN) still reads as True here, exactly as before.
    """
    return run_loki_outcome(args, dry_run=dry_run) in (
        OUTCOME_PASSED, OUTCOME_UNKNOWN,
    )


TRUSTED_ASSOCIATIONS = ("OWNER", "MEMBER", "COLLABORATOR")  # same set as verify_pr.ts
STEER_NOTE_MAX = 1000


def _process_start_time(pid):
    """`ps -o lstart=` for pid, whitespace-normalized like run_pid.ts processStartTime; None if gone."""
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True,
                             text=True, timeout=5, env={**os.environ, "LC_ALL": "C"}).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return " ".join(out.split()) or None


def find_live_run(ref):
    """Return the id of a live run for issue ref "owner/repo#N", else None.

    Scans .loki/runs/*/events.jsonl for a run.started whose issue_ref matches and
    whose run.pid names a live process. Mirrors runOwnerAlive: the recorded
    start time and run_id must match, so a recycled pid does not read as live.
    """
    runs = Path(".loki") / "runs"
    try:
        dirs = sorted(runs.iterdir())
    except OSError:
        return None
    for d in dirs:
        try:
            with open(d / "events.jsonl", "r", encoding="utf-8", errors="replace") as fh:
                first = json.loads(fh.readline() or "{}")
            if first.get("type") != "run.started" or (first.get("data") or {}).get("issue_ref") != ref:
                continue
            rec = json.loads((d / "run.pid").read_text())
            pid = int(rec.get("pid", 0))
            start = rec.get("start")
            if pid > 1 and isinstance(start, str) and rec.get("run_id") == d.name \
                    and _process_start_time(pid) == " ".join(start.split()):
                return d.name
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return None


def steer_ack_text(rev):
    """Ack line for a steer; byte-identical to the line `loki steer` prints (cmd_steer)."""
    return "Steer rev %s received: applies at next plan/implement stage." % rev


STEER_ACK_MARKER = "<!-- loki-steer-ack -->"
LOKI_COMMENT_MARKER = "<!-- loki-"  # any Loki-authored comment (status projector, steer ack) never steers


def _pending_steer_rev():
    """Highest rev header in .loki/HUMAN_INPUT.md (the steer just written), else None."""
    try:
        text = (Path(os.environ.get("LOKI_DIR") or ".loki") / "HUMAN_INPUT.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    revs = re.findall(r"^## Operator directive rev (\d+) ", text, re.M)
    return int(revs[-1]) if revs else None


def post_steer_ack(ref, repo_full_name, rev, dry_run=False):
    """Post one ack comment on the issue through engine10-push.sh issue-comment. Best effort."""
    text = steer_ack_text(rev)
    if dry_run:
        logging.info("[DRY-RUN] Would ack %s: %s", ref, text)
        return True
    script = Path(__file__).resolve().parent / "lib" / "engine10-push.sh"
    body = None
    try:
        fd, body = tempfile.mkstemp(prefix="loki-steer-ack.", suffix=".md")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(STEER_ACK_MARKER + "\n" + text + "\n")
        env = _scoped_child_env()
        env["_LOKI_ORIGIN_PINNED"] = "1"
        env["_LOKI_PINNED_ORIGIN"] = "https://github.com/%s.git" % repo_full_name
        proc = subprocess.run(["bash", str(script), "issue-comment", ref, body],
                              capture_output=True, text=True, timeout=60, env=env)
        if proc.returncode != 0:
            logging.error("steer ack failed (%d): %s", proc.returncode, proc.stderr.strip())
        return proc.returncode == 0
    except (OSError, subprocess.SubprocessError) as e:
        logging.error("steer ack failed: %s", e)
        return False
    finally:
        if body:
            try:
                os.unlink(body)
            except OSError:
                pass


def handle_issue_comment_event(payload, dry_run=False):
    """Handle issue_comment: an authorized new comment steers the issue's live run."""
    action = payload.get("action", "")
    if action != "created":
        return None, "skipped (action=%s)" % action
    comment = payload.get("comment") or {}
    if comment.get("author_association") not in TRUSTED_ASSOCIATIONS:
        return None, "skipped (comment author not authorized)"
    user = comment.get("user") or {}
    login = str(user.get("login", ""))
    if user.get("type") == "Bot" or login.endswith("[bot]"):
        return None, "skipped (bot comment)"
    if LOKI_COMMENT_MARKER in str(comment.get("body", "")):
        return None, "skipped (loki-authored comment)"
    number = (payload.get("issue") or {}).get("number")
    repo_full_name = (payload.get("repository") or {}).get("full_name", "")
    if number is None or not valid_issue_number(number):
        return None, "rejected (invalid issue number)"
    if not valid_repo_full_name(repo_full_name):
        return None, "rejected (invalid repository full_name)"
    ref = "%s#%s" % (repo_full_name, number)
    if find_live_run(ref) is None:
        return None, "skipped (no live run for %s)" % ref
    body = re.sub(r"[\x00-\x1f\x7f\s]+", " ", str(comment.get("body", ""))).strip()[:STEER_NOTE_MAX]
    if not body:
        return None, "skipped (empty comment)"
    login = re.sub(r"[^A-Za-z0-9-]", "", login)[:39]
    note = "GitHub comment from %s: %s" % (login or "unknown", body)
    summary = "steer %s from comment" % ref
    success = run_loki_command(["steer", note], dry_run=dry_run)
    if success:
        send_notification("Trigger fired: %s" % summary)
        rev = _pending_steer_rev()
        injection_off = os.environ.get("LOKI_PROMPT_INJECTION", "").lower() in ("0", "false")
        if not injection_off and (rev is not None or dry_run):
            post_steer_ack(ref, repo_full_name, rev if rev is not None else "?", dry_run=dry_run)
    return summary, "fired" if success else "error"


def handle_issues_event(payload, dry_run=False):
    """Handle issues event: opened -> loki start <issue-ref> --pr --detach."""
    action = payload.get("action", "")
    if action != "opened":
        return None, "skipped (action=%s)" % action
    issue = payload.get("issue", {})
    if (issue.get("author_association") not in TRUSTED_ASSOCIATIONS
            and os.environ.get("LOKI_TRIGGER_ALLOW_ANY_ISSUE_AUTHOR", "") not in ("1", "true")):
        return None, "skipped (issue author not authorized)"
    issue_number = issue.get("number")
    repo = payload.get("repository", {})
    repo_full_name = repo.get("full_name", "")
    if issue_number is None:
        return None, "skipped (no issue number)"
    if not valid_issue_number(issue_number):
        return None, "rejected (invalid issue number)"
    # A repo full_name, when present, must be a clean "owner/repo". An invalid
    # one (e.g. dash-leading) is rejected outright rather than silently dropped,
    # so a flag-injection attempt is logged and never dispatched.
    if repo_full_name and not valid_repo_full_name(repo_full_name):
        return None, "rejected (invalid repository full_name)"
    ref = str(issue_number)
    if repo_full_name:
        ref = "%s#%s" % (repo_full_name, issue_number)
    args = ["start", ref, "--pr", "--detach"]
    summary = "issue #%s opened in %s" % (issue_number, repo_full_name)
    success = run_loki_command(args, dry_run=dry_run)
    status = "fired" if success else "error"
    if success:
        send_notification("Trigger fired: %s" % summary)
    return summary, status


def handle_pull_request_event(payload, dry_run=False):
    """Handle pull_request event: synchronize -> loki start <pr-ref> --detach."""
    action = payload.get("action", "")
    if action != "synchronize":
        return None, "skipped (action=%s)" % action
    pr = payload.get("pull_request", {})
    pr_number = pr.get("number")
    repo = payload.get("repository", {})
    repo_full_name = repo.get("full_name", "")
    if pr_number is None:
        return None, "skipped (no PR number)"
    if not valid_issue_number(pr_number):
        return None, "rejected (invalid PR number)"
    if repo_full_name and not valid_repo_full_name(repo_full_name):
        return None, "rejected (invalid repository full_name)"
    ref = str(pr_number)
    if repo_full_name:
        ref = "%s#%s" % (repo_full_name, pr_number)
    args = ["start", ref, "--detach"]
    summary = "PR #%s synchronized in %s" % (pr_number, repo_full_name)
    success = run_loki_command(args, dry_run=dry_run)
    status = "fired" if success else "error"
    if success:
        send_notification("Trigger fired: %s" % summary)
    return summary, status


def handle_workflow_run_event(payload, dry_run=False):
    """Handle workflow_run event: completed+failure -> loki start with context."""
    action = payload.get("action", "")
    if action != "completed":
        return None, "skipped (action=%s)" % action
    wf = payload.get("workflow_run", {})
    conclusion = wf.get("conclusion", "")
    if conclusion != "failure":
        return None, "skipped (conclusion=%s)" % conclusion
    wf_name = wf.get("name", "unknown")
    repo = payload.get("repository", {})
    repo_full_name = repo.get("full_name", "")
    summary = "workflow '%s' failed in %s" % (wf_name, repo_full_name)
    # CI-failure context: re-run the current spec in the working directory so
    # the agent can repair the failing build. No issue/PR ref to attach here.
    args = ["start", "--detach"]
    success = run_loki_command(args, dry_run=dry_run)
    status = "fired" if success else "error"
    if success:
        send_notification("Trigger fired: CI failure - %s" % summary)
    return summary, status


def brief_start_args(brief):
    """argv for a delegated PR run. `--brief` forces brief mode so the text is
    never reclassified as a PRD path or issue URL, and `--pr --detach` are only
    honored by `loki start` in brief mode because cmd_start routes them through
    the worktree + PR path."""
    return ["start", "--brief", brief, "--pr", "--detach"]


def handle_job_event(payload, dry_run=False):
    """Handle a remotely-submitted job: loki start <spec> --detach.

    Runs on the same worker pool as the webhook handlers. The spec was already
    validated by valid_spec() at admission; it is re-checked here so this
    handler is safe no matter who calls it, and it is passed as a single argv
    element -- never interpolated into a shell string.
    """
    spec = payload.get("spec")
    if not valid_spec(spec):
        return None, "rejected (invalid spec)"
    # Jira/Teams delegation sets pr=True: receipt-gated PR run, never a deploy.
    if payload.get("pr") is True:
        args = brief_start_args(spec.strip())
    else:
        args = ["start", spec.strip(), "--detach"]
    summary = "job %s: %s" % (payload.get("job_id", "?"), spec.strip())
    # A remote submitter gates CI on this, so report the BUILD's outcome, not
    # merely that a build was launched. "fired" (launched) and "passed" must
    # never share a value.
    status = run_loki_outcome(args, dry_run=dry_run)
    if status != OUTCOME_FAILED:
        send_notification("Trigger fired: %s" % summary)
    return summary, status


# Pseudo-event for a Sentry alert. Like JOB_EVENT it is NOT a GitHub event and is
# refused on /webhook: only /sentry, under its own HMAC secret, may enqueue it.
SENTRY_EVENT = "sentry_issue"
INTERNAL_EVENTS = (JOB_EVENT, SENTRY_EVENT)

# Sentry actions that mean "a new problem needs a fix". resolved/assigned/etc.
# are skipped so a state change never starts a build.
SENTRY_ACTIONS = ("triggered", "created")
SENTRY_BRIEF_MAX = 1500
ISSUE_PROVIDERS_SH = Path(__file__).resolve().parent / "issue-providers.sh"


def validate_sentry_signature(secret, body, signature_header):
    """Validate Sentry's `sentry-hook-signature` (hex HMAC-SHA256, no prefix).

    Fails closed: no secret or no header is never valid.
    """
    if not secret or not signature_header:
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return constant_time_equals(expected, signature_header.strip().lower())


# Slack and Linear delegation. Same signed-body contract as
# loki-ts/src/contrib/slack_inbound.ts (signSlackBody/verifySlackSignature).
SIGNATURE_MAX_SKEW_S = 300
SLACK_REPLY_PREFIX = "https://hooks.slack.com/"
LINEAR_API_URL = "https://api.linear.app/graphql"
LINEAR_IDENTIFIER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-\d+$")
NOTIFY_TIMEOUT_SECONDS = 10
NOTIFY_TEXT_MAX = 1000


def sign_slack_body(secret, timestamp, body):
    """`v0=` + hex HMAC-SHA256 over `v0:<timestamp>:<raw body>` (bytes)."""
    base = b"v0:" + str(timestamp).encode("utf-8") + b":" + body
    return "v0=" + hmac.new(secret.encode("utf-8"), base, hashlib.sha256).hexdigest()


def verify_slack_signature(secret, timestamp, body, signature, now=None):
    """Fail closed: no secret, header, numeric timestamp or fresh window -> False."""
    if not secret or not timestamp or not signature:
        return False
    if not re.fullmatch(r"[0-9]+", timestamp):
        return False
    now = time.time() if now is None else now
    if abs(now - int(timestamp)) > SIGNATURE_MAX_SKEW_S:
        return False
    return constant_time_equals(sign_slack_body(secret, timestamp, body), signature)


def verify_linear_signature(secret, body, signature):
    """Linear-Signature: hex HMAC-SHA256 of the raw body. Freshness is checked
    separately against the signed body's webhookTimestamp (linear_fresh)."""
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return constant_time_equals(expected, signature.strip().lower())


def linear_fresh(payload, now=None):
    ts_val = payload.get("webhookTimestamp")
    if isinstance(ts_val, bool) or not isinstance(ts_val, (int, float)):
        return False
    secs = ts_val / 1000.0 if ts_val > 1e11 else float(ts_val)
    now = time.time() if now is None else now
    return abs(now - secs) <= SIGNATURE_MAX_SKEW_S


def resolve_chat_secrets(env, secret, api_token, sentry_secret):
    """Return (slack_secret, linear_secret), blanking any that equals another
    credential: each authenticates a different party and MUST differ."""
    slack = env.get("SLACK_SIGNING_SECRET", "")
    linear = env.get("LINEAR_WEBHOOK_SECRET", "")
    others = [x for x in (secret, api_token, sentry_secret) if x]
    slack_bad = bool(slack) and any(
        constant_time_equals(slack, o) for o in others + ([linear] if linear else []))
    linear_bad = bool(linear) and any(
        constant_time_equals(linear, o) for o in others + ([slack] if slack else []))
    if slack_bad:
        logging.error("The Slack secret is identical to another credential. "
                      "They MUST differ; disabling /slack.")
    if linear_bad:
        logging.error("The Linear secret is identical to another credential. "
                      "They MUST differ; disabling /linear.")
    return ("" if slack_bad else slack), ("" if linear_bad else linear)


# Jira Cloud and Microsoft Teams delegation. Both enqueue a PR-only run.
JIRA_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*-\d+$")
JIRA_EVENTS = ("jira:issue_created", "jira:issue_updated")
JIRA_TRIGGER_FIELDS = ("assignee", "labels")
DELEGATED_BRIEF_MAX = 1500
HTML_TAG_RE = re.compile(r"<[^>]*>")


def verify_jira_signature(secret, body, signature):
    """X-Hub-Signature: `sha256=` + hex HMAC-SHA256 of the raw body. Jira sends
    no timestamp, so replay is bounded by delivery-id dedup in the handler."""
    if not secret or not signature:
        return False
    sig = signature.strip().lower()
    if not sig.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return constant_time_equals(expected, sig[len("sha256="):])


def sign_teams_body(token, body):
    """Base64 HMAC-SHA256 of the raw body, keyed by the base64-decoded token."""
    key = base64.b64decode(token, validate=True)
    return base64.b64encode(hmac.new(key, body, hashlib.sha256).digest()).decode("ascii")


def verify_teams_signature(token, body, authorization):
    """Authorization: `HMAC <base64>`. Fails closed on a bad token or header."""
    if not token or not authorization:
        return False
    scheme, _, value = authorization.strip().partition(" ")
    if scheme.upper() != "HMAC" or not value.strip():
        return False
    try:
        expected = sign_teams_body(token, body)
    except ValueError:
        return False
    return constant_time_equals(expected, value.strip())


def teams_dedup_key(activity):
    """Dedup key for a Teams activity: activity ids are unique only within a
    conversation, so scope by conversation id plus serviceUrl and tenant when
    present. Empty string (never deduplicated) when the activity id is absent."""
    act_id = activity.get("id")
    if not isinstance(act_id, str) or not act_id:
        return ""

    def _s(v):
        return v if isinstance(v, str) else ""

    conv = activity.get("conversation")
    conv = conv if isinstance(conv, dict) else {}
    cdata = activity.get("channelData")
    tenant = cdata.get("tenant") if isinstance(cdata, dict) else None
    tenant_id = _s(tenant.get("id")) if isinstance(tenant, dict) else ""
    tenant_id = tenant_id or _s(conv.get("tenantId"))
    return "teams:" + json.dumps(
        [_s(conv.get("id")), _s(activity.get("serviceUrl")), tenant_id, act_id])


def teams_fresh(activity, now=None):
    """The activity's ISO-8601 `timestamp` must be within the skew window."""
    raw = activity.get("timestamp")
    if not isinstance(raw, str) or not raw:
        return False
    try:
        dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    now = time.time() if now is None else now
    return abs(now - dt.timestamp()) <= SIGNATURE_MAX_SKEW_S


def _csv_set(value):
    return frozenset(x.strip() for x in value.split(",") if x.strip())


def _one_line(text, limit=DELEGATED_BRIEF_MAX):
    text = " ".join(CONTROL_CHARS_RE.sub(" ", str(text or "")).split())
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")


def jira_trigger_matches(payload, assignees, labels):
    """True when the issue is assigned to a configured user or carries a
    configured label. An update only counts if it changed assignee or labels,
    so unrelated edits never re-fire a run."""
    issue = payload.get("issue")
    fields = issue.get("fields") if isinstance(issue, dict) else None
    if not isinstance(fields, dict):
        return False
    if payload.get("webhookEvent") == "jira:issue_updated":
        items = (payload.get("changelog") or {}).get("items")
        changed = ({i.get("field") for i in items if isinstance(i, dict)}
                   if isinstance(items, list) else set())
        if not changed.intersection(JIRA_TRIGGER_FIELDS):
            return False
    who = fields.get("assignee")
    ids = set()
    if isinstance(who, dict):
        for k in ("accountId", "emailAddress", "displayName"):
            if isinstance(who.get(k), str):
                ids.add(who[k])
    if ids.intersection(assignees):
        return True
    have = fields.get("labels")
    return isinstance(have, list) and bool(
        {x for x in have if isinstance(x, str)}.intersection(labels))


def adf_text(node, out=None):
    """Flatten an Atlassian Document Format tree to its text nodes."""
    top = out is None
    out = [] if top else out
    if isinstance(node, dict):
        if isinstance(node.get("text"), str):
            out.append(node["text"])
        for child in node.get("content") or []:
            adf_text(child, out)
    elif isinstance(node, list):
        for child in node:
            adf_text(child, out)
    return " ".join(out) if top else None


def build_jira_brief(issue):
    fields = issue.get("fields") or {}
    desc = fields.get("description")
    if isinstance(desc, dict):
        desc = adf_text(desc)
    parts = ["Resolve Jira issue %s: %s." % (issue.get("key"), fields.get("summary") or "")]
    if isinstance(desc, str) and desc.strip():
        parts.append(desc)
    parts.append("Reproduce with a regression test, then fix the root cause.")
    return _one_line(" ".join(parts))


def build_teams_brief(activity):
    text = re.sub(r"<at>.*?</at>", " ", str(activity.get("text") or ""), flags=re.S)
    return _one_line(HTML_TAG_RE.sub(" ", text))


def resolve_delegation_secrets(env, others):
    """Return (jira_secret, teams_token), blanking any equal to another
    credential in `others` or to each other."""
    jira = env.get("JIRA_WEBHOOK_SECRET", "")
    teams = env.get("TEAMS_SECURITY_TOKEN", "")
    others = [x for x in others if x]
    out = []
    for name, val, peer in (("Jira", jira, teams), ("Teams", teams, jira)):
        bad = bool(val) and any(constant_time_equals(val, o)
                                for o in others + ([peer] if peer else []))
        if bad:
            logging.error("The %s secret is identical to another credential. "
                          "They MUST differ; disabling its route.", name)
        out.append("" if bad else val)
    return tuple(out)


def _post_json(url, data, headers):
    """POST JSON with a bounded timeout. Raises on any failure; callers log."""
    req = Request(url, data=json.dumps(data).encode("utf-8"),
                  headers=dict(headers, **{"Content-Type": "application/json"}),
                  method="POST")
    with urlopen(req, timeout=NOTIFY_TIMEOUT_SECONDS) as resp:
        resp.read()


def _notify_slack(target, text):
    url = target.get("response_url", "")
    if not (isinstance(url, str) and url.startswith(SLACK_REPLY_PREFIX)):
        return
    _post_json(url, {"response_type": "in_channel", "text": text}, {})


def _notify_linear(target, text):
    key = os.environ.get("LINEAR_API_KEY", "")
    issue_id = target.get("issue_id", "")
    if not key or not isinstance(issue_id, str) or not issue_id:
        return
    _post_json(LINEAR_API_URL, {
        "query": "mutation($i:String!,$b:String!){commentCreate(input:"
                 "{issueId:$i,body:$b}){success}}",
        "variables": {"i": issue_id, "b": text},
    }, {"Authorization": key})


def _notify_jira(target, text):
    """ADF comment on the issue. Site and credentials come from the operator's
    env only (never the payload); a non-https base URL is never contacted."""
    base = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
    email = os.environ.get("JIRA_EMAIL", "")
    token = os.environ.get("JIRA_API_TOKEN", "")
    key = target.get("key", "")
    if not (base.startswith("https://") and email and token
            and isinstance(key, str) and JIRA_KEY_RE.match(key)):
        return
    auth = base64.b64encode(("%s:%s" % (email, token)).encode("utf-8")).decode("ascii")
    _post_json("%s/rest/api/3/issue/%s/comment" % (base, key), {
        "body": {"type": "doc", "version": 1, "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}]},
    }, {"Authorization": "Basic " + auth})


# Reply-target kind -> notifier. Sentry has no entry on purpose: it never replies.
NOTIFIERS = {"slack": _notify_slack, "linear": _notify_linear, "jira": _notify_jira}


def notify_job_complete(target, job_id, status, summary):
    """Send a completion summary to a reply target captured after verification.

    Never raises: a notifier failure must not fail the job. Each notifier
    re-checks its own destination as defense in depth.
    """
    if not isinstance(target, dict):
        return
    notifier = NOTIFIERS.get(target.get("kind"))
    if notifier is None:
        return
    text = ("loki job %s finished: %s. %s" % (job_id, status, summary or "")).strip()
    text = CONTROL_CHARS_RE.sub(" ", text)[:NOTIFY_TEXT_MAX]
    try:
        notifier(target, text)
    except Exception as e:  # notifier errors never fail a job
        logging.warning("Completion notify for job %s failed: %s", job_id, e)


def normalize_sentry_payload(payload):
    """Run the existing normalize_sentry_json over a Sentry webhook payload.

    Reuses autonomy/issue-providers.sh (single owner of the Sentry shape) via a
    scoped-env bash call. Returns the normalized dict or None.
    """
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    raw = {k: data[k] for k in ("issue", "event") if isinstance(data.get(k), dict)}
    if not raw:
        return None
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    ev = raw.get("event") or {}
    env["_LOKI_SENTRY_URL"] = str(ev.get("web_url") or ev.get("url") or "")
    try:
        proc = subprocess.run(
            ["bash", "-c", 'source "$1" && normalize_sentry_json', "_",
             str(ISSUE_PROVIDERS_SH)],
            input=json.dumps(raw).encode("utf-8"), capture_output=True,
            env=env, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    try:
        out = json.loads(proc.stdout.decode("utf-8", errors="replace").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None
    return out if isinstance(out, dict) else None


def _clip(value, limit=80):
    """Single-line, control-char-free, length-capped untrusted text."""
    text = " ".join(CONTROL_CHARS_RE.sub(" ", str(value or "")).split())
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")


def _sentry_release_env(payload):
    ev = ((payload or {}).get("data") or {}).get("event")
    ev = ev if isinstance(ev, dict) else {}
    release = ev.get("release")
    if isinstance(release, dict):
        release = release.get("version")
    return _clip(release), _clip(ev.get("environment"), 40)


def _last_deploy_context():
    """'last deploy <sha7> <finished_at> health=<status>' from the newest
    .loki/deploys record in the server's project dir, or ''."""
    try:
        ddir = os.path.join(os.getcwd(), ".loki", "deploys")
        names = sorted(n for n in os.listdir(ddir) if n.endswith(".json"))
        if not names:
            return ""
        with open(os.path.join(ddir, names[-1]), "r", encoding="utf-8") as fh:
            rec = json.load(fh)
    except (OSError, ValueError):
        return ""
    if not isinstance(rec, dict) or not rec.get("head_sha"):
        return ""
    return "last deploy %s %s health=%s" % (
        _clip(rec.get("head_sha"), 7), _clip(rec.get("finished_at"), 30),
        _clip(rec.get("health_status") or "unchecked", 20))


def _culprit_owner(culprit):
    """'last change to <file> by <author> <sha7>' via read-only git log -1, or ''."""
    token = culprit.split(" ", 1)[0] if culprit else ""
    if not token or token.startswith("-") or ".." in token:
        return ""
    root = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(root, token))
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return ""
    try:
        proc = subprocess.run(
            ["git", "-C", root, "log", "-1", "--format=%an|%h", "--", full],
            capture_output=True, timeout=5,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
    except (OSError, subprocess.SubprocessError):
        return ""
    out = proc.stdout.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0 or "|" not in out:
        return ""
    author, sha = out.rsplit("|", 1)
    return "last change to %s by %s %s" % (_clip(token, 60), _clip(author, 40), _clip(sha, 12))


def build_sentry_brief(norm, payload=None):
    """One-line, control-char-free brief that can never parse as a CLI flag."""
    culprit = ""
    for line in str(norm.get("body", "")).splitlines():
        if line.startswith("- Culprit: "):
            culprit = line[len("- Culprit: "):].strip()
            break
    parts = ["Fix Sentry issue %s: %s" % (norm.get("number", "?"), norm.get("title", ""))]
    if culprit:
        parts.append("(culprit %s)" % culprit)
    release, env_name = _sentry_release_env(payload)
    ctx = []
    if release:
        ctx.append("release %s" % release)
    if env_name:
        ctx.append("env %s" % env_name)
    for extra in (_last_deploy_context(), _culprit_owner(culprit)):
        if extra:
            ctx.append(extra)
    if ctx:
        parts.append("[%s]" % "; ".join(ctx))
    if norm.get("url"):
        parts.append("See %s." % norm["url"])
    parts.append("Reproduce with a regression test, then fix the root cause.")
    brief = CONTROL_CHARS_RE.sub(" ", " ".join(parts))
    brief = " ".join(brief.split())
    return brief.encode("utf-8")[:SENTRY_BRIEF_MAX].decode("utf-8", errors="ignore")


def handle_sentry_event(payload, dry_run=False):
    """Handle a verified Sentry alert: loki start <brief> --pr --detach.

    PR only. Never passes a deploy argument: a fix still has to earn a VERIFIED
    receipt, and shipping it stays a separate, gated human step.
    """
    action = payload.get("action", "")
    if action not in SENTRY_ACTIONS:
        return None, "skipped (action=%s)" % action
    norm = normalize_sentry_payload(payload)
    if norm is None:
        return None, "rejected (unparseable sentry payload)"
    brief = build_sentry_brief(norm, payload)
    if not valid_spec(brief):
        return None, "rejected (invalid brief)"
    args = brief_start_args(brief)
    summary = "sentry issue %s" % norm.get("number", "?")
    success = run_loki_command(args, dry_run=dry_run)
    status = "fired" if success else "error"
    if success:
        send_notification("Trigger fired: %s" % summary)
    return summary, status


# Map event name -> handler. Keeps do_POST routing declarative. JOB_EVENT rides
# the same table (and therefore the same bounded queue and worker pool) but is
# explicitly refused on the /webhook path.
EVENT_HANDLERS = {
    "issues": handle_issues_event,
    "issue_comment": handle_issue_comment_event,
    "pull_request": handle_pull_request_event,
    "workflow_run": handle_workflow_run_event,
    JOB_EVENT: handle_job_event,
    SENTRY_EVENT: handle_sentry_event,
}


def dispatch_event(event_type, payload, dry_run=False):
    """Route one webhook event to its handler and log the outcome.

    Runs on a worker thread. Returns (summary, status). Any handler exception
    is caught and logged so one bad payload cannot kill a worker.
    """
    action = payload.get("action", "")
    handler = EVENT_HANDLERS.get(event_type)
    if handler is None:
        status = "unsupported event: %s" % event_type
        log_event(event_type, action, "", status)
        return None, status
    try:
        summary, status = handler(payload, dry_run=dry_run)
    except Exception as e:  # defensive: never let a worker die on bad input
        logging.exception("Handler for %s raised: %s", event_type, e)
        summary, status = None, "error"
    log_event(event_type, action, summary or "", status)
    return summary, status


class Dispatcher:
    """Bounded worker pool that drains webhook events off a queue.

    The HTTP handler enqueues work and returns immediately, so the listener
    never blocks on a slow dispatch. A fixed number of worker threads drain the
    queue; if the queue is full the handler is told to shed load (503) so a
    webhook storm cannot fork unbounded builds.
    """

    def __init__(self, workers=DEFAULT_WORKERS, queue_size=DEFAULT_QUEUE_SIZE,
                 dry_run=False, dedup_size=DEFAULT_DEDUP_SIZE,
                 job_history=DEFAULT_JOB_HISTORY):
        self.dry_run = dry_run
        self.queue = queue.Queue(maxsize=max(1, queue_size))
        # Job status for GET /jobs/<id>. Same bounded-FIFO idiom as the dedup
        # cache below: oldest records are evicted so memory cannot grow without
        # limit under a submit storm.
        self._job_max = max(1, job_history)
        self._jobs = collections.OrderedDict()
        self._jobs_lock = threading.Lock()
        # Reply targets (Slack response_url / Linear issue) keyed by job_id,
        # written only by the verified /slack and /linear handlers.
        self._reply_targets = collections.OrderedDict()
        # Proof-attribution bookkeeping. The proof pointer is global to the
        # working directory, so a receipt only identifies a job when that job
        # was the only build that could have written it. All three are updated
        # on EVERY dispatch (webhook and remote-submit alike) under _jobs_lock.
        self._dispatch_seq = 0    # monotonic count of dispatches
        self._pending = 0         # dispatches with no receipt seen yet
        self._last_pointer = read_proof_pointer()
        # Idempotency: remember recently seen GitHub delivery IDs so a
        # redelivered webhook (GitHub retries on non-2xx, and operators can
        # manually redeliver) does not dispatch the same build twice. Bounded
        # FIFO so memory cannot grow without limit.
        self._dedup_max = max(1, dedup_size)
        self._seen_deliveries = collections.OrderedDict()
        self._dedup_lock = threading.Lock()
        self._seen_path = get_loki_dir() / "seen-deliveries.jsonl"
        self._load_seen()
        self._threads = []
        self._stop = threading.Event()
        for i in range(max(1, workers)):
            t = threading.Thread(
                target=self._worker,
                name="loki-trigger-worker-%d" % i,
                daemon=True,
            )
            t.start()
            self._threads.append(t)

    def _load_seen(self):
        """Reload the last dedup_max accepted keys so a restart keeps dedup."""
        try:
            lines = self._seen_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        keys = []
        for line in lines:
            try:
                k = json.loads(line).get("k")
            except (ValueError, AttributeError):
                continue
            if isinstance(k, str) and k:
                keys.append(k)
        keys = keys[-self._dedup_max:]
        for k in keys:
            self._seen_deliveries[k] = True
        if len(lines) > 2 * self._dedup_max:
            try:
                self._seen_path.write_text(
                    "".join(json.dumps({"k": k}) + "\n" for k in keys), encoding="utf-8")
            except OSError:
                pass

    def _remember(self, key):
        """Record key (caller holds _dedup_lock); append to the JSONL, best effort."""
        self._seen_deliveries[key] = True
        while len(self._seen_deliveries) > self._dedup_max:
            self._seen_deliveries.popitem(last=False)
        try:
            with open(self._seen_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"k": key}) + "\n")
        except OSError:
            pass

    def seen_intake(self, event_type, payload):
        """True if the same repo#N + action + head sha was accepted and its run is live.

        Catches a redelivery under a new delivery id or after a restart. Once the
        run is no longer live the same key may dispatch again. Only issues and
        pull_request events carry an intake key.
        """
        if event_type not in ("issues", "pull_request"):
            return False
        number = (payload.get("issue") or payload.get("pull_request") or {}).get("number")
        repo = (payload.get("repository") or {}).get("full_name", "")
        if number is None or not repo:
            return False
        sha = ((payload.get("pull_request") or {}).get("head") or {}).get("sha", "")
        key = "intake:%s:%s#%s:%s:%s" % (event_type, repo, number, payload.get("action", ""), sha)
        ref = "%s#%s" % (repo, number)
        with self._dedup_lock:
            if key in self._seen_deliveries and find_live_run(ref) is not None:
                return True
            if key not in self._seen_deliveries:
                self._remember(key)
            return False

    def seen_delivery(self, delivery_id):
        """Return True if this delivery_id was already accepted (idempotency).

        Records the id as seen as a side effect when it is new. A falsy
        delivery_id (header absent) is never deduplicated, so requests without
        a delivery id always fall through to normal handling.
        """
        if not delivery_id:
            return False
        with self._dedup_lock:
            if delivery_id in self._seen_deliveries:
                # Do NOT refresh recency here. If a duplicate hit moved the id to
                # the most-recent end, a flood of one valid (authenticated)
                # duplicate id could keep it pinned and evict up to dedup_max
                # genuinely-recent ids, letting real redeliveries slip through.
                # Insertion order is the eviction policy; duplicates leave it
                # unchanged.
                return True
            self._remember(delivery_id)
            return False

    def _begin_proof_window(self, job_id=None):
        """Record that a build was dispatched, snapshotting the proof pointer.

        Called for EVERY dispatch, not just remotely-submitted ones. A webhook
        build (issues / pull_request / workflow_run) runs `loki start` in the
        same working directory and writes the same global pointer, so if it
        finished during a submitted job's window and was not counted here, its
        receipt would be attributed to that job. That is exactly the
        borrowed-receipt failure this design exists to prevent.

        Attribution is deliberately NOT resolved when the dispatch returns.
        `loki start --detach` returns as soon as the child forks, while the
        build runs for minutes and writes its receipt at the very end -- so a
        window closed at dispatch-return would always see an unchanged pointer
        and every real build would 404. Resolution happens lazily in
        get_job_proof_id() instead, at the moment someone asks.
        """
        with self._jobs_lock:
            self._dispatch_seq += 1
            # A build whose receipt has not yet appeared stays PENDING. While
            # any earlier dispatch is pending, a pointer change is ambiguous:
            # it could be that build finishing late rather than this one. The
            # snapshot is only taken when this job is the sole pending build.
            pointer = read_proof_pointer()
            if pointer != self._last_pointer:
                # Every pending build's receipt could be the one that just
                # landed, so none of them can claim it, and the slate clears.
                self._last_pointer = pointer
                self._pending = 0
            sole = self._pending == 0
            self._pending += 1
            entry = self._jobs.get(job_id) if job_id else None
            if entry is not None:
                entry["_proof_before"] = pointer
                entry["_proof_seq"] = self._dispatch_seq
                entry["_proof_sole"] = sole

    def _resolve_proof_id(self, entry):
        """Attribute the current proof pointer to `entry`, or refuse to guess.

        Caller holds _jobs_lock. Returns (run_id, reason): exactly one is set.

        A CHANGED pointer means some build wrote a receipt since this job was
        dispatched. That identifies THIS job's receipt only if no other build
        was dispatched afterwards -- otherwise the pointer names whichever
        finished last, and handing that to this submitter would give them
        someone else's evidence labelled as theirs. Worse than the 404 an
        absent receipt already returns, so a contended window resolves to
        nothing.

        An UNCHANGED pointer means no receipt has been written yet (the build
        is still running, produced none, or LOKI_PROVEN_PR=0 suppressed the
        pointer). Also nothing: we never fall back to the newest directory
        under .loki/proofs/, which would serve an unrelated earlier run.
        """
        before = entry.get("_proof_before", "")
        seq = entry.get("_proof_seq")
        if seq is None:
            return "", "this job was not dispatched with proof tracking"
        # Attributable only when this job was the sole pending build at
        # dispatch (nothing earlier could still write a receipt) AND nothing
        # has been dispatched since (nothing later could have written the one
        # we are about to read). Either alone is insufficient: without the
        # first, a second job claims the first job's receipt; without the
        # second, a job claims a receipt a later build produced.
        if not entry.get("_proof_sole") or seq != self._dispatch_seq:
            return "", (
                "another build was dispatched during this job's window, so "
                "the proof pointer cannot be attributed to this job"
            )
        after = read_proof_pointer()
        if after and after != before:
            return after, ""
        return "", "this job wrote no Evidence Receipt"

    def record_job(self, job_id, status, summary=""):
        """Create or update the status record for a remotely-submitted job."""
        with self._jobs_lock:
            entry = self._jobs.get(job_id)
            if entry is None:
                entry = {"id": job_id, "created": _utc_now()}
                self._jobs[job_id] = entry
                while len(self._jobs) > self._job_max:
                    self._jobs.popitem(last=False)
            entry["status"] = status
            entry["updated"] = _utc_now()
            if summary:
                entry["summary"] = summary

    def set_reply_target(self, job_id, target):
        """Store a verified reply target server side, bounded like _jobs."""
        with self._jobs_lock:
            self._reply_targets[job_id] = target
            while len(self._reply_targets) > self._job_max:
                self._reply_targets.popitem(last=False)

    def pop_reply_target(self, job_id):
        with self._jobs_lock:
            return self._reply_targets.pop(job_id, None)

    def get_job(self, job_id):
        """Return a copy of the job record, or None if unknown/evicted.

        Underscore-prefixed keys are internal bookkeeping for proof attribution
        and are stripped: the status response is a public API surface.
        """
        with self._jobs_lock:
            entry = self._jobs.get(job_id)
            if not entry:
                return None
            return {k: v for k, v in entry.items() if not k.startswith("_")}

    def get_job_proof_id(self, job_id):
        """Return (run_id, reason) for job_id. Exactly one is non-empty.

        Resolved lazily, at ask time, because a detached build finishes long
        after its dispatch returns (see _begin_proof_window).
        """
        with self._jobs_lock:
            entry = self._jobs.get(job_id)
            if entry is None:
                return "", "unknown job id"
            return self._resolve_proof_id(entry)

    def metrics(self):
        """Queue depth and saturation, for autoscaling and for operators.

        QUEUE DEPTH IS THE RIGHT SCALING SIGNAL HERE, AND CPU IS THE WRONG ONE.
        A worker spends nearly all of a build waiting on a model API, so it is
        idle by CPU measure while the backlog grows. An HPA on CPU would scale
        DOWN a saturated cluster. Depth is the only metric that moves when work
        is waiting.

        `queue_saturation` is depth/maxsize, so a chart can target a fraction
        without knowing the absolute size an operator configured.

        Reads `_pending` under the same lock that writes it; `qsize()` is
        approximate by design in CPython and is documented as such rather than
        presented as exact.
        """
        with self._jobs_lock:
            pending = self._pending
            dispatched = self._dispatch_seq
        depth = self.queue.qsize()
        maxsize = self.queue.maxsize or 1
        return {
            "queue_depth": depth,
            "queue_maxsize": maxsize,
            "queue_saturation": round(depth / maxsize, 4),
            "dispatched_total": dispatched,
            "awaiting_receipt": pending,
            "note": "queue_depth is approximate (queue.qsize semantics); scale on "
                    "queue_saturation, never on CPU -- a worker blocked on a model "
                    "call is idle by CPU measure while the backlog grows.",
        }

    def submit(self, event_type, payload):
        """Enqueue an event. Returns True if accepted, False if the queue is full."""
        try:
            self.queue.put_nowait((event_type, payload))
            return True
        except queue.Full:
            return False

    def _worker(self):
        while not self._stop.is_set():
            try:
                item = self.queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                event_type, payload = item
                # Honour job_id ONLY for a remotely-submitted job. A GitHub
                # payload carries no job_id of its own, so accepting one from
                # any payload let a holder of the WEBHOOK HMAC write into the
                # /jobs status store -- overwriting a real job's terminal
                # status (e.g. "passed" -> "fired") and re-introducing the
                # false-green. That is a webhook credential reaching a /jobs
                # capability, which the separate-credential design forbids.
                job_id = (payload.get("job_id")
                          if event_type == JOB_EVENT and isinstance(payload, dict)
                          else None)
                if job_id:
                    self.record_job(job_id, "running")
                # Counted for every dispatch, including webhook builds that
                # have no job_id: they write the same global proof pointer, so
                # an uncounted one would be misattributed to a submitted job.
                self._begin_proof_window(job_id)
                summary, status = dispatch_event(
                    event_type, payload, dry_run=self.dry_run
                )
                if job_id:
                    self.record_job(job_id, status, summary or "")
                    target = self.pop_reply_target(job_id)
                    if target is not None:
                        notify_job_complete(target, job_id, status, summary)
            finally:
                self.queue.task_done()

    def shutdown(self):
        self._stop.set()


class WebhookHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for GitHub webhooks."""

    # Set on the class in main() before the server starts.
    dry_run = False
    secret = ""
    # Bearer token for the /jobs API. MUST be a different secret from `secret`
    # above: one authenticates GitHub, the other authenticates a human.
    api_token = ""
    # Sentry integration client secret for /sentry. Distinct from both above.
    sentry_secret = ""
    # Slack signing secret (/slack) and Linear webhook secret (/linear), each
    # distinct from every other credential.
    slack_secret = ""
    linear_secret = ""
    # Jira webhook secret (/jira), Teams outgoing-webhook token (/teams), and
    # the Jira trigger filters (assignee ids/emails/names, labels).
    jira_secret = ""
    teams_secret = ""
    jira_assignees = frozenset()
    jira_labels = frozenset()
    dispatcher = None
    # Ed25519 key that attests receipts, and the retired public keys that keep
    # pre-rotation receipts verifiable. Both default to unconfigured, which
    # means receipts stay UNSIGNED exactly as before this existed.
    signing_key = None
    signing_kid = ""
    retired_pubkeys = ()

    # Cap the body we will read so a huge POST cannot exhaust memory.
    MAX_BODY_BYTES = 5 * 1024 * 1024

    def log_message(self, format, *args):
        logging.info("%s - %s", self.address_string(), format % args)

    def do_GET(self):
        # Strip any query string: do_GET matches paths exactly.
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(200, {"status": "ok", "service": "loki-trigger-server"})
        elif path == "/status":
            config = load_config()
            self._send_json(200, {
                "status": "running",
                "dry_run": self.dry_run,
                "port": config.get("port", 7373),
                "enabled_events": config.get("enabled_events", []),
                "secret_configured": bool(self.secret),
                "api_token_configured": bool(self.api_token),
            })
        elif path == "/.well-known/jwks.json":
            self._handle_jwks()
        elif path == "/metrics":
            self._handle_metrics()
        elif path.startswith("/jobs/") and path.endswith("/proof"):
            self._handle_job_proof(path[len("/jobs/"):-len("/proof")])
        elif path.startswith("/jobs/"):
            self._handle_job_status(path[len("/jobs/"):])
        else:
            self._send_json(404, {"error": "not found"})

    def _check_api_auth(self):
        """Authenticate a /jobs request. Returns True if the caller may proceed.

        Sends the error response itself (503 / 401) and returns False otherwise,
        so callers just `if not self._check_api_auth(): return`.

        Fails closed exactly like the webhook path: with no API token configured
        every /jobs request is rejected with 503 plus an audit line. It is never
        satisfied by the webhook HMAC -- a different credential entirely.
        """
        if not self.api_token:
            logging.warning(
                "Rejecting /jobs request from %s: no API token configured "
                "(set LOKI_API_TOKEN or LOKI_API_TOKEN_FILE to enable submits)",
                self.address_string(),
            )
            log_event(JOB_EVENT, "", "", "rejected (no API token configured)")
            self._send_json(503, {"error": "API token not configured"})
            return False

        header = self.headers.get("Authorization", "") or ""
        prefix = "Bearer "
        if not header.startswith(prefix):
            log_event(JOB_EVENT, "", "", "rejected (missing bearer token)")
            self._send_json(401, {"error": "missing bearer token"})
            return False

        if not constant_time_equals(header[len(prefix):].strip(), self.api_token):
            logging.warning("Invalid API token from %s", self.address_string())
            log_event(JOB_EVENT, "", "", "rejected (invalid API token)")
            self._send_json(401, {"error": "invalid API token"})
            return False

        return True

    def _handle_job_status(self, job_id):
        """GET /jobs/<id>. Authenticated: a status record echoes the spec."""
        if not self._check_api_auth():
            return
        job = self.dispatcher.get_job(job_id) if self.dispatcher else None
        if job is None:
            self._send_json(404, {"error": "unknown job id"})
            return
        self._send_json(200, job)

    def _handle_metrics(self):
        """GET /metrics -- queue depth for autoscaling and for operators.

        AUTHENTICATED, unlike /.well-known/jwks.json, and the difference is
        deliberate. JWKS is public key material whose whole value is that
        anyone can fetch it. Queue depth is operational posture: it reveals
        load, capacity and whether a cluster is saturated. Publishing that
        unauthenticated would hand an attacker a free saturation oracle.

        In-cluster scrapers (an HPA adapter, Prometheus) present the same
        bearer token as any other /jobs caller, so no new credential is
        introduced for this.
        """
        if not self._check_api_auth():
            return
        if self.dispatcher is None:
            self._send_json(503, {"error": "no dispatcher"})
            return
        self._send_json(200, self.dispatcher.metrics())

    def _handle_jwks(self):
        """GET /.well-known/jwks.json -- the public keys that sign receipts.

        DELIBERATELY UNAUTHENTICATED, and that is the whole point. This is
        public key material, and the value of an attested receipt is that a
        third party can check it WITHOUT holding our API token. Requiring the
        token here would mean only people we already trust could verify, which
        is the same as not being verifiable at all.

        Serves the active key plus any retired ones, so a receipt issued before
        a rotation still verifies afterwards. Without that, rotating would make
        every historical receipt read as unverifiable -- and a checker cannot
        tell that apart from tampering.

        Returns an empty key set (not a 404) when signing is unconfigured: the
        endpoint exists and honestly reports that nothing is signed, which is
        distinguishable from "this server has no such endpoint".
        """
        self._send_json(200, build_jwks(
            private_key=self.signing_key,
            retired_public_keys=self.retired_pubkeys,
        ))

    def _handle_job_proof(self, job_id):
        """GET /jobs/<id>/proof -- that job's Evidence Receipt.

        Returns proof.json UNWRAPPED at the top level. The detached gpg
        signature, when the build made one, already lives inside it at
        verification.gpg_signature, and the integrity hash is computed over the
        receipt with `verification` stripped. Wrapping the body in an envelope
        would therefore break hash recomputation for a client that writes the
        response to disk, making every honest receipt read as tampered.

        Same bearer-token auth and fail-closed behavior as POST /jobs. A job
        that produced no attributable proof is a 404: a synthesized or
        borrowed-from-another-run receipt would be worse than none, since its
        whole value is that the submitter can check it without trusting us.
        """
        if not self._check_api_auth():
            return
        job = self.dispatcher.get_job(job_id) if self.dispatcher else None
        if job is None:
            self._send_json(404, {"error": "unknown job id"})
            return
        run_id, reason = self.dispatcher.get_job_proof_id(job_id)
        proof = read_proof(run_id) if run_id else None
        if proof is None:
            self._send_json(404, {
                "error": "no proof available for this job",
                "reason": reason or "the recorded receipt could not be read",
            })
            return
        self._send_json(200, self._attest(proof, job_id, run_id))

    def _attest(self, proof, job_id, run_id):
        """Attach a signed attestation to a receipt, if signing is configured.

        The JWT is bound to `verification.hash` -- the digest the receipt ALREADY
        records over itself with `verification` stripped. Signing any other value
        would let the attestation and the checker's own recomputation disagree
        while both looked valid, which is worse than not signing at all.

        The token is added under `verification.attestation`, which sits inside
        the subtree the hash excludes. Putting it anywhere else would change the
        bytes the hash covers and make every honest receipt read as tampered the
        moment it was signed.

        Returns the receipt UNCHANGED when signing is unconfigured or the hash
        is missing. An unsigned receipt is a valid state with an existing
        verdict; a receipt claiming an attestation it does not have is not.
        """
        if self.signing_key is None:
            return proof
        verification = proof.get("verification")
        if not isinstance(verification, dict):
            return proof
        receipt_hash = verification.get("hash") or ""
        if not receipt_hash:
            # No self-recorded digest means there is nothing to bind to. Signing
            # the whole body instead would attest to bytes the checker never
            # recomputes, so the honest move is to leave it unsigned.
            logging.warning(
                "receipt attestation: run %s has no verification.hash; left UNSIGNED",
                run_id,
            )
            return proof
        token = sign_attestation(
            self.signing_key, self.signing_kid,
            job_id=job_id, run_id=run_id, receipt_hash=receipt_hash,
            verification=verification,
        )
        if not token:
            return proof
        # Copied rather than mutated: read_proof returns a fresh parse today, but
        # a future cache would make in-place mutation compound tokens across
        # requests.
        out = dict(proof)
        out["verification"] = dict(verification)
        out["verification"]["attestation"] = token
        out["verification"]["attestation_kid"] = self.signing_kid
        return out

    def _read_body(self):
        """Read and return the request body, or None if it was refused.

        Shared by /webhook and /jobs so both get the same Content-Length cap and
        the same bounded read (a slow-loris that drips or never finishes the
        body must not tie up a worker thread BEFORE authentication). On refusal
        the error response is already sent and None is returned.
        """
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "invalid Content-Length"})
            return None
        if content_length < 0 or content_length > self.MAX_BODY_BYTES:
            self._send_json(413, {"error": "payload too large"})
            return None

        prev_timeout = self.connection.gettimeout()
        self.connection.settimeout(BODY_READ_TIMEOUT_SECONDS)
        try:
            body = self.rfile.read(content_length)
        except (socket.timeout, TimeoutError, ConnectionError, OSError):
            logging.warning(
                "Dropping slow/incomplete request body from %s",
                self.address_string(),
            )
            try:
                self._send_json(408, {"error": "request body timeout"})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return None
        finally:
            try:
                self.connection.settimeout(prev_timeout)
            except OSError:
                pass

        if len(body) != content_length:
            # Client closed before delivering the declared body. Refuse rather
            # than authenticate a truncated payload.
            self._send_json(400, {"error": "incomplete request body"})
            return None
        return body

    def _handle_job_submit(self):
        """POST /jobs -- authenticated remote submit of a spec.

        Enqueues onto the SAME bounded queue and worker pool as the webhook
        path; only the credential and the admission validation differ.
        """
        body = self._read_body()
        if body is None:
            return
        # Authenticate BEFORE parsing: an unauthenticated caller never reaches
        # the JSON parser, and never gets a job id back.
        if not self._check_api_auth():
            return

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "payload must be a JSON object"})
            return

        spec = payload.get("spec")
        if not valid_spec(spec):
            log_event(JOB_EVENT, "", "", "rejected (invalid spec)")
            self._send_json(400, {"error": "invalid spec"})
            return

        job_id = self._enqueue_job(spec.strip())
        if job_id is None:
            return
        self._send_json(202, {"id": job_id, "status": "queued"})

    def _enqueue_job(self, spec, reply_target=None, pr=False):
        """Record and enqueue one validated job; shared by /jobs, /slack, /linear.

        Returns the job id, or None after sending 429 when the queue is full.
        reply_target must come from an already-verified request.
        """
        job_id = secrets.token_urlsafe(12)
        job = {"spec": spec, "job_id": job_id}
        if pr:
            job["pr"] = True

        # Record BEFORE enqueueing. A worker can pick the job up the instant
        # submit() returns and write "running"/"fired"; record_job is
        # last-writer-wins, so recording afterwards could clobber a terminal
        # status with "queued" and leave a finished job polling as queued
        # forever. On the 429 path below the record is unreachable (no id is
        # handed out) and the store is bounded, so nothing leaks.
        self.dispatcher.record_job(job_id, "queued", job["spec"])
        if reply_target is not None:
            self.dispatcher.set_reply_target(job_id, reply_target)

        # Enforce the existing queue bound so a submit storm cannot fork
        # unbounded builds. 429 (not a silent drop) tells the client to retry.
        if not self.dispatcher.submit(JOB_EVENT, job):
            logging.warning(
                "Queue full; shedding job submit from %s", self.address_string()
            )
            self.dispatcher.pop_reply_target(job_id)
            log_event(JOB_EVENT, "", "", "rejected (queue full)")
            self._send_json(429, {"error": "server busy, retry later"})
            return None

        log_event(JOB_EVENT, "", job["spec"], "queued")
        return job_id

    def _handle_slack(self):
        """POST /slack -- signed slash command; enqueues a job, ephemeral reply."""
        body = self._read_body()
        if body is None:
            return
        if not self.slack_secret:
            log_event(JOB_EVENT, "", "", "rejected (no slack signing secret configured)")
            self._send_json(503, {"error": "SLACK_SIGNING_SECRET not configured"})
            return
        if not verify_slack_signature(
                self.slack_secret,
                self.headers.get("X-Slack-Request-Timestamp", ""),
                body, self.headers.get("X-Slack-Signature", "")):
            logging.warning("Invalid Slack signature from %s", self.address_string())
            log_event(JOB_EVENT, "", "", "rejected (invalid slack signature)")
            self._send_json(401, {"error": "invalid signature"})
            return
        # Verified from here on.
        ctype = (self.headers.get("Content-Type", "") or "").lower()
        if "json" in ctype:
            try:
                data = json.loads(body)
            except ValueError:
                self._send_json(400, {"error": "invalid JSON"})
                return
            if isinstance(data, dict) and data.get("type") == "url_verification":
                self._send_json(200, {"challenge": str(data.get("challenge", ""))})
                return
            self._send_json(400, {"error": "unsupported slack payload"})
            return
        form = urllib.parse.parse_qs(body.decode("utf-8", errors="replace"))
        allowed = {u.strip() for u in os.environ.get("LOKI_SLACK_ALLOWED_USERS", "").split(",") if u.strip()}
        user_id = (form.get("user_id") or [""])[0]
        if "*" not in allowed and user_id not in allowed:
            log_event(JOB_EVENT, "", "", "rejected (slack user not allowed)")
            self._send_json(200, {"response_type": "ephemeral",
                                  "text": "You are not allowed to start runs from Slack."})
            return
        text = (form.get("text") or [""])[0]
        if not valid_spec(text):
            log_event(JOB_EVENT, "", "", "rejected (invalid slack spec)")
            self._send_json(200, {"response_type": "ephemeral",
                                  "text": "Usage: /loki <spec>. Spec must be a "
                                          "one-line brief or ref, not starting with '-'."})
            return
        response_url = (form.get("response_url") or [""])[0]
        target = {"kind": "slack"}
        if response_url.startswith(SLACK_REPLY_PREFIX):
            target["response_url"] = response_url
        job_id = self._enqueue_job(text.strip(), target)
        if job_id is None:
            return
        self._send_json(200, {"response_type": "ephemeral",
                              "text": "Queued loki job %s" % job_id})

    def _handle_linear(self):
        """POST /linear -- signed Linear issue webhook; enqueues linear:<identifier>."""
        body = self._read_body()
        if body is None:
            return
        if not self.linear_secret:
            log_event(JOB_EVENT, "", "", "rejected (no linear webhook secret configured)")
            self._send_json(503, {"error": "LINEAR_WEBHOOK_SECRET not configured"})
            return
        if not verify_linear_signature(
                self.linear_secret, body, self.headers.get("Linear-Signature", "")):
            logging.warning("Invalid Linear signature from %s", self.address_string())
            log_event(JOB_EVENT, "", "", "rejected (invalid linear signature)")
            self._send_json(401, {"error": "invalid signature"})
            return
        try:
            payload = json.loads(body)
        except ValueError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "payload must be a JSON object"})
            return
        if not linear_fresh(payload):
            log_event(JOB_EVENT, "", "", "rejected (stale linear timestamp)")
            self._send_json(401, {"error": "stale or missing webhookTimestamp"})
            return
        data = payload.get("data")
        if (payload.get("type") != "Issue" or payload.get("action") != "create"
                or not isinstance(data, dict)):
            self._send_json(200, {"status": "skipped"})
            return
        ident = data.get("identifier")
        if not isinstance(ident, str) or not LINEAR_IDENTIFIER_RE.match(ident):
            self._send_json(400, {"error": "invalid issue identifier"})
            return
        if self.dispatcher.seen_delivery(self.headers.get("Linear-Delivery", "")):
            self._send_json(200, {"status": "duplicate"})
            return
        spec = "linear:%s" % ident
        if not valid_spec(spec):
            self._send_json(400, {"error": "invalid spec"})
            return
        issue_id = data.get("id")
        target = {"kind": "linear",
                  "issue_id": issue_id if isinstance(issue_id, str) else ""}
        job_id = self._enqueue_job(spec, target)
        if job_id is None:
            return
        self._send_json(202, {"id": job_id, "status": "queued"})

    def _handle_jira(self):
        """POST /jira -- signed Jira Cloud webhook; enqueues a PR-only run."""
        body = self._read_body()
        if body is None:
            return
        if not self.jira_secret:
            log_event(JOB_EVENT, "", "", "rejected (no jira webhook secret configured)")
            self._send_json(503, {"error": "JIRA_WEBHOOK_SECRET not configured"})
            return
        if not verify_jira_signature(
                self.jira_secret, body, self.headers.get("X-Hub-Signature", "")):
            logging.warning("Invalid Jira signature from %s", self.address_string())
            log_event(JOB_EVENT, "", "", "rejected (invalid jira signature)")
            self._send_json(401, {"error": "invalid signature"})
            return
        try:
            payload = json.loads(body)
        except ValueError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "payload must be a JSON object"})
            return
        if (payload.get("webhookEvent") not in JIRA_EVENTS
                or not jira_trigger_matches(
                    payload, self.jira_assignees, self.jira_labels)):
            self._send_json(200, {"status": "skipped"})
            return
        issue = payload["issue"]
        key = issue.get("key")
        if not isinstance(key, str) or not JIRA_KEY_RE.match(key):
            self._send_json(400, {"error": "invalid issue key"})
            return
        brief = build_jira_brief(issue)
        if not valid_spec(brief):
            self._send_json(400, {"error": "invalid brief"})
            return
        # Jira has no signed timestamp, and the delivery id header is not covered
        # by the HMAC, so also dedup on a hash of the signed body: a captured body
        # cannot be replayed by changing or dropping the header.
        dup_id = self.dispatcher.seen_delivery(
            self.headers.get("X-Atlassian-Webhook-Identifier", ""))
        dup_body = self.dispatcher.seen_delivery(
            "jira-body:" + hashlib.sha256(body).hexdigest())
        if dup_id or dup_body:
            self._send_json(200, {"status": "duplicate"})
            return
        job_id = self._enqueue_job(brief, {"kind": "jira", "key": key}, pr=True)
        if job_id is None:
            return
        self._send_json(202, {"id": job_id, "status": "queued"})

    def _handle_teams(self):
        """POST /teams -- Teams outgoing webhook; enqueues a PR-only run."""
        body = self._read_body()
        if body is None:
            return
        if not self.teams_secret:
            log_event(JOB_EVENT, "", "", "rejected (no teams security token configured)")
            self._send_json(503, {"error": "TEAMS_SECURITY_TOKEN not configured"})
            return
        if not verify_teams_signature(
                self.teams_secret, body, self.headers.get("Authorization", "")):
            logging.warning("Invalid Teams signature from %s", self.address_string())
            log_event(JOB_EVENT, "", "", "rejected (invalid teams signature)")
            self._send_json(401, {"error": "invalid signature"})
            return
        try:
            activity = json.loads(body)
        except ValueError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(activity, dict):
            self._send_json(400, {"error": "payload must be a JSON object"})
            return
        if not teams_fresh(activity):
            log_event(JOB_EVENT, "", "", "rejected (stale teams timestamp)")
            self._send_json(401, {"error": "stale or missing timestamp"})
            return
        brief = build_teams_brief(activity)
        if not valid_spec(brief):
            self._send_json(200, {"type": "message",
                                  "text": "Usage: @loki <brief>. One-line brief, "
                                          "not starting with '-'."})
            return
        if self.dispatcher.seen_delivery(teams_dedup_key(activity)):
            self._send_json(200, {"type": "message", "text": "Duplicate, already queued."})
            return
        job_id = self._enqueue_job(brief, pr=True)
        if job_id is None:
            return
        self._send_json(200, {"type": "message", "text": "Queued loki job %s" % job_id})

    def _handle_sentry(self):
        """POST /sentry -- Sentry alert, HMAC-verified, enqueues a fix run."""
        body = self._read_body()
        if body is None:
            return
        event_type = SENTRY_EVENT
        if not self.sentry_secret:
            logging.warning("Rejecting /sentry from %s: no Sentry secret configured",
                            self.address_string())
            log_event(event_type, "", "", "rejected (no sentry secret configured)")
            self._send_json(503, {"error": "sentry webhook secret not configured"})
            return
        sig = self.headers.get("sentry-hook-signature", "")
        if not validate_sentry_signature(self.sentry_secret, body, sig):
            logging.warning("Invalid Sentry signature from %s", self.address_string())
            log_event(event_type, "", "", "rejected (invalid signature)")
            self._send_json(401, {"error": "invalid signature"})
            return
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "payload must be a JSON object"})
            return
        action = payload.get("action", "")
        if self.dispatcher.seen_delivery(self.headers.get("Request-ID", "")):
            log_event(event_type, action, "", "duplicate")
            self._send_json(200, {"event": event_type, "status": "duplicate"})
            return
        if not self.dispatcher.submit(event_type, payload):
            log_event(event_type, action, "", "rejected (queue full)")
            self._send_json(503, {"error": "server busy, retry later"})
            return
        self._send_json(202, {"event": event_type, "action": action, "status": "queued"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/jobs":
            self._handle_job_submit()
            return
        if path == "/sentry":
            self._handle_sentry()
            return
        if path == "/slack":
            self._handle_slack()
            return
        if path == "/linear":
            self._handle_linear()
            return
        if path == "/jira":
            self._handle_jira()
            return
        if path == "/teams":
            self._handle_teams()
            return
        if path != "/webhook":
            self._send_json(404, {"error": "not found"})
            return

        body = self._read_body()
        if body is None:
            return

        event_type = self.headers.get("X-GitHub-Event", "")
        signature = self.headers.get("X-Hub-Signature-256", "")
        delivery_id = self.headers.get("X-GitHub-Delivery", "")

        # Credential separation: JOB_EVENT rides the shared EVENT_HANDLERS table
        # so it uses one dispatch path, but it is NOT a GitHub event and must
        # never be reachable with the webhook HMAC. Without this, a holder of
        # the webhook secret could POST X-GitHub-Event: loki_job and submit an
        # arbitrary spec, defeating the separate-credential requirement.
        if event_type in INTERNAL_EVENTS:
            logging.warning(
                "Rejecting %s on /webhook from %s: submits require the /jobs "
                "API and its own bearer token (Sentry uses /sentry)",
                JOB_EVENT,
                self.address_string(),
            )
            log_event(event_type, "", "", "rejected (job submit not allowed on webhook)")
            self._send_json(403, {"error": "use POST /jobs to submit a job"})
            return

        # Defect 1 fix: refuse to dispatch when no secret is configured. The
        # server stays up for ops endpoints, but webhooks are rejected with an
        # audit line. We never silently accept-all.
        if not self.secret:
            logging.warning(
                "Rejecting webhook from %s: no secret configured "
                "(set --secret or config.secret to enable dispatch)",
                self.address_string(),
            )
            log_event(event_type, "", "", "rejected (no secret configured)")
            self._send_json(503, {"error": "webhook secret not configured"})
            return

        if not validate_signature(self.secret, body, signature):
            logging.warning("Invalid webhook signature from %s", self.address_string())
            log_event(event_type, "", "", "rejected (invalid signature)")
            self._send_json(401, {"error": "invalid signature"})
            return

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "payload must be a JSON object"})
            return

        action = payload.get("action", "")

        if event_type not in EVENT_HANDLERS:
            status = "unsupported event: %s" % event_type
            log_event(event_type, action, "", status)
            self._send_json(
                200, {"event": event_type, "action": action, "status": status}
            )
            return

        # Idempotency: a redelivered webhook (same X-GitHub-Delivery) must not
        # dispatch the same build twice. Checked only after authentication so an
        # attacker cannot poison the cache. Returns 200 so GitHub stops retrying.
        if self.dispatcher.seen_delivery(delivery_id):
            logging.info(
                "Duplicate delivery %s (%s); skipping re-dispatch",
                delivery_id,
                event_type,
            )
            log_event(event_type, action, "", "duplicate (delivery %s)" % delivery_id)
            self._send_json(
                200,
                {"event": event_type, "action": action, "status": "duplicate"},
            )
            return

        if self.dispatcher.seen_intake(event_type, payload):
            log_event(event_type, action, "", "duplicate (live run for same intake key)")
            self._send_json(
                200,
                {"event": event_type, "action": action, "status": "duplicate"},
            )
            return

        # Hand off to the bounded worker queue so the listener never blocks.
        accepted = self.dispatcher.submit(event_type, payload)
        if not accepted:
            logging.warning(
                "Queue full; shedding webhook %s from %s",
                event_type,
                self.address_string(),
            )
            log_event(event_type, action, "", "rejected (queue full)")
            self._send_json(503, {"error": "server busy, retry later"})
            return

        # 202 Accepted: queued for processing, not yet fired.
        self._send_json(
            202, {"event": event_type, "action": action, "status": "queued"}
        )

    def _send_json(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class ThreadingWebhookServer(socketserver.ThreadingMixIn,
                             http.server.HTTPServer):
    """Threaded HTTP server so a slow request never serializes the listener."""

    daemon_threads = True
    allow_reuse_address = True


def write_pid_file():
    """Write PID to .loki/triggers/server.pid."""
    pid_path = get_loki_dir() / "server.pid"
    with open(pid_path, "w") as f:
        f.write(str(os.getpid()))


def main():
    parser = argparse.ArgumentParser(
        description="loki-mode GitHub webhook trigger server"
    )
    parser.add_argument("--port", type=int, default=None, help="Port to listen on (default: 7373)")
    parser.add_argument("--secret", default=None, help="GitHub webhook secret for HMAC validation")
    parser.add_argument("--dry-run", action="store_true", help="Preview triggers without running loki")
    parser.add_argument("--workers", type=int, default=None, help="Worker threads draining the dispatch queue")
    parser.add_argument("--queue-size", type=int, default=None, help="Max in-flight queued dispatches")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )

    config = load_config()
    port = args.port if args.port is not None else config.get("port", 7373)
    secret = args.secret if args.secret is not None else config.get("secret", "")
    dry_run = args.dry_run or config.get("dry_run", False)
    workers = args.workers if args.workers is not None else config.get("workers", DEFAULT_WORKERS)
    queue_size = args.queue_size if args.queue_size is not None else config.get("queue_size", DEFAULT_QUEUE_SIZE)

    # Allow GITHUB_WEBHOOK_SECRET as a non-CLI source so the secret need not
    # land in argv or the config file.
    if not secret:
        secret = os.environ.get("GITHUB_WEBHOOK_SECRET", "")

    # The /jobs bearer token has NO CLI flag on purpose: a CLI arg lands in the
    # process list where any local user can read it. Env or mounted file only.
    api_token = load_api_token()
    if api_token and secret and constant_time_equals(api_token, secret):
        logging.error(
            "LOKI_API_TOKEN is identical to the webhook secret. They "
            "authenticate different parties and MUST differ; disabling the "
            "/jobs API until a distinct token is configured."
        )
        api_token = ""

    # Sentry secret: env only (never argv). Must differ from the other two
    # credentials, since each authenticates a different party.
    sentry_secret = (os.environ.get("LOKI_SENTRY_WEBHOOK_SECRET")
                     or os.environ.get("SENTRY_CLIENT_SECRET") or "")
    if sentry_secret and (
        (secret and constant_time_equals(sentry_secret, secret))
        or (api_token and constant_time_equals(sentry_secret, api_token))
    ):
        logging.error(
            "The Sentry secret is identical to the webhook secret or API "
            "token. They MUST differ; disabling /sentry."
        )
        sentry_secret = ""

    # Slack/Linear secrets: env only. Each must differ from every other
    # credential, since each authenticates a different party.
    slack_secret, linear_secret = resolve_chat_secrets(
        os.environ, secret, api_token, sentry_secret)

    jira_secret, teams_secret = resolve_delegation_secrets(
        os.environ, [secret, api_token, sentry_secret, slack_secret, linear_secret])
    WebhookHandler.jira_assignees = _csv_set(os.environ.get("JIRA_ASSIGNEES", ""))
    WebhookHandler.jira_labels = _csv_set(os.environ.get("JIRA_LABELS", ""))

    # Persist resolved values, but never write the secret to disk.
    config["port"] = port
    config["dry_run"] = dry_run
    config["workers"] = workers
    config["queue_size"] = queue_size
    config["secret"] = ""
    save_config(config)

    dispatcher = Dispatcher(workers=workers, queue_size=queue_size, dry_run=dry_run)

    WebhookHandler.dry_run = dry_run
    WebhookHandler.secret = secret
    WebhookHandler.api_token = api_token
    WebhookHandler.sentry_secret = sentry_secret
    WebhookHandler.slack_secret = slack_secret
    WebhookHandler.linear_secret = linear_secret
    WebhookHandler.jira_secret = jira_secret
    WebhookHandler.teams_secret = teams_secret
    WebhookHandler.dispatcher = dispatcher

    signing_key, signing_kid = load_signing_key(auto_generate=False)
    WebhookHandler.signing_key = signing_key
    WebhookHandler.signing_kid = signing_kid
    WebhookHandler.retired_pubkeys = tuple(load_retired_public_keys())

    server = ThreadingWebhookServer(("", port), WebhookHandler)
    write_pid_file()

    mode_label = " [DRY-RUN]" if dry_run else ""
    logging.info("Loki trigger server starting on port %d%s", port, mode_label)
    logging.info("Webhook endpoint: POST http://localhost:%d/webhook", port)
    logging.info("Health check: GET http://localhost:%d/health", port)
    logging.info("Submit endpoint: POST http://localhost:%d/jobs", port)
    if signing_key is not None:
        logging.info(
            "Receipt attestation: ACTIVE (kid %s), public keys at "
            "GET http://localhost:%d/.well-known/jwks.json%s",
            signing_kid, port,
            " (+%d retired)" % len(WebhookHandler.retired_pubkeys)
            if WebhookHandler.retired_pubkeys else "",
        )
    elif not _ATTESTATION_AVAILABLE:
        logging.info(
            "Receipt attestation: unavailable (cryptography not installed); "
            "receipts remain UNSIGNED"
        )
    else:
        logging.info(
            "Receipt attestation: not configured; receipts remain UNSIGNED. "
            "Set LOKI_RECEIPT_SIGNING_KEY_FILE to let submitters verify a "
            "receipt without trusting this server."
        )
    logging.info("Workers: %d, queue size: %d", workers, queue_size)
    if not api_token:
        logging.warning(
            "No API token configured: ALL /jobs requests will be rejected with "
            "503. Set LOKI_API_TOKEN or LOKI_API_TOKEN_FILE to enable remote "
            "submits."
        )
    if not sentry_secret:
        logging.warning(
            "No Sentry secret configured: POST /sentry is rejected with 503. "
            "Set LOKI_SENTRY_WEBHOOK_SECRET or SENTRY_CLIENT_SECRET."
        )
    if not slack_secret:
        logging.warning(
            "No Slack signing secret configured: POST /slack is rejected with "
            "503. Set SLACK_SIGNING_SECRET."
        )
    elif not os.environ.get("LOKI_SLACK_ALLOWED_USERS", "").strip():
        logging.warning(
            "LOKI_SLACK_ALLOWED_USERS is not set: every /slack command is "
            "rejected. Set Slack user IDs, or * to allow anyone."
        )
    if not linear_secret:
        logging.warning(
            "No Linear webhook secret configured: POST /linear is rejected with "
            "503. Set LINEAR_WEBHOOK_SECRET."
        )
    if not jira_secret:
        logging.warning(
            "No Jira webhook secret configured: POST /jira is rejected with "
            "503. Set JIRA_WEBHOOK_SECRET.")
    if not teams_secret:
        logging.warning(
            "No Teams security token configured: POST /teams is rejected with "
            "503. Set TEAMS_SECURITY_TOKEN.")
    if not secret:
        logging.warning(
            "No webhook secret configured: ALL webhooks will be rejected with "
            "503. Set --secret, config.secret, or GITHUB_WEBHOOK_SECRET to "
            "enable dispatch."
        )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Trigger server stopped.")
    finally:
        dispatcher.shutdown()
        server.server_close()
        pid_path = get_loki_dir() / "server.pid"
        pid_path.unlink(missing_ok=True)


if __name__ == "__main__":
    # ponytail: SIGPIPE handler for piped output. When stdout is a pipe and the
    # reader closes early (e.g., `| head`), Python tries to write to a closed
    # pipe, raising BrokenPipeError. The default handler raises; SIG_DFL
    # silently closes. Guarded with hasattr for portability (Windows has no SIGPIPE).
    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    main()

    # ponytail: flush stdout/stderr inside try/except BrokenPipeError before
    # exit, then call os._exit() to avoid daemon thread cleanup during
    # interpreter shutdown. This prevents the "could not acquire lock for
    # <stdout> at interpreter shutdown" error when stdout is a closed pipe
    # (e.g., piped to `head`, a hook timeout, or a killed parent).
    # Only in __main__, never inside main(), so tests/callers can import main().
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except BrokenPipeError:
        pass
    os._exit(0)
