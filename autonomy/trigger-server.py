#!/usr/bin/env python3
"""
trigger-server.py - GitHub webhook receiver for loki-mode event-driven execution.

Listens for GitHub webhook events and automatically runs `loki start` in
response. Supports constant-time HMAC-SHA256 signature validation, a bounded
worker queue so a webhook storm cannot fork unbounded builds, child-process
reaping (no zombies), and event logging.

Security note: a webhook secret is REQUIRED. If no secret is configured the
server still starts (so /health and /status stay available for operators), but
every webhook POST is rejected with 503 and an audit log line. The server never
silently accepts unauthenticated webhooks.

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
import socket
import socketserver
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path


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


def save_config(config):
    """Save trigger config to .loki/triggers/config.json."""
    config_path = get_loki_dir() / "config.json"
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)


# log_event writes append lines to a shared file from multiple worker threads,
# so serialize writes to avoid interleaved JSON lines.
_log_lock = threading.Lock()


def log_event(event_type, action, payload_summary, status):
    """Append event to .loki/triggers/events.log (thread-safe)."""
    log_path = get_loki_dir() / "events.log"
    timestamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
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


def run_loki_command(args, dry_run=False):
    """Run a loki command synchronously and reap it; or print it if dry_run.

    Returns True if the command was launched and exited 0 (or backgrounded
    cleanly within the wait window), False if the launch failed or it exited
    non-zero. The child is always waited on, so no zombies accumulate. stderr
    is captured on failure so a broken dispatch is diagnosable.

    This is invoked from worker threads, so blocking here does not block the
    HTTP listener.
    """
    cmd = ["loki"] + args
    if dry_run:
        logging.info("[DRY-RUN] Would run: %s", " ".join(cmd))
        return True
    logging.info("Running: %s", " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (FileNotFoundError, OSError) as e:
        logging.error("Failed to launch %s: %s", " ".join(cmd), e)
        return False

    try:
        # Wait (and thereby reap) the child. A --detach launch returns quickly;
        # this bound only guards against a wedged launch.
        _, stderr = proc.communicate(timeout=DISPATCH_WAIT_SECONDS)
    except subprocess.TimeoutExpired:
        # The dispatch is still running past our wait window. We stop blocking
        # the worker thread, but the child is NOT abandoned: a one-shot daemon
        # reaper thread waits on it so it is always reaped (no zombie) while
        # THIS process is alive, and the OS reparents it after we exit. This
        # keeps the "always waited on, no zombies" guarantee honest.
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
        return True

    if proc.returncode == 0:
        logging.info("Dispatch pid=%d completed (exit 0)", proc.pid)
        return True

    stderr_text = ""
    if stderr:
        stderr_text = stderr.decode("utf-8", errors="replace").strip()
    logging.error(
        "Dispatch pid=%d exited %d: %s",
        proc.pid,
        proc.returncode,
        stderr_text or "(no stderr)",
    )
    return False


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


# Map GitHub event name -> handler. Keeps do_POST routing declarative.
EVENT_HANDLERS = {
    "issues": handle_issues_event,
    "pull_request": handle_pull_request_event,
    "workflow_run": handle_workflow_run_event,
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
                 dry_run=False, dedup_size=DEFAULT_DEDUP_SIZE):
        self.dry_run = dry_run
        self.queue = queue.Queue(maxsize=max(1, queue_size))
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
                dispatch_event(event_type, payload, dry_run=self.dry_run)
            finally:
                self.queue.task_done()

    def shutdown(self):
        self._stop.set()


class WebhookHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for GitHub webhooks."""

    # Set on the class in main() before the server starts.
    dry_run = False
    secret = ""
    dispatcher = None

    # Cap the body we will read so a huge POST cannot exhaust memory.
    MAX_BODY_BYTES = 5 * 1024 * 1024

    def log_message(self, format, *args):
        logging.info("%s - %s", self.address_string(), format % args)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "service": "loki-trigger-server"})
        elif self.path == "/status":
            config = load_config()
            self._send_json(200, {
                "status": "running",
                "dry_run": self.dry_run,
                "port": config.get("port", 7373),
                "enabled_events": config.get("enabled_events", []),
                "secret_configured": bool(self.secret),
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/webhook":
            self._send_json(404, {"error": "not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "invalid Content-Length"})
            return
        if content_length < 0 or content_length > self.MAX_BODY_BYTES:
            self._send_json(413, {"error": "payload too large"})
            return

        # L3 fix: bound the body read so a slow or under-delivering client (a
        # slow-loris that drips or never finishes the body) cannot tie up a
        # worker thread BEFORE authentication. A stalled read raises
        # socket.timeout; we drop the connection rather than block forever.
        prev_timeout = self.connection.gettimeout()
        self.connection.settimeout(BODY_READ_TIMEOUT_SECONDS)
        try:
            body = self.rfile.read(content_length)
        except (socket.timeout, TimeoutError, ConnectionError, OSError):
            logging.warning(
                "Dropping slow/incomplete webhook body from %s",
                self.address_string(),
            )
            try:
                self._send_json(408, {"error": "request body timeout"})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        finally:
            try:
                self.connection.settimeout(prev_timeout)
            except OSError:
                pass
        if len(body) != content_length:
            # Client closed before delivering the declared body. Refuse rather
            # than authenticate a truncated payload.
            self._send_json(400, {"error": "incomplete request body"})
            return

        event_type = self.headers.get("X-GitHub-Event", "")
        signature = self.headers.get("X-Hub-Signature-256", "")
        delivery_id = self.headers.get("X-GitHub-Delivery", "")

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
    WebhookHandler.dispatcher = dispatcher

    server = ThreadingWebhookServer(("", port), WebhookHandler)
    write_pid_file()

    mode_label = " [DRY-RUN]" if dry_run else ""
    logging.info("Loki trigger server starting on port %d%s", port, mode_label)
    logging.info("Webhook endpoint: POST http://localhost:%d/webhook", port)
    logging.info("Health check: GET http://localhost:%d/health", port)
    logging.info("Workers: %d, queue size: %d", workers, queue_size)
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
