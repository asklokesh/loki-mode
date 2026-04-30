// Human-intervention signal handling for the autonomous runner.
//
// Source-of-truth (bash):
//   check_human_intervention()  autonomy/run.sh:11120-11256  (5-signal state machine)
//   handle_pause()              autonomy/run.sh:11259-11326  (waits for resume)
//
// The runner polls these files between iterations and acts on whichever is
// present. Order of checks is preserved exactly; the ordering matters because
// PAUSE is processed (and removed) before HUMAN_INPUT, and a STOP found
// during a pause-wait is escalated to a stop action.
//
// This module does NOT block on stdin (bash uses `read -t 1` for a 1s
// timeout per loop iter); callers requiring blocking pause-wait semantics
// should call handlePause() in their own polling loop. The default exposed
// here is single-shot: "given the current .loki state, what action do we
// take next?".

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { atomicWriteFileSync } from "./state.ts";
import { withFileLockSync } from "../util/atomic.ts";

// --- public types ----------------------------------------------------------

export type InterventionAction = "continue" | "pause" | "stop" | "input";

export interface InterventionResult {
  action: InterventionAction;
  // For action="input", the contents of HUMAN_INPUT.md (post-validation).
  // Bash exports this as $LOKI_HUMAN_INPUT (run.sh:11213).
  payload?: string;
  // Human-readable reason for the action (suitable for log lines / dashboard
  // notifications). Mirrors the log_warn / log_info messages in bash.
  reason?: string;
}

export interface CheckOptions {
  lokiDirOverride?: string;
  // Mode flags that change auto-clear behavior. Defaults match production:
  // not perpetual, not checkpoint.
  autonomyMode?: "perpetual" | "checkpoint" | "standard";
  // Whether prompt injection is enabled. Defaults to false (bash default at
  // run.sh:11189: LOKI_PROMPT_INJECTION env, false unless explicitly true).
  promptInjectionEnabled?: boolean;
  // Override "now" for hermetic tests (used only for the rejected-file
  // timestamp suffix).
  now?: Date;
}

// --- constants -------------------------------------------------------------

// Bash limit at run.sh:11199. 1 MiB.
const HUMAN_INPUT_SIZE_LIMIT_BYTES = 1024 * 1024;

// --- path helpers ----------------------------------------------------------

function resolveLokiDir(override?: string): string {
  return override ?? lokiDir();
}

interface SignalPaths {
  pause: string;
  pauseAtCheckpoint: string;
  humanInput: string;
  councilReview: string;
  stop: string;
  pausedMd: string;
  budgetExceeded: string;
  logsDir: string;
}

function signalPaths(dir: string): SignalPaths {
  return {
    pause: join(dir, "PAUSE"),
    pauseAtCheckpoint: join(dir, "PAUSE_AT_CHECKPOINT"),
    humanInput: join(dir, "HUMAN_INPUT.md"),
    councilReview: join(dir, "signals", "COUNCIL_REVIEW_REQUESTED"),
    stop: join(dir, "STOP"),
    pausedMd: join(dir, "PAUSED.md"),
    budgetExceeded: join(dir, "signals", "BUDGET_EXCEEDED"),
    logsDir: join(dir, "logs"),
  };
}

// --- helpers ---------------------------------------------------------------

// Best-effort unlink; matches `rm -f` semantics in bash.
function rmIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ENOENT or transient race -- ignore (matches bash `rm -f`).
  }
}

// Format a YYYYMMDD-HHMMSS UTC timestamp for log filenames -- matches the
// bash `$(date +%Y%m%d-%H%M%S)` calls in run.sh:11194/11202/11211.
// Note: bash uses local time for these filenames; we use UTC to keep tests
// deterministic. The on-disk shape is identical, only the wall-clock differs.
function tsForFilename(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

// Move `src` to `<logsDir>/<prefix>-<ts>.md`. Falls back to deletion if the
// move fails -- matches bash `mv ... 2>/dev/null || rm -f` (run.sh:11194).
function quarantineHumanInput(src: string, logsDir: string, prefix: string, now: Date): string {
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    // mkdir failure means we can't quarantine; fall through to delete.
  }
  const dest = join(logsDir, `${prefix}-${tsForFilename(now)}.md`);
  try {
    renameSync(src, dest);
    return dest;
  } catch {
    rmIfExists(src);
    return "";
  }
}

// --- public API ------------------------------------------------------------

// Read HUMAN_INPUT.md without acting on it. Returns null if missing or if it
// fails the bash safety checks (symlink, oversize). Does NOT delete the
// file -- that's checkHumanIntervention's job.
//
// Source: run.sh:11187-11222 (the security branch is what we mirror here).
export function readHumanInput(opts: { lokiDirOverride?: string } = {}): string | null {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  const path = signalPaths(dir).humanInput;
  if (!existsSync(path)) return null;

  // Reject symlinks (run.sh:11187 ! -L check, 11218 explicit reject).
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(path);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink()) return null;

  // Reject files exceeding 1 MiB (run.sh:11199).
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (st.size > HUMAN_INPUT_SIZE_LIMIT_BYTES) return null;

  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Single-shot check of the intervention-signal state machine. Returns the
