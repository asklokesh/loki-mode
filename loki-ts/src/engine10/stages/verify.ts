// E-09 Fast verify (docs/v10/ENGINE.md section 4 "Fast verify", section 16 E-09).
//
// Runs impacted + changed test files + Wall tests, plus lint/typecheck of the
// changed files, each under one per-check timeout. A missing tool is a
// NOT PROVEN entry ("not_run"), never a failure. A failing check gets exactly
// one rerun; fail-then-pass is recorded "flaky", not "fail". An empty diff
// with the implementer's already_done marker seals ALREADY_SATISFIED with no
// checks run; an empty diff without that marker is FAILED (ENGINE.md section
// 2, "Feature already existed" row).
//
// testmap.ts (E-05) and machine.ts (E-02) are not on main: this stage talks
// to them only through RunContext's `tests: TestMapProvider`, injected as a
// fake in tests, and is never imported here.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImplementExit, RunContext, Stage, StageResult, TestRef } from "../types.ts";
import { STAGE_BUDGETS } from "../types.ts";

const CHECK_TIMEOUT_MS = 60_000; // ENGINE.md 16 E-09: "60s limit" per check; limitS (120s) is the stage's outer bound

/** implement.ts's (E-08) full stage.completed.data isn't in the shared contract
 *  yet; this is the one field verify.ts reads from it. ImplementExit itself
 *  IS a contract type (types.ts). */
interface ImplementOutput {
  exit?: ImplementExit;
}

/** wall.ts's (E-15) full output isn't in the contract either; verify.ts only
 *  needs the sealed file list, shaped like Receipt["wall"].files. */
interface WallOutput {
  files?: { path: string }[];
}

export interface VerifyCheck {
  name: string;
  cmd: string;
  result: "pass" | "fail" | "not_run" | "flaky"; // ENGINE.md section 5 test.result enum
  duration_s: number;
  reason?: string;
}

// Command shapes exactly as ENGINE.md section 8's table names them per
// runner. npm and cargo are documented "coarse" (no per-file selection);
// go runs per package dir, also coarse below that grain.
function runnerCmd(t: TestRef): [string, string[]] {
  switch (t.runner) {
    case "pytest": return ["python", ["-m", "pytest", "-q", t.path]];
    case "vitest": return ["npx", ["vitest", "run", t.path]];
    case "jest": return ["npx", ["jest", t.path]];
    case "bun": return ["bun", ["test", t.path]];
    case "npm": return ["npm", ["test", "--silent"]];
    case "go": return ["go", ["test", `./${dirname(t.path)}`]];
    case "cargo": return ["cargo", ["test"]];
  }
}

