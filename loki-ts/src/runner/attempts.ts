// 11.3.0 T5: `loki start --attempts N` v1. Runs N independent attempts in separate git worktrees,
// picks the winner by the most EXECUTED passing checks from each attempt's recorded verify results
// (a check counts only when it passed and actually ran; not_run, skipped and n=0 never count),
// applies the winner to the primary tree, and writes an attempts receipt that names every loser.
// All side effects go through AttemptDeps so the selection, cleanup and receipt are unit-testable.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
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
  /** The attempt's own engine10 receipt, when one was sealed (shown on the attempts receipt). */
  engine10?: { run_id: string; receipt_sha256: string; outcome: string; /** Preserved copy of the run dir (survives worktree removal); verify with loki verify. */ preserved_path?: string };
  /** Why checks is null, stated truthfully (no receipt, failed verification, or a sealed non-passing outcome). */
  unproven_reason?: string;
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
  /** Attempts run one after another in their own worktrees; only the 1-5 bound limits N. */
  attempts: { attempt_id: number; exit: number; engine10: AttemptOutcome["engine10"] | null }[];
  pr: { mode: "opened" | "skipped_no_pr" | "failed" | "not_applicable"; url?: string; error?: string };
  base_sha: string;
  winner: { attempt_id: number; executed_passing: number; executed_failing: number; tie: boolean } | null;
  applied: boolean;
  no_winner_reason?: string;
  /** Attempts whose worktree could not be created; they did not run and are not counted in `ran`. */
  setup_failed?: { attempt_id: number; error: string }[];
  losers: LoserRecord[];
  cleanup: { path: string; removed: boolean; error?: string }[];
}

export interface AttemptDeps {
  repoDir: string;
  receiptDir: string;
  baseSha(): string;
  /** Opens the PR for the winner (normal PR behavior). Undefined when the user passed --no-pr. Returns the PR url. */
  openPr?(winnerWorktree: string, baseSha: string): string;
  /** Console output; defaults to stdout. */
  print?(line: string): void;
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
  const unprovenWhy = new Map(outcomes.filter((o) => o.unproven_reason).map((o) => [o.id, o.unproven_reason as string]));
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
            ? `NOT PROVEN: ${unprovenWhy.get(r.id) ?? "no engine10 receipt was sealed"}`
            : winId === null
            ? "no attempt had an executed passing check"
            : r.passing === best
              ? `tied on ${best} executed passing checks; lowest attempt id (${winId}) wins the tie`
              : `fewer executed passing checks (${r.passing} < ${best})`,
      }));
  if (unproven.size === outcomes.length) {
    return { winner: null, losers: losersOf(null), no_winner_reason: "BLOCKED: no attempt produced a VERIFIED engine10 receipt with a passing outcome, so nothing can be scored; nothing was applied" };
  }
  if (best === 0) {
    return { winner: null, losers: losersOf(null), no_winner_reason: "no attempt recorded an executed passing check; nothing was applied" };
  }
  const top = eligible.filter((r) => r.passing === best);
  const w = top[0]!;
  return { winner: { attempt_id: w.id, executed_passing: w.passing, executed_failing: w.failing, tie: top.length > 1 }, losers: losersOf(w.id) };
}

