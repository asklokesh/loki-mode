// 11.3.0 T5: `loki start --attempts N` v1. Runs N independent attempts in separate git worktrees,
// picks the winner by the most EXECUTED passing checks from each attempt's recorded verify results
// (a check counts only when it passed and actually ran; not_run, skipped and n=0 never count),
// applies the winner to the primary tree, and writes an attempts receipt that names every loser.
// All side effects go through AttemptDeps so the selection, cleanup and receipt are unit-testable.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { verifyReceipt } from "../engine10/verify_cmd.ts";
import { outcomeOf } from "../features/receipt_dsse.ts";

export const MAX_ATTEMPTS = 5;

export interface AttemptCheck {
  name: string;
  result: "pass" | "fail" | "not_run" | "flaky" | string;
  n?: number; // executed test count when recorded; n === 0 means nothing executed
}
export interface AttemptOutcome {
  id: number; // 1-based attempt id
  exit: number;
  /** null = the attempt sealed no engine10 receipt: NOT PROVEN, never scored as 0. */
  checks: AttemptCheck[] | null;
}
export interface LoserRecord {
  attempt_id: number;
  executed_passing: number;
  executed_failing: number;
  why_lost: string;
}
export interface AttemptsReceipt {
  schema: "loki.attempts.receipt/1";
  requested: number;
  ran: number;
  governor: { state: "ok" | "hold"; max_engineers_next_hour: number | null; note: string };
  base_sha: string;
  winner: { attempt_id: number; executed_passing: number; executed_failing: number; tie: boolean } | null;
  applied: boolean;
  no_winner_reason?: string;
  losers: LoserRecord[];
  cleanup: { path: string; removed: boolean; error?: string }[];
}

export interface AttemptDeps {
  repoDir: string;
  receiptDir: string;
  baseSha(): string;
  /** Max concurrent engineers the usage governor allows; null/undefined = unknown (treated as hold). */
  governorMax(): number | null | undefined;
  createWorktree(path: string, baseSha: string): void;
  removeWorktree(path: string): void;
  /** Runs one attempt inside its worktree and returns its recorded verify checks. May throw. */
  runAttempt(id: number, worktree: string): Promise<AttemptOutcome>;
  applyWinner(worktree: string, baseSha: string): void;
  makeContainer(): string;
  removeContainer(path: string): void;
  writeReceipt(dir: string, r: AttemptsReceipt): string;
  /** The unchanged single-attempt path (N=1). */
  runDirect(): Promise<number>;
}

const executedPass = (c: AttemptCheck): boolean => c.result === "pass" && (c.n === undefined || c.n > 0);
const executedFail = (c: AttemptCheck): boolean => c.result === "fail";

export function countChecks(checks: AttemptCheck[] | null): { passing: number; failing: number } {
  let passing = 0;
  let failing = 0;
  for (const c of checks ?? []) {
    if (executedPass(c)) passing++;
    else if (executedFail(c)) failing++;
  }
  return { passing, failing };
}

export interface Selection {
  winner: { attempt_id: number; executed_passing: number; executed_failing: number; tie: boolean } | null;
  losers: LoserRecord[];
  no_winner_reason?: string;
}

/** Most executed passing checks wins; a tie goes to the lowest attempt id and is stated as a tie. */
export function selectWinner(outcomes: AttemptOutcome[], errored: Map<number, string> = new Map()): Selection {
  const rows = outcomes.map((o) => ({ id: o.id, ...countChecks(o.checks) })).sort((a, b) => a.id - b.id);
  const unproven = new Set(outcomes.filter((o) => o.checks === null).map((o) => o.id));
  const eligible = rows.filter((r) => !errored.has(r.id) && !unproven.has(r.id));
  const best = eligible.reduce((m, r) => Math.max(m, r.passing), 0);
  const losersOf = (winId: number | null): LoserRecord[] =>
    rows
      .filter((r) => r.id !== winId)
      .map((r) => ({
        attempt_id: r.id,
        executed_passing: r.passing,
        executed_failing: r.failing,
        why_lost: errored.has(r.id)
          ? `attempt errored: ${errored.get(r.id)}`
          : unproven.has(r.id)
            ? "NOT PROVEN: no engine10 receipt was sealed"
            : winId === null
            ? "no attempt had an executed passing check"
            : r.passing === best
              ? `tied on ${best} executed passing checks; lowest attempt id (${winId}) wins the tie`
              : `fewer executed passing checks (${r.passing} < ${best})`,
      }));
  if (unproven.size === outcomes.length) {
    return { winner: null, losers: losersOf(null), no_winner_reason: "BLOCKED: no attempt sealed an engine10 receipt, so nothing can be scored; nothing was applied" };
  }
  if (best === 0) {
    return { winner: null, losers: losersOf(null), no_winner_reason: "no attempt recorded an executed passing check; nothing was applied" };
  }
  const top = eligible.filter((r) => r.passing === best);
  const w = top[0]!;
  return { winner: { attempt_id: w.id, executed_passing: w.passing, executed_failing: w.failing, tie: top.length > 1 }, losers: losersOf(w.id) };
}