// action the runner should take and (for input) the captured payload.
//
// Side effects mirror bash exactly: PAUSE / PAUSE_AT_CHECKPOINT / HUMAN_INPUT
// / COUNCIL_REVIEW_REQUESTED / STOP files are removed (or quarantined) as
// the bash function would. Callers must NOT call rm themselves.
//
// Bash returns 0/1/2 (continue/pause/stop). We expand "0" into either
// "continue" or "input" depending on whether HUMAN_INPUT was successfully
// captured (run.sh:11214 returns 0 with $LOKI_HUMAN_INPUT exported).
export function checkHumanIntervention(opts: CheckOptions = {}): InterventionResult {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  const sp = signalPaths(dir);
  const mode = opts.autonomyMode ?? "standard";
  const now = opts.now ?? new Date();

  // 1. PAUSE (run.sh:11127-11162). In perpetual mode, auto-clear unless
  //    BUDGET_EXCEEDED forced the pause.
  if (existsSync(sp.pause)) {
    if (mode === "perpetual") {
      if (existsSync(sp.budgetExceeded)) {
        // Budget pause cannot be auto-cleared -- bash escalates to pause.
        // We do NOT remove the PAUSE file here because the runner's
        // handlePause() loop will do that on resume.
        return {
          action: "pause",
          reason: "Budget limit reached - execution paused",
        };
      }
      // Auto-clear PAUSE + PAUSED.md and continue.
      rmIfExists(sp.pause);
      rmIfExists(sp.pausedMd);
      return {
        action: "continue",
        reason: "PAUSE file auto-cleared in perpetual mode",
      };
    }
    return {
      action: "pause",
      reason: "Execution paused via PAUSE file",
    };
  }

  // 2. PAUSE_AT_CHECKPOINT (run.sh:11165-11183). Only honored in checkpoint
  //    mode; otherwise stale and removed.
  if (existsSync(sp.pauseAtCheckpoint)) {
    if (mode === "checkpoint") {
      rmIfExists(sp.pauseAtCheckpoint);
      // Bash creates a PAUSE file then immediately enters handle_pause; we
      // surface "pause" so the caller drives the wait loop.
      try {
        atomicWriteFileSync(sp.pause, "");
      } catch {
        // If we can't write the marker, still return pause -- the caller
        // can reconcile (and the dashboard already saw the checkpoint signal).
      }
      return {
        action: "pause",
        reason: "Execution paused at checkpoint",
      };
    }
    rmIfExists(sp.pauseAtCheckpoint);
  }

  // 3. HUMAN_INPUT.md (run.sh:11187-11222). Symlink + size + injection-enabled
  //    checks come first; on success the file is moved into logs/.
  //
  // L1#5 + L1#9: The validate-then-consume sequence (lstat -> stat -> read ->
  //    rename) is a TOCTOU window. Between any two syscalls a concurrent
  //    writer (or attacker with same-uid access) could swap the regular file
  //    for a symlink, or replace its contents. We wrap the whole sequence in
  //    a cross-process advisory file lock so any other intervention checker /
  //    writer must wait. The lock is keyed on sp.humanInput so it is unique
  //    per .loki dir.
  if (existsSync(sp.humanInput)) {
    const humanResult = withFileLockSync<InterventionResult | null>(sp.humanInput, () => {
      // Re-check inside the lock: another process may have just consumed
      // the file before we acquired (race-on-consume).
      if (!existsSync(sp.humanInput)) {
        return null;
      }
      let lst: ReturnType<typeof lstatSync> | null = null;
      try {
        lst = lstatSync(sp.humanInput);
      } catch {
        lst = null;
      }
      if (lst && lst.isSymbolicLink()) {
        // run.sh:11218-11222 -- reject and remove.
        rmIfExists(sp.humanInput);
        return {
          action: "continue",
          reason: "HUMAN_INPUT.md is a symlink - rejected for security",
        };
      }
      if (!opts.promptInjectionEnabled) {
        // run.sh:11189-11194 -- quarantine to logs/ as REJECTED.
        quarantineHumanInput(sp.humanInput, sp.logsDir, "human-input-REJECTED", now);
        return {
          action: "continue",
          reason: "HUMAN_INPUT.md detected but prompt injection is DISABLED",
        };
      }
      // Size check (run.sh:11199).
      let size = 0;
      try {
        size = statSync(sp.humanInput).size;
      } catch {
        // Disappeared between exists and stat -- treat as absent.
        size = -1;
      }
      if (size > HUMAN_INPUT_SIZE_LIMIT_BYTES) {
        quarantineHumanInput(sp.humanInput, sp.logsDir, "human-input-REJECTED-TOOLARGE", now);
        return {
          action: "continue",
          reason: "HUMAN_INPUT.md exceeds 1MB size limit, rejecting",
        };
      }
      if (size >= 0) {
        let body = "";
        try {
          body = readFileSync(sp.humanInput, "utf8");
        } catch {
          rmIfExists(sp.humanInput);
          return { action: "continue", reason: "HUMAN_INPUT.md unreadable" };
        }
        if (body.length > 0) {
          // run.sh:11211 moves the consumed file into logs/ for the audit trail.
          quarantineHumanInput(sp.humanInput, sp.logsDir, "human-input", now);
          return {
            action: "input",
            payload: body,
            reason: "Human input detected",
          };
        }
        // Empty file -- bash falls through (does not move). We do the same.
      }
      return null;
    });
    if (humanResult !== null) return humanResult;
  }

  // 4. COUNCIL_REVIEW_REQUESTED (run.sh:11225-11246). The bash version may
  //    invoke a council vote and stop on approval; we surface this as a
  //    "continue" with the signal removed because the council subsystem is
  //    not yet ported. Future work: wire this to the TS council module.
  if (existsSync(sp.councilReview)) {
    rmIfExists(sp.councilReview);
    return {
      action: "continue",
      reason: "Council force-review requested from dashboard",
    };
  }

  // 5. STOP (run.sh:11249-11253). Highest-priority terminal signal.
  if (existsSync(sp.stop)) {
    rmIfExists(sp.stop);
    return {
      action: "stop",
      reason: "STOP file detected - stopping execution",
    };
  }

  return { action: "continue" };
}