/** Console summary of an attempts receipt: requested, ran, winner and why, losers. One line for any degradation. */
export function formatAttemptsSummary(r: AttemptsReceipt): string[] {
  const out = [`Attempts:   requested ${r.requested}, ran ${r.ran}`];
  if (r.ran < r.requested) {
    const why = (r.setup_failed ?? []).map((s) => `attempt ${s.attempt_id} worktree failed: ${s.error}`).join("; ");
    out.push(`Degraded:   only ${r.ran} of ${r.requested} attempts ran${why ? ` (${why})` : ""}`);
  }
  for (const a of r.attempts) out.push(`  attempt ${a.attempt_id}: ${a.engine10 ? `engine10 ${a.engine10.outcome}, receipt sha256:${a.engine10.receipt_sha256.slice(0, 12)}${a.engine10.preserved_path ? `, kept at ${a.engine10.preserved_path}` : ""}` : "NOT PROVEN (no sealed engine10 receipt)"}`);
  if (r.winner) {
    out.push(`Winner:     attempt ${r.winner.attempt_id} with ${r.winner.executed_passing} executed passing check(s)${r.winner.tie ? ", chosen on a tie (lowest attempt id)" : ""}${r.applied ? ", applied to the working tree" : ""}`);
  } else out.push(`Winner:     none (${r.no_winner_reason ?? "no attempt qualified"})`);
  for (const l of r.losers) out.push(`Loser:      attempt ${l.attempt_id}: ${l.why_lost}`);
  out.push(r.pr.mode === "opened" ? `PR:         ${r.pr.url ?? "opened"}` : r.pr.mode === "failed" ? `PR:         FAILED: ${r.pr.error ?? "unknown"}` : r.pr.mode === "skipped_no_pr" ? "PR:         none (--no-pr)" : "PR:         none (no winner)");
  return out;
}

