// Crash-capture hook for the Bun runner (Crash Reporting Phase 0, local-only).
//
// Parity rule: there is exactly ONE scrubber implementation -- the standalone
// Python script at autonomy/lib/crash_capture.py (which imports the shared
// crash_redact / proof_redact chokepoint). Both routes call it:
//   - bash: autonomy/crash.sh loki_crash_capture()
//   - Bun:  this module (installCrashHandlers + captureCrash).
// This keeps the whitelist, redaction, and fingerprint in a single codepath so
// the two routes can never drift. See docs/CRASH-REPORTING-PLAN.md sections 5a,
// 5b, and Phase 0.
//
// FAIL CLOSED: if python3 cannot be resolved, NO local write happens. Only the
// Python module can scrub, and an unscrubbed local write would violate the
// no-leak guarantee (mirrors proof.ts:216-227 "never publish an unredacted
// artifact"). Phase 0 has ZERO network egress regardless.

import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../util/paths.ts";
import { findPython3 } from "../util/python.ts";
import { run as shellRun } from "../util/shell.ts";

// Short, hard cap so a hung python never blocks process exit on the crash path.
const CAPTURE_TIMEOUT_MS = 3000;

// collectionEnabled: synchronous mirror of autonomy/crash.sh loki_collection_enabled.
// PRIVACY.md and the first-run copy promise the opt-out disables crash reporting,
// so capture must skip the local write when any switch is set. Sync because the
// exception-handler path is sync. Returns false (disabled) on any of:
//   - env LOKI_TELEMETRY=off (case-insensitive)
//   - env LOKI_TELEMETRY_DISABLED=true
//   - env DO_NOT_TRACK=1
//   - ${HOME}/.loki/config contains a line matching ^TELEMETRY_DISABLED=true
function collectionEnabled(): boolean {
  if ((process.env["LOKI_TELEMETRY"] ?? "").toLowerCase() === "off") {
    return false;
  }
  if (process.env["LOKI_TELEMETRY_DISABLED"] === "true") {
    return false;
  }
  if (process.env["DO_NOT_TRACK"] === "1") {
    return false;
  }
  try {
    const cfg = join(homedir(), ".loki", "config");
    if (existsSync(cfg)) {
      const text = readFileSync(cfg, "utf8");
      for (const line of text.split("\n")) {
        if (line.replace(/\r$/, "") === "TELEMETRY_DISABLED=true") {
          return false;
        }
      }
    }
  } catch {
    // A config read error must not enable capture by surprise, but it also must
    // not crash the crash path. Treat an unreadable config as "no opt-out line"
    // (matches the bash grep, which returns non-zero/false on read failure).
  }
  return true;
}

// Guard so the same fatal error is never captured twice (uncaughtException then
// a downstream nonzero-exit wrapper would otherwise write two files).
let captured = false;

export type CrashOpts = {
  errorClass: string;
  message: string;
  stack?: string;
  rarvPhase?: string;
  exitCode?: number;
  frictionKind?: string;
  targetDir?: string;
};

// Resolve the standalone capture script relative to the repo root (matches
// run.sh's "$SCRIPT_DIR/lib/crash_capture.py" and proof.ts:27).
function capturePath(): string {
  return resolve(REPO_ROOT, "autonomy", "lib", "crash_capture.py");
}

// Build the crash_capture.py argv. Pure -- shared by the async and sync paths so
// the two can never diverge. Stack is passed as a single argv element (array
// form, no shell) so newlines and size are safe.
export function buildCrashArgs(script: string, opts: CrashOpts): string[] {
  const args: string[] = [
    script,
    "--error-class",
    opts.errorClass,
    "--message",
    opts.message,
  ];
  if (opts.stack !== undefined) {
    args.push("--stack", opts.stack);
  }
  if (opts.rarvPhase !== undefined) {
    args.push("--rarv-phase", opts.rarvPhase);
  }
  if (opts.exitCode !== undefined) {
    args.push("--exit-code", String(opts.exitCode));
  }
  if (opts.frictionKind !== undefined) {
    args.push("--friction-kind", opts.frictionKind);
  }
  args.push("--target-dir", opts.targetDir ?? process.cwd());
  return args;
}