export async function runAttempts(n: number, deps: AttemptDeps): Promise<number> {
  if (n <= 1) return deps.runDirect(); // N=1 is today's behavior, untouched
  const g = deps.governorMax();
  let ran = n;
  let gov: AttemptsReceipt["governor"] = { state: "ok", max_engineers_next_hour: g ?? null, note: "governor allows the requested attempts" };
  if (g === null || g === undefined || g < n) {
    ran = g === null || g === undefined ? 1 : Math.max(1, Math.min(n, g));
    gov = {
      state: "hold",
      max_engineers_next_hour: g ?? null,
      note: g === null || g === undefined ? "governor unknown or unreadable: ran 1 attempt (fail safe)" : `governor max ${g} < requested ${n}: ran ${ran}`,
    };
  }
  if (ran === 1) {
    const code = await deps.runDirect();
    deps.writeReceipt(deps.receiptDir, {
      schema: "loki.attempts.receipt/1", requested: n, ran: 1, governor: gov, base_sha: deps.baseSha(),
      winner: null, applied: false, no_winner_reason: "governor hold: ran the single direct path, no selection", losers: [], cleanup: [],
    });
    return code;
  }

  const baseSha = deps.baseSha();
  const container = deps.makeContainer();
  const created: string[] = [];
  const outcomes: AttemptOutcome[] = [];
  const errored = new Map<number, string>();
  const cleanup: AttemptsReceipt["cleanup"] = [];
  let selection: Selection = { winner: null, losers: [] };
  let applied = false;
  let failure: unknown;
  try {
    for (let id = 1; id <= ran; id++) {
      const wt = join(container, `attempt-${id}`);
      deps.createWorktree(wt, baseSha);
      created.push(wt);
      try {
        outcomes.push(await deps.runAttempt(id, wt));
      } catch (e) {
        errored.set(id, e instanceof Error ? e.message : String(e));
        outcomes.push({ id, exit: 1, checks: null });
      }
    }
    selection = selectWinner(outcomes, errored);
    if (selection.winner) {
      deps.applyWinner(join(container, `attempt-${selection.winner.attempt_id}`), baseSha);
      applied = true;
    }
  } catch (e) {
    failure = e;
  } finally {
    for (const p of created) {
      try {
        deps.removeWorktree(p);
        cleanup.push({ path: p, removed: true });
      } catch (e) {
        cleanup.push({ path: p, removed: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    try {
      deps.removeContainer(container);
    } catch {
      // left in place when not empty; the cleanup entries above record which worktree failed
    }
  }
  const receipt: AttemptsReceipt = {
    schema: "loki.attempts.receipt/1", requested: n, ran, governor: gov, base_sha: baseSha,
    winner: selection.winner, applied,
    ...(selection.no_winner_reason ? { no_winner_reason: selection.no_winner_reason } : failure ? { no_winner_reason: `apply failed: ${String(failure)}` } : {}),
    losers: selection.losers, cleanup,
  };
  deps.writeReceipt(deps.receiptDir, receipt);
  if (!applied && receipt.no_winner_reason) process.stderr.write(`attempts: ${receipt.no_winner_reason}\n`);
  if (failure) throw failure;
  if (cleanup.some((c) => !c.removed)) return 1;
  if (!applied || !selection.winner) return 1;
  return outcomes.find((o) => o.id === selection.winner!.attempt_id)?.exit === 0 ? 0 : 1;
}

// ---- production deps -------------------------------------------------------------------------

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

/** Checks from the attempt's own engine10 receipt. seal.ts writes join(runDir, "receipt.json") with runDir = <repo>/.loki/runs/<runId>
 *  (supervisor.ts). Only the NEWEST run dir is read (no fallback to an older run), and only when verifyReceipt says VERIFIED and the run
 *  outcome is VERIFIED or ALREADY_SATISFIED: an unsigned, forged, tampered or BLOCKED receipt is NOT PROVEN.
 *  A pass there already means n>0 executed (FC-16). null = NOT PROVEN. */
export async function readRecordedChecks(worktree: string, verify: (receiptPath: string) => Promise<{ verdict: string }> = verifyReceipt): Promise<AttemptCheck[] | null> {
  const runs = join(worktree, ".loki", "runs");
  if (!existsSync(runs)) return null;
  const dirs = readdirSync(runs).filter((d) => statSync(join(runs, d)).isDirectory()).sort();
  const newest = dirs[dirs.length - 1];
  if (newest === undefined) return null;
  const f = join(runs, newest, "receipt.json");
  if (!existsSync(f)) return null;
  try {
    if ((await verify(f)).verdict !== "VERIFIED") return null;
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown> & { checks?: AttemptCheck[] };
    const outcome = outcomeOf(j);
    if (outcome !== "VERIFIED" && outcome !== "ALREADY_SATISFIED") return null;
    return Array.isArray(j.checks) ? j.checks : null;
  } catch {
    return null;
  }
}

function defaultGovernorMax(): number | null {
  // Test hook: a fixed integer replaces the live governor so dispatch tests are deterministic.
  const fixed = process.env["LOKI_ATTEMPTS_GOVERNOR_MAX"];
  if (fixed !== undefined && /^[0-9]+$/.test(fixed)) return Number(fixed);
  const script = resolve(import.meta.dir, "../../../scripts/usage-governor.py");
  if (!existsSync(script)) return null;
  const r = spawnSync("python3", [script, "--json"], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) return null;
  try {
    const v = (JSON.parse(r.stdout) as { governor?: { max_engineers_next_hour?: unknown } }).governor?.max_engineers_next_hour;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

function attemptBranch(p: string): string {
  return `loki-attempt/${basename(dirname(p))}-${basename(p)}`;
}

export function productionDeps(repoDir: string, runDirect: () => Promise<number>, runInWorktree: (id: number, wt: string) => Promise<number>): AttemptDeps {
  const lokiDir = process.env["LOKI_DIR"] ?? resolve(repoDir, ".loki");
  return {
    repoDir,
    receiptDir: join(lokiDir, "attempts", new Date().toISOString().replace(/[:.]/g, "-")),
    baseSha: () => git(repoDir, ["rev-parse", "HEAD"]).trim(),
    governorMax: () => defaultGovernorMax(),
    // engine10 refuses a detached HEAD, so each attempt gets its own throwaway branch, deleted with the worktree.
    createWorktree: (p, base) => {
      git(repoDir, ["worktree", "add", "-b", attemptBranch(p), p, base]);
    },
    removeWorktree: (p) => {
      // engine10 switches the worktree onto its own loki/<runId> branch; capture it so both throwaway branches go with the worktree.
      let current = "";
      try {
        current = git(p, ["symbolic-ref", "-q", "--short", "HEAD"]).trim();
      } catch {
        // detached or already gone
      }
      git(repoDir, ["worktree", "remove", "--force", p]);
      git(repoDir, ["branch", "-D", attemptBranch(p)]);
      if (current.startsWith("loki/")) git(repoDir, ["branch", "-D", current]);
    },
    runAttempt: async (id, wt) => {
      const exit = await runInWorktree(id, wt);
      return { id, exit, checks: await readRecordedChecks(wt) };
    },
    applyWinner: (wt, base) => {
      // engine10 commits its edits on the attempt branch, so the result is base..working tree; stage stragglers too.
      // `git add` exits nonzero when only gitignored .loki matches the pathspec; that is not a failure here.
      try {
        git(wt, ["add", "-A", "--", ".", ":(exclude).loki"]);
      } catch {
        // nothing stageable
      }
      const patch = git(wt, ["diff", "--cached", "--binary", base]);
      if (patch.trim() !== "") git(repoDir, ["apply", "--whitespace=nowarn"], patch);
    },
    makeContainer: () => mkdtempSync(join(tmpdir(), "loki-attempts-")),
    removeContainer: (p) => rmdirSync(p),
    writeReceipt: (dir, r) => {
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "attempts-receipt.json");
      writeFileSync(f, JSON.stringify(r, null, 2) + "\n");
      return f;
    },
    runDirect,
  };
}