// --- handlePause -----------------------------------------------------------

export interface HandlePauseOptions {
  lokiDirOverride?: string;
  // Poll interval in ms; bash uses `sleep 1` (run.sh:11318).
  pollIntervalMs?: number;
  // Hard ceiling on total wait time. The bash version waits indefinitely;
  // tests must override this to keep the suite bounded. Default: no ceiling.
  maxWaitMs?: number;
  // Override the PAUSED.md body (defaults to the bash heredoc text).
  pausedMdBody?: string;
}

export interface HandlePauseResult {
  // Mirrors bash return code: 0 = resumed normally, 1 = STOP signaled mid-pause.
  outcome: "resumed" | "stop";
  // True if the maxWaitMs ceiling was hit (test escape hatch).
  timedOut: boolean;
}

// Default contents of .loki/PAUSED.md, byte-equivalent to run.sh:11280-11293.
const DEFAULT_PAUSED_MD = `# Loki Mode - Paused

Execution is currently paused. Options:

1. **Resume**: Press Enter in terminal or \`rm .loki/PAUSE\`
2. **Add Instructions**: \`echo "Focus on fixing the login bug" > .loki/HUMAN_INPUT.md\`
3. **Stop**: \`touch .loki/STOP\`

Current state is saved. You can inspect:
- \`.loki/CONTINUITY.md\` - Progress and context
- \`.loki/STATUS.txt\` - Current status
- \`.loki/logs/\` - Session logs
`;

// Async loop equivalent of handle_pause (run.sh:11259-11326). Writes
// .loki/PAUSED.md, then polls until either PAUSE is removed (resume) or
// STOP appears (stop). Does NOT read stdin -- the caller is expected to
// drive resume from outside (signal, file removal, dashboard).
export async function handlePause(opts: HandlePauseOptions = {}): Promise<HandlePauseResult> {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  const sp = signalPaths(dir);
  const interval = opts.pollIntervalMs ?? 1000;
  const ceiling = opts.maxWaitMs;
  const startMs = Date.now();
  const body = opts.pausedMdBody ?? DEFAULT_PAUSED_MD;

  try {
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(sp.pausedMd, body);
  } catch {
    // Non-fatal: PAUSED.md is informational. The wait still proceeds.
  }

  try {
    for (;;) {
      // STOP escalates immediately (run.sh:11298-11303).
      if (existsSync(sp.stop)) {
        rmIfExists(sp.stop);
        rmIfExists(sp.pausedMd);
        return { outcome: "stop", timedOut: false };
      }
      // PAUSE removed by external actor (CLI / dashboard) -> resume.
      if (!existsSync(sp.pause)) {
        rmIfExists(sp.pausedMd);
        return { outcome: "resumed", timedOut: false };
      }
      if (ceiling !== undefined && Date.now() - startMs >= ceiling) {
        rmIfExists(sp.pausedMd);
        return { outcome: "resumed", timedOut: true };
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  } finally {
    // Defensive cleanup if a synchronous throw escaped the loop.
    rmIfExists(sp.pausedMd);
  }
}
