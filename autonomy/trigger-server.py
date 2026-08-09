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

Usage:
    python3 autonomy/trigger-server.py [--port PORT] [--secret SECRET] [--dry-run]
                                       [--workers N] [--queue-size N]
"""

import argparse
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
import socket
import socketserver
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

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

    def load_signing_key():
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


def handle_issues_event(payload, dry_run=False):
    """Handle issues event: opened -> loki start <issue-ref> --pr --detach."""
    action = payload.get("action", "")
    if action != "opened":
        return None, "skipped (action=%s)" % action
    issue = payload.get("issue", {})
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
    args = ["start", spec.strip(), "--detach"]
    summary = "job %s: %s" % (payload.get("job_id", "?"), spec.strip())
    # A remote submitter gates CI on this, so report the BUILD's outcome, not
    # merely that a build was launched. "fired" (launched) and "passed" must
    # never share a value.
    status = run_loki_outcome(args, dry_run=dry_run)
    if status != OUTCOME_FAILED:
        send_notification("Trigger fired: %s" % summary)
    return summary, status


# Map event name -> handler. Keeps do_POST routing declarative. JOB_EVENT rides
# the same table (and therefore the same bounded queue and worker pool) but is
# explicitly refused on the /webhook path.
EVENT_HANDLERS = {
    "issues": handle_issues_event,
    "pull_request": handle_pull_request_event,
    "workflow_run": handle_workflow_run_event,
    JOB_EVENT: handle_job_event,
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
            self._seen_deliveries[delivery_id] = True
            while len(self._seen_deliveries) > self._dedup_max:
                self._seen_deliveries.popitem(last=False)
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

        job_id = secrets.token_urlsafe(12)
        job = {"spec": spec.strip(), "job_id": job_id}

        # Record BEFORE enqueueing. A worker can pick the job up the instant
        # submit() returns and write "running"/"fired"; record_job is
        # last-writer-wins, so recording afterwards could clobber a terminal
        # status with "queued" and leave a finished job polling as queued
        # forever. On the 429 path below the record is unreachable (no id is
        # handed out) and the store is bounded, so nothing leaks.
        self.dispatcher.record_job(job_id, "queued", job["spec"])

        # Enforce the existing queue bound so a submit storm cannot fork
        # unbounded builds. 429 (not a silent drop) tells the client to retry.
        if not self.dispatcher.submit(JOB_EVENT, job):
            logging.warning(
                "Queue full; shedding job submit from %s", self.address_string()
            )
            log_event(JOB_EVENT, "", "", "rejected (queue full)")
            self._send_json(429, {"error": "server busy, retry later"})
            return

        log_event(JOB_EVENT, "", job["spec"], "queued")
        self._send_json(202, {"id": job_id, "status": "queued"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/jobs":
            self._handle_job_submit()
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
        if event_type == JOB_EVENT:
            logging.warning(
                "Rejecting %s on /webhook from %s: submits require the /jobs "
                "API and its own bearer token",
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
    WebhookHandler.dispatcher = dispatcher

    signing_key, signing_kid = load_signing_key()
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
    main()
