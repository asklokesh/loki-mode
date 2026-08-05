// Phase 5 Dev D2 -- second slice of completion-council.sh port.
//
// Bash source: autonomy/completion-council.sh (1771 LOC, 19 functions).
// Spec: loki-ts/docs/phase5-research/completion_council.md
//
// First slice (D1) ported councilInit + defaultCouncil.{shouldStop,trackIteration}.
// Second slice (D2) replaces the four STUBs with real implementations:
//
//   - councilEvaluate(ctx)        -- bash council_evaluate (line ~1340)
//   - councilAggregateVotes(votes)-- bash council_aggregate_votes (line ~1137)
//   - councilDevilsAdvocate(votes)-- bash council_devils_advocate +
//                                     council_devils_advocate_review (~866, ~1236)
//   - councilWriteReport(verdicts)-- bash council_write_report (line ~1714)
//
// Voter dispatch is INJECTABLE: callers (and tests) supply the voter
// implementations rather than this module shelling out to a real provider
// CLI. The default voter set in DEFAULT_VOTERS is heuristic-only so the
// module remains usable without a provider, mirroring the bash
// council_heuristic_review fallback path.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// RUN-25 iter 17 (Wave C #1/#3): read only the LAST `n` lines of a file by
// reading at most `maxBytes` from its tail, instead of readFileSync-ing the whole
// file and slicing. The council devil's-advocate reads the unbounded, append-only
// events.jsonl (and each test log) on EVERY completion attempt; a full read is
// O(filesize) and grows with run length (micro-bench: 3.5MB file 0.89ms vs
// 0.026ms tail = 34x; 17.6MB 5.11ms vs 0.024ms = 210x). This ports the bash
// `tail -50` the TS side had regressed away from. Returns the last n lines (or
// fewer). 64KB holds ~400 lines at ~150B, comfortably covering the -50/-30 tails.
// Fail-soft: any error returns null (caller treats it as "could not read").
export function tailLines(path: string, n: number, maxBytes = 65536): string[] | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const readLen = Math.min(size, maxBytes);
    const start = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    let got = 0;
    while (got < readLen) {
      const r = readSync(fd, buf, got, readLen - got, start + got);
      if (r <= 0) break;
      got += r;
    }
    // If we did not read from byte 0, the first (partial) line may be truncated;
    // slice(-n) discards it whenever n < available lines, which is the intent.
    const text = buf.toString("utf-8", 0, got);
    return text.split("\n").slice(-n);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
import type { CouncilHook, RunnerContext } from "./types.ts";
import { lokiDir as defaultLokiDir } from "../util/paths.ts";
import { claudeFlagSupported } from "../providers/claude_flags.ts";

// Local shim. Phase C dispatch path only checks support synchronously; the
// help cache must be populated by the caller chain in production (the
// runtime currently calls ensureClaudeHelpCache() in providers.ts). When the
// cache is empty, claudeFlagSupported returns false (conservative), which
// means we fall through to the heuristic -- the desired safe default.
function claudeFlagSupportedShim(flag: string): boolean {
  return claudeFlagSupported(flag);
}

// ---------------------------------------------------------------------------
// Atomic write helper (POSIX rename is atomic within a directory).
// ---------------------------------------------------------------------------