function dedupeTests(tests: TestRef[]): TestRef[] {
  const seen = new Set<string>();
  const out: TestRef[] = [];
  for (const t of tests) {
    const key = `${t.runner}:${t.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Tracked changes against baseSha, plus untracked new files (the implementer
 *  has not committed yet: commit runs after verify). `.loki/` is filtered
 *  defensively even though intake also excludes it via .git/info/exclude,
 *  so a fixture repo that skips that step still gets a real empty diff.
 *  Throws if either git command fails: a broken baseSha must never read as
 *  "nothing changed", which would masquerade as ALREADY_SATISFIED. */
export function changedFiles(repoDir: string, baseSha: string): string[] {
  const run = (args: string[]): string[] =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  const tracked = run(["diff", "--name-only", baseSha]);
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])].filter((f) => !f.startsWith(".loki/"));
}

interface RunOpts {
  path?: string; // PATH override, tests only, so "missing tool" never depends on the host
  stdin?: string;
  timeoutMs?: number; // per-attempt timeout override, tests only; defaults to CHECK_TIMEOUT_MS
}

/** `cut` means the timeout or the stage's own AbortSignal killed the child:
 *  distinct from a genuine nonzero exit, so it is never read as "fail" and
 *  never retried (a hung check must not burn 2x its timeout). */
async function runOnce(cmd: string, args: string[], cwd: string, signal: AbortSignal, opts: RunOpts): Promise<{ ok: boolean; missing: boolean; cut: boolean }> {
  if (!Bun.which(cmd, opts.path ? { PATH: opts.path } : undefined)) return { ok: false, missing: true, cut: false };
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
    stdout: "ignore",
    stderr: "ignore",
    signal: AbortSignal.any([signal, timeout]),
    env: opts.path ? { ...process.env, PATH: opts.path } : process.env,
  });
  const exitCode = await proc.exited;
  const cut = timeout.aborted || signal.aborted;
  return { ok: exitCode === 0 && !cut, missing: false, cut };
}

/** Runs one check with a single retry: fail-then-pass is "flaky", not "fail".
 *  A missing tool, or a timed-out / aborted run, is recorded once and never
 *  retried. */
export async function runCheck(
  ctx: RunContext, name: string, cmd: string, args: string[], signal: AbortSignal,
  checks: VerifyCheck[], opts: RunOpts = {},
): Promise<VerifyCheck> {
  const started = Date.now();
  const cmdStr = [cmd, ...args].join(" ");
  const cutReason = () => (signal.aborted ? "aborted" : `timed out after ${(opts.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000}s`);
  let attempt = await runOnce(cmd, args, ctx.repoDir, signal, opts);
  let result: VerifyCheck["result"];
  let reason: string | undefined;
  if (attempt.missing) {
    result = "not_run";
    reason = `${cmd} not found on PATH`;
  } else if (attempt.cut) {
    result = "not_run";
    reason = cutReason();
  } else if (attempt.ok) {
    result = "pass";
  } else {
    attempt = await runOnce(cmd, args, ctx.repoDir, signal, opts);
    if (attempt.cut) {
      result = "not_run";
      reason = cutReason();
    } else {
      result = attempt.ok ? "flaky" : "fail";
    }
  }
  const check: VerifyCheck = { name, cmd: cmdStr, result, duration_s: (Date.now() - started) / 1000, ...(reason ? { reason } : {}) };
  checks.push(check);
  ctx.emit("test.result", "verify", { ...check });
  return check;
}

// ponytail: existence of our own selector script is a strong enough marker
// that repoDir IS the loki-mode repo; a build target repo will not carry it.
function isLokiModeRepo(repoDir: string): boolean {
  return existsSync(join(repoDir, "scripts", "select-tests.sh"));
}

const ESLINT_CONFIGS = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];

/** ENGINE.md section 4's named tool per language: bash -n + shellcheck for
 *  shell, tsc (project-scoped) + eslint (when configured) for TS/JS, ruff for
 *  Python. Exported so a missing-tool scenario (e.g. no shellcheck on PATH)
 *  can be exercised directly with a PATH override, the same pattern the
 *  "missing tool" runCheck tests already use. Every named tool that applies
 *  to the changed set gets a check entry: a missing tool is not_run, never a
 *  silently absent entry (ENGINE.md section 9's NOT PROVEN requirement). */
export async function runLintChecks(
  ctx: RunContext, changed: string[], signal: AbortSignal, checks: VerifyCheck[], opts: RunOpts = {},
): Promise<void> {
  const py = changed.filter((f) => f.endsWith(".py"));
  if (py.length) await runCheck(ctx, "lint:ruff", "ruff", ["check", ...py], signal, checks, opts);

  const sh = changed.filter((f) => f.endsWith(".sh"));
  if (sh.length) {
    await runCheck(ctx, "lint:bash-n", "bash", ["-c", 'for f in "$@"; do bash -n "$f" || exit 1; done', "_", ...sh], signal, checks, opts);
    await runCheck(ctx, "lint:shellcheck", "shellcheck", sh, signal, checks, opts);
  }

  const tsjs = changed.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
  if (tsjs.length) {
    if (existsSync(join(ctx.repoDir, "tsconfig.json"))) {
      await runCheck(ctx, "lint:tsc", "npx", ["tsc", "--noEmit", "-p", "."], signal, checks, opts);
    }
    if (ESLINT_CONFIGS.some((f) => existsSync(join(ctx.repoDir, f)))) {
      await runCheck(ctx, "lint:eslint", "npx", ["eslint", ...tsjs], signal, checks, opts);
    }
  }
}

export const verifyStage: Stage = {
  name: "verify",
  targetS: STAGE_BUDGETS.verify.targetS,
  limitS: STAGE_BUDGETS.verify.limitS,
  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    let changed: string[];
    try {
      changed = changedFiles(ctx.repoDir, ctx.baseSha);
    } catch (err) {
      return { status: "failed", data: {}, reason: `git diff against base failed: ${(err as Error).message}` };
    }
    if (changed.length === 0) {
      const implementExit = (ctx.outputs().implement as ImplementOutput | undefined)?.exit;
      if (implementExit === "already_done") {
        return { status: "completed", data: { already_satisfied: true, checks: [], flaky: [], failures_grouped: [], changed_files: [] } };
      }
      return { status: "failed", data: { changed_files: [] }, reason: "empty diff without an already_done marker" };
    }

    const checks: VerifyCheck[] = [];
    const map = await ctx.tests.detect(ctx.repoDir);
    const impacted = ctx.tests.impacted(map, changed);
    const changedTestFiles = map.tests.filter((t) => changed.includes(t.path));
    const wall = (ctx.outputs().wall as WallOutput | undefined) ?? {};
    const wallPaths = new Set((wall.files ?? []).map((f) => f.path));
    const wallTests = map.tests.filter((t) => wallPaths.has(t.path));
    const tests = dedupeTests([...impacted, ...changedTestFiles, ...wallTests]);

    for (const t of tests) {
      if (signal.aborted) break;
      const [cmd, args] = runnerCmd(t);
      await runCheck(ctx, `${t.runner}:${t.path}`, cmd, args, signal, checks);
    }

    if (!signal.aborted) {
      // Lint/typecheck of changed files only, per ENGINE.md section 4's named
      // tool per language.
      await runLintChecks(ctx, changed, signal, checks);

      // Self-hosting only: also run the repo's own fast-gate selector
      // (ENGINE.md section 4, "the engine also runs scripts/select-tests.sh").
      if (isLokiModeRepo(ctx.repoDir)) {
        await runCheck(ctx, "select-tests", "bash", ["scripts/select-tests.sh", "--files", "-", "--run"], signal, checks, {
          stdin: changed.join("\n") + "\n",
        });
      }
    }

    const flaky = checks.filter((c) => c.result === "flaky").map((c) => c.name);
    // ponytail: real signature clustering is failures.ts (E-17), which
    // depends on this stage; a naive 1:1 placeholder keeps the required
    // section-4 output key populated until that slice lands.
    const failuresGrouped = checks
      .filter((c) => c.result === "fail")
      .map((c) => ({ signature: c.name, count: 1, sample: c.cmd }));

    return { status: "completed", data: { checks, flaky, failures_grouped: failuresGrouped, changed_files: changed } };
  },
};