export async function runAttempts(n: number, deps: AttemptDeps): Promise<number> {
  if (n <= 1) return deps.runDirect(); // N=1 is the plain single engine10 run
  let pr: AttemptsReceipt["pr"] = { mode: "not_applicable" };
  const baseSha = deps.baseSha();
  const container = deps.makeContainer();
  const created: string[] = [];
  const outcomes: AttemptOutcome[] = [];
  const errored = new Map<number, string>();
  const setupFailed: { attempt_id: number; error: string }[] = [];
  const cleanup: AttemptsReceipt["cleanup"] = [];
  let selection: Selection = { winner: null, losers: [] };
  let applied = false;
  let failure: unknown;
  try {
    for (let id = 1; id <= n; id++) {
      const wt = join(container, `attempt-${id}`);
      try {
        deps.createWorktree(wt, baseSha);
      } catch (e) {
        setupFailed.push({ attempt_id: id, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
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
      const winWt = join(container, `attempt-${selection.winner.attempt_id}`);
      deps.applyWinner(winWt, baseSha);
      applied = true;
      if (!deps.openPr) pr = { mode: "skipped_no_pr" };
      else {
        try {
          pr = { mode: "opened", url: deps.openPr(winWt, baseSha) };
        } catch (e) {
          pr = { mode: "failed", error: e instanceof Error ? e.message : String(e) };
        }
      }
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
    schema: "loki.attempts.receipt/1", requested: n, ran: outcomes.length, attempts: outcomes.map((o) => ({ attempt_id: o.id, exit: o.exit, engine10: o.engine10 ?? null })), pr, base_sha: baseSha,
    winner: selection.winner, applied,
    ...(setupFailed.length ? { setup_failed: setupFailed } : {}),
    ...(selection.no_winner_reason ? { no_winner_reason: selection.no_winner_reason } : failure ? { no_winner_reason: `apply failed: ${String(failure)}` } : {}),
    losers: selection.losers, cleanup,
  };
  deps.writeReceipt(deps.receiptDir, receipt);
  const print = deps.print ?? ((l: string) => void process.stdout.write(`${l}\n`));
  for (const l of formatAttemptsSummary(receipt)) print(l);
  if (pr.mode === "failed") return 1;
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
export async function assessAttempt(worktree: string, verify: (receiptPath: string) => Promise<{ verdict: string }> = verifyReceipt): Promise<{ checks: AttemptCheck[] | null; reason?: string }> {
  const runs = join(worktree, ".loki", "runs");
  if (!existsSync(runs)) return { checks: null, reason: "no engine10 receipt was sealed" };
  const dirs = readdirSync(runs).filter((d) => statSync(join(runs, d)).isDirectory()).sort();
  const newest = dirs[dirs.length - 1];
  if (newest === undefined) return { checks: null, reason: "no engine10 receipt was sealed" };
  const f = join(runs, newest, "receipt.json");
  if (!existsSync(f)) return { checks: null, reason: "no engine10 receipt was sealed" };
  try {
    const verdict = (await verify(f)).verdict;
    if (verdict !== "VERIFIED") return { checks: null, reason: `the sealed engine10 receipt failed verification (${verdict})` };
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown> & { checks?: AttemptCheck[]; reason?: string };
    const outcome = outcomeOf(j);
    if (outcome !== "VERIFIED" && outcome !== "ALREADY_SATISFIED") {
      const why = typeof j.reason === "string" && j.reason !== "" ? ` (engine10 reason: ${j.reason})` : "";
      return { checks: null, reason: `engine10 sealed a receipt with outcome ${outcome}${why}` };
    }
    return Array.isArray(j.checks) ? { checks: j.checks } : { checks: null, reason: "the sealed receipt records no checks" };
  } catch {
    return { checks: null, reason: "the sealed engine10 receipt could not be read" };
  }
}

export async function readRecordedChecks(worktree: string, verify: (receiptPath: string) => Promise<{ verdict: string }> = verifyReceipt): Promise<AttemptCheck[] | null> {
  return (await assessAttempt(worktree, verify)).checks;
}

/** Run id, receipt hash and outcome of the newest engine10 receipt, shown on the attempts receipt. */
export function readEngine10Ref(worktree: string): AttemptOutcome["engine10"] | undefined {
  try {
    const runs = join(worktree, ".loki", "runs");
    const dirs = readdirSync(runs).filter((d) => statSync(join(runs, d)).isDirectory()).sort();
    const id = dirs[dirs.length - 1];
    if (!id) return undefined;
    const j = JSON.parse(readFileSync(join(runs, id, "receipt.json"), "utf8")) as Record<string, unknown>;
    return typeof j["receipt_sha256"] === "string" ? { run_id: id, receipt_sha256: j["receipt_sha256"], outcome: outcomeOf(j) } : undefined;
  } catch {
    return undefined;
  }
}

function attemptBranch(p: string): string {
  return `loki-attempt/${basename(dirname(p))}-${basename(p)}`;
}

export function productionDeps(repoDir: string, runDirect: () => Promise<number>, runInWorktree: (id: number, wt: string) => Promise<number>, opts: { noPr?: boolean } = {}): AttemptDeps {
  const lokiDir = process.env["LOKI_DIR"] ?? resolve(repoDir, ".loki");
  const receiptDir = join(lokiDir, "attempts", new Date().toISOString().replace(/[:.]/g, "-"));
  return {
    repoDir,
    receiptDir,
    baseSha: () => git(repoDir, ["rev-parse", "HEAD"]).trim(),
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
      const ref = readEngine10Ref(wt);
      const a = await assessAttempt(wt);
      if (ref) {
        // The worktree is removed afterwards; keep the sealed run dir so the cited receipt can still be checked.
        try {
          const dest = join(receiptDir, `attempt-${id}`);
          mkdirSync(dest, { recursive: true });
          cpSync(join(wt, ".loki", "runs", ref.run_id), join(dest, ref.run_id), { recursive: true });
          ref.preserved_path = join(dest, ref.run_id);
        } catch {
          // preservation is best effort; the summary then omits the kept path
        }
      }
      return { id, exit, checks: a.checks, ...(a.reason ? { unproven_reason: a.reason } : {}), ...(ref ? { engine10: ref } : {}) };
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
    ...(opts.noPr ? {} : {
      // Normal PR behavior: only the winner's engine10 branch is pushed and opened; losers never reach a remote.
      openPr: (wt: string, base: string) => {
        const branch = git(wt, ["symbolic-ref", "--short", "HEAD"]).trim();
        git(wt, ["push", "-u", "origin", branch]);
        const baseBranch = (() => { try { return git(repoDir, ["symbolic-ref", "--short", "HEAD"]).trim(); } catch { return base; } })();
        return execFileSync("gh", ["pr", "create", "--fill", "--head", branch, "--base", baseBranch], { cwd: wt, encoding: "utf8" }).trim().split("\n").pop() ?? "";
      },
    }),
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