// Synchronous python3 resolver mirroring util/python.ts findPython3() priority.
// findPython3() is async and cannot be awaited reliably inside an exit-path
// handler, so the handler uses this blocking variant. Returns null if none
// found (fail closed -- no write).
function findPython3Sync(): string | null {
  const homebrew = "/opt/homebrew/bin/python3.12";
  if (existsSync(homebrew)) {
    return homebrew;
  }
  for (const cand of ["python3.12", "python3"]) {
    try {
      const r = spawnSync("sh", ["-c", `command -v ${cand}`], {
        timeout: CAPTURE_TIMEOUT_MS,
        encoding: "utf8",
      });
      if (r.status === 0) {
        const p = (r.stdout || "").trim();
        if (p) return p;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// captureCrash: async, best-effort. Resolve python via findPython3 (FAIL CLOSED
// if null -- no local write without scrub), spawn crash_capture.py with the
// args, NEVER throw, swallow all errors. Used off the exit path (e.g. friction
// signals where the process keeps running).
export async function captureCrash(opts: CrashOpts): Promise<void> {
  try {
    if (!collectionEnabled()) {
      // Opt-out honored (PRIVACY.md promise): no local write when disabled.
      return;
    }
    const script = capturePath();
    if (!existsSync(script)) {
      return;
    }
    const py = await findPython3();
    if (!py) {
      // FAIL CLOSED: no scrubber, no local write.
      return;
    }
    const args = buildCrashArgs(script, opts);
    await shellRun([py, ...args], { timeoutMs: CAPTURE_TIMEOUT_MS });
  } catch {
    // Best-effort: capture must never disturb the caller.
  }
}

// captureCrashSync: blocking variant for the exit path (uncaughtException /
// unhandledRejection / nonzero terminal exit). spawnSync so the capture
// completes BEFORE the process dies. NEVER throws. FAIL CLOSED if no python3.
function captureCrashSync(opts: CrashOpts): void {
  try {
    if (!collectionEnabled()) {
      // Opt-out honored (PRIVACY.md promise): no local write when disabled.
      // installCrashHandlers still re-logs and exits 1; only the WRITE is skipped.
      return;
    }
    const script = capturePath();
    if (!existsSync(script)) {
      return;
    }
    const py = findPython3Sync();
    if (!py) {
      // FAIL CLOSED: no scrubber, no local write.
      return;
    }
    const args = buildCrashArgs(script, opts);
    spawnSync(py, args, {
      timeout: CAPTURE_TIMEOUT_MS,
      stdio: "ignore",
    });
  } catch {
    // Best-effort: capture must never disturb the exit path.
  }
}

// Note (conservative capture, plan section 9): there is deliberately NO
// terminal-exit wrapper. A plain nonzero exit from a command that returned a
// status cleanly (doctor failing a check, `loki crash show <bad-id>`, a usage
// error) is NOT a crash and must not write a crash report -- otherwise
// inspecting a crash would generate a crash and flood .loki/crash/ with benign
// usage errors. Capture is limited to genuine unhandled exceptions (the two
// handlers below, which already capture + exit 1) plus the explicit friction
// calls via captureCrash. This is the conservative posture the plan wants.

// Normalize an unknown thrown/rejected value into an error class + message +
// optional stack. unhandledRejection reasons are frequently NOT Error objects.
function classify(
  err: unknown,
  fallbackClass: string,
): { errorClass: string; message: string; stack?: string } {
  if (err instanceof Error) {
    const errorClass = err.name && err.name.length > 0 ? err.name : fallbackClass;
    const out: { errorClass: string; message: string; stack?: string } = {
      errorClass,
      message: err.message,
    };
    if (err.stack) {
      out.stack = err.stack;
    }
    return out;
  }
  return { errorClass: fallbackClass, message: String(err) };
}

// installCrashHandlers: register uncaughtException / unhandledRejection handlers
// that capture the crash synchronously THEN preserve normal Node crash
// semantics (log to stderr, exit 1). Capture happens BEFORE exit so the local
// artifact is written; we do NOT swallow the crash. Idempotent.
let installed = false;
export function installCrashHandlers(): void {
  if (installed) {
    return;
  }
  installed = true;

  process.on("uncaughtException", (err: Error) => {
    if (!captured) {
      captured = true;
      const c = classify(err, "UncaughtException");
      captureCrashSync({
        errorClass: c.errorClass,
        message: c.message,
        ...(c.stack !== undefined ? { stack: c.stack } : {}),
        exitCode: 1,
      });
    }
    // Preserve crash semantics: log the error as Node would, then die nonzero.
    try {
      process.stderr.write(`${(err && err.stack) || String(err)}\n`);
    } catch {
      /* logging must not throw on the exit path */
    }
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    if (!captured) {
      captured = true;
      const c = classify(reason, "UnhandledRejection");
      captureCrashSync({
        errorClass: c.errorClass,
        message: c.message,
        ...(c.stack !== undefined ? { stack: c.stack } : {}),
        exitCode: 1,
      });
    }
    try {
      const detail =
        reason instanceof Error ? reason.stack || reason.message : String(reason);
      process.stderr.write(`Unhandled promise rejection: ${detail}\n`);
    } catch {
      /* logging must not throw on the exit path */
    }
    process.exit(1);
  });
}