let _tmpCounter = 0;
function atomicWriteFile(target: string, contents: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${++_tmpCounter}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// councilInit -- bash council_init() (completion-council.sh:111-145).
// (unchanged from D1 slice -- DO NOT TOUCH per task brief.)
// ---------------------------------------------------------------------------

export type CouncilState = {
  initialized: true;
  enabled: true;
  total_votes: number;
  approve_votes: number;
  reject_votes: number;
  last_check_iteration: number;
  consecutive_no_change: number;
  done_signals: number;
  convergence_history: unknown[];
  verdicts: unknown[];
  prd_path: string | null;
  // Written by trackIteration (mirrors the bash state.json keys). Optional so a
  // state file written by councilInit (or by the bash route before any
  // trackIteration call) still parses.
  total_done_signals?: number;
  last_diff_hash?: string;
  files_changed?: number;
  last_track_iteration?: number;
  // v8 harness intelligence (3b): confidence-spike re-check. Highest confidence
  // asserted so far, and whether a spike is currently pending re-verification.
  last_confidence?: number;
  confidence_spike_pending?: boolean;
  confidence_spikes_total?: number;
};

export async function councilInit(prdPath: string | undefined): Promise<void> {
  const stateDir = resolve(defaultLokiDir(), "council");
  mkdirSync(stateDir, { recursive: true });

  const state: CouncilState = {
    initialized: true,
    enabled: true,
    total_votes: 0,
    approve_votes: 0,
    reject_votes: 0,
    last_check_iteration: 0,
    consecutive_no_change: 0,
    done_signals: 0,
    convergence_history: [],
    verdicts: [],
    prd_path: prdPath ?? null,
  };

  atomicWriteFile(resolve(stateDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// defaultCouncil -- minimal CouncilHook (unchanged from D1 slice -- DO NOT
// TOUCH per task brief).
// ---------------------------------------------------------------------------

// Completion-like language the bash route greps for in the last 200 log lines
// when no STRUCTURED signal is present. Byte-mirrors the bash alternation in
// council_track_iteration (completion-council.sh).
const DONE_LANGUAGE_RE =
  /(all tests pass|all requirements met|implementation complete|feature complete|task complete|project complete|all tasks done|everything is working)/i;

// One convergence fingerprint for the working tree, mirroring bash:
//   md5(git diff --stat HEAD) - md5(git diff --cached --stat) - <short commit>
// All three components matter. Unstaged-only would miss a `git add`, and
// omitting the commit hash would treat a COMMITTED iteration as "no change"
// (bash BUG-QG-004). The exact digest need not equal bash's byte-for-byte --
// each route only ever compares against its OWN previous value -- but the
// SENSITIVITY must match, or the valve fires while real work is happening.
// Fail-soft: any failing git call contributes "unknown", exactly like bash's
// `|| echo "unknown"`.
function diffFingerprint(cwd: string): string {
  const part = (args: string[]): string => {
    try {
      const out = execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return createHash("md5").update(out).digest("hex");
    } catch {
      return "unknown";
    }
  };
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["log", "--oneline", "-1"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\s+/)[0] || "unknown";
  } catch {
    commit = "unknown";
  }
  return `${part(["diff", "--stat", "HEAD"])}-${part(["diff", "--cached", "--stat"])}-${commit}`;
}

// ---------------------------------------------------------------------------
// v8 harness intelligence (3b): CONFIDENCE-SPIKE RE-CHECK.
//
// jcode's measured finding: an agent asserting maximal confidence is NOT
// evidence the work is done. A confidence jump to ~100 correlates with the
// agent having stopped looking, not with correctness. Loki already refuses to
// take a self-report as a gate (the whole council exists for that), so this
// adds the cheap complement: notice the spike and force ONE extra verification.
//
// STRICTLY ADDITIVE -- this is the load-bearing safety property. A confidence
// spike can only ever ADD a verification pass. There is deliberately no branch
// anywhere below that lets high confidence SKIP, shorten, or satisfy a gate:
// that would be a false-green vector, the exact class the trust core exists to
// prevent. High confidence makes the engine look HARDER, never less hard.
//
// Default ON but effectively inert unless the agent actually emits a
// confidence figure; no new required knob. Tune with
// LOKI_CONFIDENCE_SPIKE_DELTA (default 40) / _MIN (default 90), or disable
// entirely with LOKI_CONFIDENCE_SPIKE=0.
// ---------------------------------------------------------------------------

// Confidence self-reports the agent may emit, e.g. "confidence: 95",
// "confidence 100%", "I am 98% confident". Deliberately narrow: a loose pattern
// would match unrelated percentages (coverage, progress) and force pointless
// re-verification. Returns the HIGHEST value seen in the sampled tail, since a
// single maximal claim is the signal even if hedged elsewhere.
const CONFIDENCE_RE = /confiden(?:ce|t)\D{0,12}(\d{1,3})\s*%?|(\d{1,3})\s*%\s*confiden/gi;

export function extractConfidence(lines: readonly string[]): number | null {
  let best: number | null = null;
  for (const line of lines) {
    CONFIDENCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONFIDENCE_RE.exec(line)) !== null) {
      const raw = m[1] ?? m[2];
      if (raw === undefined) continue;
      const n = Number.parseInt(raw, 10);
      // >100 is not a confidence figure (version strings, byte counts).
      if (!Number.isFinite(n) || n < 0 || n > 100) continue;
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

// Is this iteration's confidence a SPIKE worth re-verifying? Two arms, either
// of which fires:
//   - a jump of >= delta from the previous reading, or
//   - landing at/above min (near-certainty) having not been there before.
// The second arm matters because an agent that opens at 100 never "jumps".
export function isConfidenceSpike(
  prev: number | null | undefined,
  current: number | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["LOKI_CONFIDENCE_SPIKE"] === "0") return false;
  if (current === null) return false;
  const delta = envIntFrom(env, "LOKI_CONFIDENCE_SPIKE_DELTA", 40);
  const min = envIntFrom(env, "LOKI_CONFIDENCE_SPIKE_MIN", 90);
  if (current >= min && (prev === null || prev === undefined || prev < min)) return true;
  if (prev === null || prev === undefined) return false;
  return current - prev >= delta;
}

// Non-destructively PEEK the structured completion signals. The council owns
// CONSUMPTION of these files; tracking must never delete them or a later
// consumer would see no claim. Same two paths the bash route tests.
function hasStructuredDoneSignal(targetDir: string): boolean {
  const sig = resolve(targetDir, ".loki", "signals");
  return (
    existsSync(resolve(sig, "COMPLETION_REQUESTED")) ||
    existsSync(resolve(sig, "TASK_COMPLETION_CLAIMED"))
  );
}

export const defaultCouncil: CouncilHook = {
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    // Force-stop safety valves, ported from bash council_should_stop
    // ("Safety valve" / "Safety valve 2", completion-council.sh). These read
    // the counters trackIteration persists, so this route now FAILS CHEAP
    // instead of running to max-iterations/timeout.
    //
    // Returning true here is a FORCE STOP, never a council approval: the work
    // is NOT verified-complete. The bash route flags this distinction with
    // COUNCIL_FORCE_STOPPED so a force-stop is not reported as a verified
    // product; callers on this route must treat a true from these valves the
    // same way.
    const stateDir = resolve(defaultLokiDir(), "council");
    const state = readCouncilState(stateDir);

    const stagnationLimit = envInt("LOKI_COUNCIL_STAGNATION_LIMIT", 5);
    const doneSignalLimit = envInt("LOKI_COUNCIL_DONE_SIGNAL_LIMIT", 3);

    // Valve 1: stagnation. Bash force-stops at 2x the limit (the plain limit
    // only triggers a council review); mirror that 2x exactly.
    const noChange = state.consecutive_no_change ?? 0;
    if (stagnationLimit > 0 && noChange >= stagnationLimit * 2) return true;

    // Valve 2: the agent keeps claiming done. TOTAL (monotonic), not the
    // consecutive counter -- an agent that alternates claim/no-claim must still
    // trip this, which is precisely the case that burned a real build to its
    // timeout when only fuzzy log language was counted.
    //
    // 3b INTERACTION, and the reason the order here matters: a pending
    // confidence spike DELAYS this force-stop by exactly one iteration so the
    // spike gets verified rather than terminated on. It can never delay valve 1
    // (stagnation), which is checked above and stays untouched -- a stagnant
    // build must still fail cheap no matter how confident the agent sounds.
    //
    // The delay is consumed here (one-shot). Without consuming it, a run that
    // keeps re-spiking could postpone the valve forever, converting a safety
    // valve into a budget leak.
    const totalDone = state.total_done_signals ?? 0;
    if (doneSignalLimit > 0 && totalDone >= doneSignalLimit) {
      if (state.confidence_spike_pending === true) {
        const stateDir2 = resolve(defaultLokiDir(), "council");
        try {
          state.confidence_spike_pending = false;
          atomicWriteFile(
            resolve(stateDir2, "state.json"),
            JSON.stringify(state, null, 2) + "\n",
          );
        } catch {
          // Fail-safe: if the consume-write fails we must NOT keep returning
          // false forever (that would disable the valve). Fall through to the
          // force-stop instead -- erring toward stopping, never toward running.
          return true;
        }
        return false; // one extra iteration, so the spike is verified not trusted
      }
      return true;
    }

    return false;
  },
  async trackIteration(logFile: string): Promise<void> {
    // Convergence tracking, ported from bash council_track_iteration
    // (completion-council.sh). Previously this appended a row of placeholder
    // ZEROS, so the stagnation and done-signal valves could never arm on the
    // SDK/TS route: a build that claimed done every iteration (structured
    // COMPLETION_REQUESTED) while the council rejected would run to
    // max-iterations or its timeout. On the bash route that exact bug was
    // measured on real builds at 11 identical structured claims, 0 counted, a
    // 60-minute timeout at roughly $34.
    //
    // State lives in state.json, NOT in module memory: bash keeps these as
    // shell globals that survive within one sourced process, but this function
    // is called per-iteration and must survive a process restart. Read,
    // increment, write back.
    const stateDir = resolve(defaultLokiDir(), "council");
    mkdirSync(stateDir, { recursive: true });
    const state = readCouncilState(stateDir);

    const targetDir = process.env.TARGET_DIR || process.cwd();

    // --- no-change detection -------------------------------------------------
    const combinedHash = diffFingerprint(targetDir);
    const prevHash = state.last_diff_hash ?? "";
    const consecutiveNoChange =
      combinedHash === prevHash ? (state.consecutive_no_change ?? 0) + 1 : 0;

    // --- done-signal detection ----------------------------------------------
    // Structured signal FIRST (the default since v6.82.0); the fuzzy log grep
    // is only consulted when the structured check came back negative, matching
    // bash's precedence exactly.
    let doneThisIter = hasStructuredDoneSignal(targetDir);
    // Read the tail ONCE and reuse it for both the done-language grep and the
    // confidence scan, rather than walking the same file twice per iteration.
    let tailCache: string[] | null = null;
    if (logFile && existsSync(logFile)) tailCache = tailLines(logFile, 200);
    if (!doneThisIter && tailCache) {
      doneThisIter = tailCache.some((l) => DONE_LANGUAGE_RE.test(l));
    }

    // --- confidence-spike detection (3b) -------------------------------------
    // Purely observational here: record that a spike happened so shouldStop can
    // force ONE extra verification. Never suppresses anything.
    const currentConfidence = tailCache ? extractConfidence(tailCache) : null;
    const spiked = isConfidenceSpike(state.last_confidence, currentConfidence);
    if (spiked) {
      state.confidence_spike_pending = true;
      state.confidence_spikes_total = (state.confidence_spikes_total ?? 0) + 1;
    }
    // Only advance the baseline when a figure was actually read; a silent
    // iteration must not reset the high-water mark and re-arm the same spike.
    if (currentConfidence !== null) state.last_confidence = currentConfidence;

    // Two counters with DIFFERENT reset rules, and mixing them up would stop
    // the valve arming: done_signals is CONSECUTIVE (resets the moment the
    // agent stops claiming done), total_done_signals is MONOTONIC and is what
    // valve 2 reads.
    const doneSignals = doneThisIter ? (state.done_signals ?? 0) + 1 : 0;
    const totalDoneSignals = doneThisIter
      ? (state.total_done_signals ?? 0) + 1
      : (state.total_done_signals ?? 0);

    let filesChanged = 0;
    try {
      const out = execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd: targetDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      filesChanged = out.split("\n").filter((l) => l.trim() !== "").length;
    } catch {
      filesChanged = 0;
    }

    const iteration = readIterationFromState(stateDir);
    const timestamp = Math.floor(Date.now() / 1000);

    // Row keeps SIX fields (bash writes five). The trailing logFile column is
    // pre-existing on this route and a reader may depend on it, so the counters
    // fill fields 3-5 in bash order and logFile stays last.
    const row = `${timestamp}|${iteration}|${filesChanged}|${consecutiveNoChange}|${doneSignals}|${logFile}\n`;
    appendFileSync(resolve(stateDir, "convergence.log"), row);

    state.consecutive_no_change = consecutiveNoChange;
    state.done_signals = doneSignals;
    state.total_done_signals = totalDoneSignals;
    state.last_diff_hash = combinedHash;
    state.files_changed = filesChanged;
    state.last_track_iteration = iteration;
    // confidence_spike_pending / _total / last_confidence were set above.
    atomicWriteFile(resolve(stateDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  },
};

// Read state.json fail-soft. A missing or corrupt file yields an empty object so
// tracking still runs (and re-establishes state) rather than throwing mid-run.
function readCouncilState(stateDir: string): Partial<CouncilState> {
  const f = resolve(stateDir, "state.json");
  if (!existsSync(f)) return {};
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as Partial<CouncilState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function envInt(name: string, fallback: number): number {
  return envIntFrom(process.env, name, fallback);
}

// Same parse against an explicit env, so the confidence predicates stay pure
// over their input and are callable without mutating process.env.
function envIntFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readIterationFromState(stateDir: string): number {
  const f = resolve(stateDir, "state.json");
  if (!existsSync(f)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as Partial<CouncilState>;
    const v = parsed.last_check_iteration;
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Vote / Verdict types
//
// AgentVerdict is the per-voter verdict shape. Vote is a backwards-compatible
// alias for callers that already imported it from the D1 slice.
// ---------------------------------------------------------------------------

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type AgentVerdict = {
  role: string;
  verdict: "APPROVE" | "REJECT" | "CANNOT_VALIDATE";
  reason: string;
  issues: { severity: Severity; description: string }[];
};

export type Vote = AgentVerdict;

export type AggregateResult = {
  decision: "COMPLETE" | "CONTINUE";
  unanimous: boolean;
  approveCount: number;
  rejectCount: number;
  cannotValidateCount: number;
  threshold: number;
  totalMembers: number;
  blockingSeverity: Severity | null;
  votes: AgentVerdict[];
};

export type Voter = (ctx: CouncilEvaluateContext) => Promise<AgentVerdict>;

export type CouncilEvaluateContext = {
  ctx: RunnerContext;
  iteration: number;
  // Optional injected voter set. When omitted DEFAULT_VOTERS is used so the
  // function is callable from production code with no extra wiring.
  voters?: readonly Voter[];
  // Optional severity threshold override. Default mirrors bash
  // COUNCIL_SEVERITY_THRESHOLD (HIGH) -- any issue at or above this severity
  // forces a CONTINUE verdict regardless of vote count.
  severityThreshold?: Severity;
  // Phase C (v7.5.20) injection point for the --agents <json> dispatch path.
  // When set AND `voters` is NOT set, councilEvaluate will attempt the
  // dispatchClaudeAgents call using this runner before falling through to
  // the existing heuristic. Production code leaves this undefined and the
  // dispatcher uses Bun.spawn directly; tests pass a fake runner to drive
  // the path without spawning a real claude binary.
  claudeRunner?: (
    argv: string[],
  ) => Promise<{ stdout: string; exitCode: number }>;
};

// Severity ordering: lower index = more severe.
const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}
function isAtOrAbove(found: Severity, threshold: Severity): boolean {
  return severityRank(found) <= severityRank(threshold);
}

// ---------------------------------------------------------------------------
// Default voter set -- heuristic-only, deterministic, no provider calls.
// Mirrors the bash council_heuristic_review fallback so the module is usable
// in CI without a provider CLI installed.
// ---------------------------------------------------------------------------

const DEFAULT_VOTER_ROLES = ["requirements_verifier", "test_auditor", "devils_advocate"] as const;

const heuristicVoter = (role: string): Voter => async (cec) => {
  const issues: AgentVerdict["issues"] = [];
  const lokiRoot = cec.ctx.lokiDir;
  const failedFile = resolve(lokiRoot, "queue", "failed.json");
  if (existsSync(failedFile)) {
    try {
      const failed = JSON.parse(readFileSync(failedFile, "utf-8")) as unknown;
      if (Array.isArray(failed)) {
        // Tighten: only count entries that look like real task records --
        // an object with a `task` or `id` field. Garbage entries (strings,
        // numbers, null, objects without task/id) are ignored so a single
        // malformed row cannot trip the REJECT heuristic.
        const validCount = failed.reduce<number>((acc, entry) => {
          if (
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (Object.prototype.hasOwnProperty.call(entry, "task") ||
              Object.prototype.hasOwnProperty.call(entry, "id"))
          ) {
            return acc + 1;
          }
          return acc;
        }, 0);
        if (validCount > 0) {
          issues.push({ severity: "HIGH", description: `${validCount} tasks in failed queue` });
        }
      }
    } catch (err) {
      // M4 (W4 bug-hunt): a CORRUPT failure ledger must fail toward the SAFE
      // direction for a COMPLETION gate. Previously this catch logged and fell
      // through to APPROVE ("no blocking signals"), which means "we cannot read
      // the failure ledger" was treated as "there are no failures" -- the unsafe
      // direction. We now return CANNOT_VALIDATE so the council cannot declare
      // the work COMPLETE while a failure record exists but is unreadable.
      // Note: the existsSync() guard above already distinguishes "file missing"
      // (legit -> no failures -> APPROVE) from "file exists but unparseable"
      // (-> unsafe -> CANNOT_VALIDATE here).
      const msg = `council heuristic voter: failed to parse ${failedFile}: ${(err as Error).message}`;
      const log = (cec.ctx as Partial<RunnerContext>).log;
      if (typeof log === "function") {
        log(msg);
      } else {
        console.warn(msg);
      }
      return {
        role,
        verdict: "CANNOT_VALIDATE",
        reason: `heuristic: failure ledger present but unreadable (${failedFile}); cannot confirm completion`,
        issues: [],
      };
    }
  }
  if (issues.length > 0) {
    return { role, verdict: "REJECT", reason: "heuristic: failing tasks present", issues };
  }
  return { role, verdict: "APPROVE", reason: "heuristic: no blocking signals", issues: [] };
};

export const DEFAULT_VOTERS: readonly Voter[] = DEFAULT_VOTER_ROLES.map((r) => heuristicVoter(r));

// ---------------------------------------------------------------------------
// councilAggregateVotes -- bash council_aggregate_votes (line ~1137).
//
// Pure function: takes verdicts, computes 2/3 ceiling threshold, performs
// severity-budget gate.
// ---------------------------------------------------------------------------

export async function councilAggregateVotes(
  votes: readonly AgentVerdict[],
  opts: { severityThreshold?: Severity } = {},
): Promise<AggregateResult> {
  const total = votes.length;
  let approve = 0;
  let reject = 0;
  let cannotValidate = 0;
  let blockingSeverity: Severity | null = null;
  const threshold = opts.severityThreshold ?? "HIGH";

  for (const v of votes) {
    if (v.verdict === "APPROVE") approve++;
    else if (v.verdict === "REJECT") reject++;
    else cannotValidate++;
    for (const issue of v.issues) {
      if (isAtOrAbove(issue.severity, threshold)) {
        if (
          blockingSeverity === null ||
          severityRank(issue.severity) < severityRank(blockingSeverity)
        ) {
          blockingSeverity = issue.severity;
        }
      }
    }
  }

  // 2/3 ceiling -- mirrors bash `(( (total * 2 + 2) / 3 ))`.
  const approvalThreshold = total === 0 ? 0 : Math.floor((total * 2 + 2) / 3);
  let decision: "COMPLETE" | "CONTINUE" = "CONTINUE";
  if (total > 0 && approve >= approvalThreshold && blockingSeverity === null) {
    decision = "COMPLETE";
  }
  const unanimous = total > 0 && approve === total;

  return {
    decision,
    unanimous,
    approveCount: approve,
    rejectCount: reject,
    cannotValidateCount: cannotValidate,
    threshold: approvalThreshold,
    totalMembers: total,
    blockingSeverity,
    votes: [...votes],
  };
}

// ---------------------------------------------------------------------------
// councilDevilsAdvocate -- anti-sycophancy on unanimous APPROVE.
// Bash sources: completion-council.sh:866 and :1236.
//
// On unanimous APPROVE, runs a deterministic skeptical scan:
//   1. failed.json present and non-empty
//   2. recent error events in events.jsonl (>0 in last 50 rows)
//   3. test logs missing OR present without pass marker
// On non-unanimous input we return an APPROVE marker (no-op) so callers
// can simply check `.verdict === "REJECT"` to detect a veto.
// ---------------------------------------------------------------------------

export async function councilDevilsAdvocate(
  votes: readonly AgentVerdict[],
  opts: { lokiDir?: string; iteration?: number } = {},
): Promise<AgentVerdict> {
  const total = votes.length;
  const allApprove = total > 0 && votes.every((v) => v.verdict === "APPROVE");

  // Phase 1 (v7.5.0) -- mirror the APPROVE-side anti-sycophancy on REJECT.
  // When all voters REJECT AND a counter-evidence file exists for the
  // iteration, surface the dispute as CANNOT_VALIDATE so the council
  // aggregator does not lock in REJECT silently. The actual judge panel
  // runs in quality_gates.runCodeReview where the per-reviewer findings
  // are available -- this hook only marks "operator disputes; see code
  // review override transcripts." Critical correctness: NEVER return
  // APPROVE based on file presence alone (council review R1 finding D).
  const allReject = total > 0 && votes.every((v) => v.verdict === "REJECT");
  if (allReject && process.env["LOKI_OVERRIDE_COUNCIL"] === "1") {
    const root = opts.lokiDir ?? defaultLokiDir();
    const iter = opts.iteration ?? -1;
    try {
      const ce = await import("./counter_evidence.ts");
      const evidence = ce.loadCounterEvidence(root, iter);
      if (evidence !== null && evidence.evidence.length > 0) {
        return {
          role: "devils_advocate",
          verdict: "CANNOT_VALIDATE",
          reason: `operator-supplied counter-evidence (${evidence.evidence.length} item${evidence.evidence.length === 1 ? "" : "s"}) -- inspect quality/reviews/<id>/override-*.json for judge panel result`,
          issues: [],
        };
      }
    } catch {
      // override path is best-effort; fall through to default no-op behavior
    }
  }

  if (!allApprove) {
    return {
      role: "devils_advocate",
      verdict: "APPROVE",
      reason: "no-op: not unanimous APPROVE, devil's advocate not triggered",
      issues: [],
    };
  }

  const root = opts.lokiDir ?? defaultLokiDir();
  const issues: AgentVerdict["issues"] = [];

  // Check 1: failed-tasks queue
  const failedFile = resolve(root, "queue", "failed.json");
  if (existsSync(failedFile)) {
    try {
      const failed = JSON.parse(readFileSync(failedFile, "utf-8")) as unknown;
      if (Array.isArray(failed) && failed.length > 0) {
        issues.push({ severity: "HIGH", description: `${failed.length} tasks in failed queue` });
      }
    } catch {
      // M4 (W4 bug-hunt): a corrupt failure ledger must NOT be swallowed here.
      // The DA scan collects issues and returns REJECT when any are present, so
      // pushing a HIGH issue when failed.json exists but is unparseable flips the
      // unanimous COMPLETE to CONTINUE (the safe direction) instead of silently
      // upholding it. existsSync() above already gates this to "file present".
      issues.push({
        severity: "HIGH",
        description: "cannot read failure ledger (corrupt failed.json)",
      });
    }
  }

  // Check 2: recent error events
  const eventsFile = resolve(root, "events.jsonl");
  if (existsSync(eventsFile)) {
    // Tail-read: events.jsonl is append-only and unbounded; only the last 50
    // lines are inspected. Reads at most 64KB from the tail (Wave C #1).
    const lines = tailLines(eventsFile, 50);
    if (lines === null) {
      console.warn(`council devil's advocate: failed to read ${eventsFile}`);
    }
    if (lines !== null) {
      let errors = 0;
      for (const line of lines) {
        if (/"level"\s*:\s*"error"/i.test(line)) errors++;
      }
      if (errors > 0) {
        issues.push({ severity: "MEDIUM", description: `${errors} recent error events` });
      }
    }
  }

  // Check 3: test logs
  const logsDir = resolve(root, "logs");
  let hasTestLog = false;
  let hasPassMarker = false;
  if (existsSync(logsDir)) {
    try {
      for (const entry of readdirSync(logsDir)) {
        if (!/test/i.test(entry) || !entry.endsWith(".log")) continue;
        hasTestLog = true;
        try {
          const full = resolve(logsDir, entry);
          const st = statSync(full);
          if (st.isFile()) {
            // Wave C #3: tail-read the last 30 lines (at most 64KB from the tail)
            // instead of reading the whole log then slicing. This also drops the
            // old `st.size > 5MB -> skip` guard, which was a BLIND SPOT: a large
            // verbose pytest/jest log would silently contribute NO pass marker,
            // so a real passing suite could read as "no pass marker found". The
            // pass/fail marker lives in the tail, which we now always read cheaply.
            const tailArr = tailLines(full, 30);
            const tail = tailArr ? tailArr.join("\n") : "";
            if (/passed|success|all tests|\bok\b/i.test(tail)) {
              hasPassMarker = true;
            }
          }
        } catch {
          // ignore unreadable
        }
      }
    } catch {
      // ignore
    }
  }
  if (!hasTestLog) {
    issues.push({ severity: "MEDIUM", description: "no test result logs found" });
  } else if (!hasPassMarker) {
    issues.push({ severity: "HIGH", description: "test logs lack a pass marker" });
  }

  if (issues.length === 0) {
    return {
      role: "devils_advocate",
      verdict: "APPROVE",
      reason: "anti-sycophancy: no issues found, COMPLETE upheld",
      issues: [],
    };
  }
  return {
    role: "devils_advocate",
    verdict: "REJECT",
    reason: `anti-sycophancy veto: ${issues.length} issue(s) found`,
    issues,
  };
}

// ---------------------------------------------------------------------------
// councilEvaluate -- bash council_evaluate (line ~1340).
//
// Orchestrates the 3 voters in order, aggregates, and runs the devil's
// advocate when the aggregate is unanimous APPROVE. The DA veto is
// materialized by replacing AggregateResult.decision with CONTINUE and
// appending the contrarian verdict to the votes list.
// ---------------------------------------------------------------------------

export async function councilEvaluate(cec: CouncilEvaluateContext): Promise<AggregateResult> {
  const voters = cec.voters ?? DEFAULT_VOTERS;
  let verdicts: AgentVerdict[] = [];

  // Phase C (v7.5.20) -- prefer the --agents <json> dispatch path when:
  //   1. caller did NOT inject an explicit `voters` set (which still wins);
  //   2. EITHER a `claudeRunner` is injected (test mode) OR the installed
  //      claude CLI advertises both --agents and --json-schema.
  // On any failure we fall through to the existing heuristic loop. The
  // heuristic path is preserved as the safety net (DO NOT remove).
  const shouldTryAgentsDispatch =
    cec.voters === undefined &&
    (cec.claudeRunner !== undefined ||
      (claudeFlagSupportedShim("--agents") && claudeFlagSupportedShim("--json-schema")));
  if (shouldTryAgentsDispatch) {
    try {
      const mod = await import("../council/voter_agents.ts");
      verdicts = await mod.dispatchClaudeAgents(cec, cec.claudeRunner);
    } catch (err) {
      // Heuristic fall-through. Log once at warn level so the operator can
      // see why the upgrade path was skipped this iteration.
      const msg = `[council] --agents dispatch failed, falling back to heuristic: ${(err as Error).message}`;
      const log = (cec.ctx as Partial<RunnerContext>).log;
      if (typeof log === "function") log(msg);
      else console.warn(msg);
      verdicts = [];
    }
  }

  if (verdicts.length === 0) {
    for (const voter of voters) {
      // Sequential -- matches bash member loop and keeps logs deterministic.
      const v = await voter(cec);
      verdicts.push(v);
    }
  }

  const aggregate = await councilAggregateVotes(verdicts, {
    severityThreshold: cec.severityThreshold ?? "HIGH",
  });

  // Anti-sycophancy gate. Mirrors bash completion-council.sh:723
  //   if [ $approve_count -eq $COUNCIL_SIZE ] && [ $COUNCIL_SIZE -ge 2 ]; then
  // i.e. the devil's advocate only ADDS scrutiny on a unanimous APPROVE with at
  // least 2 members. It never blocks a non-unanimous result. The size>=2 guard
  // prevents a single-member council (threshold floor((1*2+2)/3)=1, unanimous by
  // definition) from triggering the contrarian re-review.
  if (aggregate.unanimous && aggregate.decision === "COMPLETE" && aggregate.totalMembers >= 2) {
    // Prefer the LLM devil's-advocate re-review (bash council_devils_advocate,
    // completion-council.sh:2074-2170) when a provider is reachable, mirroring
    // the same gate used for the base-voter dispatch above:
    //   - caller injected a claudeRunner (test mode), OR
    //   - the installed claude CLI advertises both --agents and --json-schema.
    // The base voters are not re-overridden here -- this is a SEPARATE second
    // invocation, exactly as bash runs council_devils_advocate after the member
    // loop. On ANY dispatch failure (no provider, malformed reply, non-zero
    // exit) we degrade to the deterministic file-scan councilDevilsAdvocate so
    // anti-sycophancy is never silently dropped (a bare uphold would defeat the
    // gate). Liveness guarantee (H6, W4 bug-hunt): the dispatch is bounded by a
    // hard timeout (LOKI_COUNCIL_TIMEOUT_MS, default 600000ms) applied at BOTH
    // the dispatch race (voter_agents.dispatch*) AND inside defaultClaudeRunner
    // (which kills the child). A hung child therefore rejects the dispatch
    // promise -> caught here -> deterministic scan path. The previous comment
    // ("we NEVER hang: dispatch throws") was FALSE before the timeout existed:
    // a child that never exits made `await proc.exited` never resolve, so the
    // try/catch (which only catches throws / non-zero exits) never fired.
    const shouldTryLlmDa =
      cec.voters === undefined &&
      (cec.claudeRunner !== undefined ||
        (claudeFlagSupportedShim("--agents") && claudeFlagSupportedShim("--json-schema")));

    let contrarian: AgentVerdict | null = null;
    if (shouldTryLlmDa) {
      try {
        const mod = await import("../council/voter_agents.ts");
        contrarian = await mod.dispatchDevilsAdvocate(cec, cec.claudeRunner);
      } catch (err) {
        const msg = `[council] devil's-advocate LLM dispatch failed, falling back to deterministic scan: ${(err as Error).message}`;
        const log = (cec.ctx as Partial<RunnerContext>).log;
        if (typeof log === "function") log(msg);
        else console.warn(msg);
        contrarian = null;
      }
    }
    // Fall back to the deterministic anti-sycophancy scan when the LLM DA was
    // not attempted or failed. This is the "base verdict" the system produced
    // before the LLM upgrade -- a strict skeptical scan, not a bare uphold.
    if (contrarian === null) {
      contrarian = await councilDevilsAdvocate(verdicts, { lokiDir: cec.ctx.lokiDir });
    }
    if (contrarian.verdict === "REJECT" || contrarian.verdict === "CANNOT_VALIDATE") {
      const flippedAggregate: AggregateResult = {
        ...aggregate,
        decision: "CONTINUE",
        unanimous: false,
        rejectCount: aggregate.rejectCount + 1,
        votes: [...aggregate.votes, contrarian],
      };
      // Write transcript: DA triggered and flipped the outcome.
      await councilWriteTranscript(flippedAggregate, contrarian, cec.iteration, cec.ctx.prdPath, {
        lokiDir: cec.ctx.lokiDir,
      });
      return flippedAggregate;
    }
    const approvedAggregate: AggregateResult = { ...aggregate, votes: [...aggregate.votes, contrarian] };
    // Write transcript: DA triggered but upheld the unanimous APPROVE.
    await councilWriteTranscript(approvedAggregate, contrarian, cec.iteration, cec.ctx.prdPath, {
      lokiDir: cec.ctx.lokiDir,
    });
    return approvedAggregate;
  }

  // Non-unanimous or non-complete: write transcript without DA entry.
  await councilWriteTranscript(aggregate, null, cec.iteration, cec.ctx.prdPath, {
    lokiDir: cec.ctx.lokiDir,
  });
  return aggregate;
}

// ---------------------------------------------------------------------------
// CouncilTranscript -- canonical per-iteration transcript shape (v7.5.16).
// Written to .loki/council/transcripts/iter-<N>-<TIMESTAMP>.json after every
// councilEvaluate() call. The backend API (dashboard/server.py) reads these
// files to serve GET /api/council/transcripts.
// ---------------------------------------------------------------------------

export type TranscriptVoter = {
  name: string;
  role_index: number;
  verdict: "APPROVE" | "REJECT" | "CANNOT_VALIDATE";
  reasoning: string;
  issues: { severity: string; description: string }[];
  is_contrarian: boolean;
  // Only present when is_contrarian=true and triggered=true:
  challenges?: string[];
  triggered?: boolean;
};

export type CouncilTranscript = {
  iteration_id: string;
  iteration: number;
  timestamp: string;
  task_or_prd: string;
  prd_path: string;
  voters: TranscriptVoter[];
  outcome: "APPROVED" | "REJECTED" | "BLOCKED_BY_GATE";
  contrarian_triggered: boolean;
  contrarian_flipped: boolean;
  approve_count: number;
  reject_count: number;
  threshold: number;
  total_members: number;
};

// ---------------------------------------------------------------------------
// councilWriteTranscript -- writes a canonical transcript JSON file.
//
// Called from councilEvaluate() after the DA check. No-op on errors (logs
// a warning but does not throw). Idempotent: same iteration+timestamp
// produces the same filename; re-running overwrites the file cleanly.
// ---------------------------------------------------------------------------

export async function councilWriteTranscript(
  aggregate: AggregateResult,
  daResult: AgentVerdict | null,
  iteration: number,
  prdPath: string | undefined,
  opts: { lokiDir?: string } = {},
): Promise<void> {
  try {
    const root = opts.lokiDir ?? defaultLokiDir();
    const transcriptsDir = resolve(root, "council", "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    // Compact timestamp for filename: strip punctuation to keep it filename-safe.
    const tsCompact = timestamp.replace(/[-:]/g, "").replace("T", "T").replace("Z", "Z");
    const iterationId = `iter-${iteration}-${tsCompact}`;
    const transcriptPath = resolve(transcriptsDir, `${iterationId}.json`);

    // Read first 200 chars of PRD content for task_or_prd field.
    let taskOrPrd = "";
    if (prdPath) {
      try {
        if (existsSync(prdPath)) {
          taskOrPrd = readFileSync(prdPath, "utf-8").slice(0, 200);
        }
      } catch {
        // best-effort; leave as ""
      }
    }

    // Determine contrarian flags.
    // contrarian_triggered: DA was invoked (council.ts:450 condition -- unanimous APPROVE).
    // contrarian_flipped: DA returned REJECT or CANNOT_VALIDATE, overriding the unanimous APPROVE.
    const contrarianTriggered = daResult !== null;
    const contrarianFlipped =
      daResult !== null &&
      (daResult.verdict === "REJECT" || daResult.verdict === "CANNOT_VALIDATE");

    // Build voters array from the aggregate votes.
    // When DA was triggered, councilEvaluate appended the DA AgentVerdict as the
    // last element of aggregate.votes. We strip it here and reconstruct it as a
    // TranscriptVoter with is_contrarian=true so the transcript shape is correct.
    const regularVotes = contrarianTriggered
      ? aggregate.votes.slice(0, -1)
      : aggregate.votes;

    const voters: TranscriptVoter[] = regularVotes.map((v, idx) => ({
      name: v.role,
      role_index: idx + 1,
      verdict: v.verdict,
      reasoning: v.reason,
      issues: v.issues.map((i) => ({ severity: i.severity, description: i.description })),
      is_contrarian: false,
    }));

    // Append the DA voter entry if triggered.
    if (contrarianTriggered && daResult !== null) {
      const daVoter: TranscriptVoter = {
        name: "devils_advocate",
        role_index: voters.length + 1,
        verdict: daResult.verdict,
        reasoning: daResult.reason,
        issues: daResult.issues.map((i) => ({ severity: i.severity, description: i.description })),
        is_contrarian: true,
        triggered: true,
        challenges: daResult.issues.map((i) => i.description),
      };
      voters.push(daVoter);
    }

    const nonContrarianVoters = voters.filter((v) => !v.is_contrarian);
    const approveCount = nonContrarianVoters.filter((v) => v.verdict === "APPROVE").length;
    const rejectCount = nonContrarianVoters.filter(
      (v) => v.verdict === "REJECT" || v.verdict === "CANNOT_VALIDATE",
    ).length;

    // Determine outcome.
    let outcome: CouncilTranscript["outcome"];
    if (aggregate.decision === "COMPLETE") {
      outcome = "APPROVED";
    } else {
      outcome = "REJECTED";
    }

    const transcript: CouncilTranscript = {
      iteration_id: iterationId,
      iteration,
      timestamp,
      task_or_prd: taskOrPrd,
      prd_path: prdPath ?? "",
      voters,
      outcome,
      contrarian_triggered: contrarianTriggered,
      contrarian_flipped: contrarianFlipped,
      approve_count: approveCount,
      reject_count: rejectCount,
      threshold: aggregate.threshold,
      total_members: nonContrarianVoters.length,
    };

    atomicWriteFile(transcriptPath, JSON.stringify(transcript, null, 2) + "\n");
  } catch (err) {
    // Writer errors must never crash the caller.
    console.warn(
      `[council] transcript write failed (iter=${iteration}): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// councilWriteReport -- bash council_write_report (line ~1714).
//
// Writes .loki/council/report.md with convergence data, council config, and
// vote history. The bash version pulls config from $COUNCIL_* env vars; we
// derive equivalents from the AggregateResult list so this stays a pure
// function-of-input and is trivial to test.
// ---------------------------------------------------------------------------

export async function councilWriteReport(
  verdicts: readonly AggregateResult[],
  opts: { lokiDir?: string; iteration?: number } = {},
): Promise<void> {
  const root = opts.lokiDir ?? defaultLokiDir();
  const reportPath = resolve(root, "council", "report.md");
  const last = verdicts.length > 0 ? verdicts[verdicts.length - 1] : null;
  const finalDecision = last?.decision ?? "CONTINUE";
  const iteration = opts.iteration ?? verdicts.length;
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const lines: string[] = [];
  lines.push("# Completion Council Final Report");
  lines.push("");
  lines.push(`**Date:** ${timestamp}`);
  lines.push(`**Iteration:** ${iteration}`);
  lines.push(`**Verdict:** ${finalDecision === "COMPLETE" ? "APPROVED" : "CONTINUE"}`);
  lines.push("");
  lines.push("## Convergence Data");
  lines.push(`- Total iterations: ${iteration}`);
  lines.push(`- Aggregate rounds recorded: ${verdicts.length}`);
  if (last) {
    lines.push(`- Final approve/reject: ${last.approveCount}/${last.rejectCount}`);
    lines.push(`- Final blocking severity: ${last.blockingSeverity ?? "none"}`);
  }
  lines.push("");
  lines.push("## Council Configuration");
  lines.push(`- Council size: ${last?.totalMembers ?? 0}`);
  lines.push(`- Approval threshold: ${last?.threshold ?? 0}/${last?.totalMembers ?? 0}`);
  lines.push("");
  lines.push("## Vote History");
  if (verdicts.length === 0) {
    lines.push("- No vote history available");
  } else {
    verdicts.forEach((r, i) => {
      lines.push(
        `- Round ${i + 1}: ${r.decision} (${r.approveCount} approve / ${r.rejectCount} reject / ${r.cannotValidateCount} cannot_validate)`,
      );
      for (const v of r.votes) {
        const issueSummary = v.issues.length === 0 ? "no issues" : `${v.issues.length} issue(s)`;
        lines.push(`  - ${v.role}: ${v.verdict} -- ${v.reason} [${issueSummary}]`);
      }
    });
  }
  lines.push("");

  atomicWriteFile(reportPath, lines.join("\n"));
}
