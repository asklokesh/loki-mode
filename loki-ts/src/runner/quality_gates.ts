// Quality-gate orchestration for the autonomous loop.
//
// Bash sources of truth:
//   enforce_static_analysis()    autonomy/run.sh:5498  (real gate, Phase 5+)
//   enforce_test_coverage()      autonomy/run.sh:5704  (real gate, Phase 5+)
//   run_code_review()            autonomy/run.sh:4935  (real gate, Phase 5+)
//   run_doc_staleness_check()    autonomy/run.sh:5852
//   run_doc_quality_gate()       autonomy/run.sh:5884
//   run_magic_debate_gate()      autonomy/run.sh:5941
//   track_gate_failure()         autonomy/run.sh:5639
//   clear_gate_failure()         autonomy/run.sh:5660
//   get_gate_failure_count()     autonomy/run.sh:5680
//   gate orchestration block     autonomy/run.sh:10848-10963
//
// Escalation ladder (autonomy/run.sh:725-727 and :10894-10921, code_review only
// in bash today; this module applies the ladder uniformly to every gate so the
// TS port can extend coverage without diverging):
//   count >= GATE_PAUSE_LIMIT     -> write .loki/PAUSE + signals/GATE_ESCALATION
//   count >= GATE_ESCALATE_LIMIT  -> write signals/GATE_ESCALATION (no pause)
//   count >= GATE_CLEAR_LIMIT     -> log warning, treat as passing this round
//
// Phase 5 status: runStaticAnalysis, runTestCoverage, runDocQualityGate,
// runMagicDebateGate, and runCodeReview are real ports of the corresponding
// bash gates. The reviewer dispatcher used by runCodeReview is still a stub
// (returns "VERDICT: PASS\nFINDINGS:\n- (stub)") pending the providers.ts
// integration in v7.5.0+; the SELECTION + AGGREGATION orchestration around
// it is real. The escalation ladder and failure-count persistence are real
// and final.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { run } from "../util/shell.ts";
import type { RunnerContext } from "./types.ts";

// --- Public types ----------------------------------------------------------

export type GateOutcome = {
  // Gate names that ran and passed (or were treated as passing under the
  // CLEAR_LIMIT rule).
  passed: string[];
  // Gate names that ran and failed this iteration.
  failed: string[];
  // True when at least one gate failed and was not cleared by the CLEAR rule.
  blocked: boolean;
  // True when the PAUSE_LIMIT or ESCALATE_LIMIT was reached for any gate.
  // Caller (autonomous.ts) inspects this to decide whether to pause the loop.
  escalated: boolean;
};

export type GateName =
  | "static_analysis"
  | "test_coverage"
  | "code_review"
  | "doc_coverage"
  | "magic_debate";

export type GateResult = {
  passed: boolean;
  // Optional human-readable detail surfaced into logs / prompt injection.
  detail?: string;
};

// Escalation ladder limits, mirroring autonomy/run.sh:725-727. Read once at
// gate-run time so tests can override via env without restarting the process.
type EscalationLimits = {
  clear: number;
  escalate: number;
  pause: number;
};

function readEscalationLimits(): EscalationLimits {
  const parse = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    clear: parse("LOKI_GATE_CLEAR_LIMIT", 3),
    escalate: parse("LOKI_GATE_ESCALATE_LIMIT", 5),
    pause: parse("LOKI_GATE_PAUSE_LIMIT", 10),
  };
}

// --- Failure-count persistence --------------------------------------------

// Match the bash on-disk path: <lokiDir>/quality/gate-failure-count.json.
function gateFilePath(base: string): string {
  return join(base, "quality", "gate-failure-count.json");
}

function resolveBase(override?: string): string {
  return override ?? lokiDir();
}

// Atomic write via tmp + rename, matching the pattern used by state.ts.
// renameSync is atomic on POSIX when both paths share a filesystem.
function atomicWrite(target: string, body: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
}

function readCounts(base: string): Record<string, number> {
  const file = gateFilePath(base);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    // Bash equivalent swallows JSONDecodeError/FileNotFoundError and returns {}.
    return {};
  }
}

function writeCounts(base: string, counts: Record<string, number>): void {
  atomicWrite(gateFilePath(base), `${JSON.stringify(counts, null, 2)}\n`);
}

// Increment and persist. Returns the new count for that gate.
// Mirror of bash track_gate_failure() (autonomy/run.sh:5639).
export function trackGateFailure(name: string, lokiDirOverride?: string): number {
  const base = resolveBase(lokiDirOverride);
  const counts = readCounts(base);
  const next = (counts[name] ?? 0) + 1;
  counts[name] = next;
  writeCounts(base, counts);
  return next;
}

// Reset a single gate counter to 0. Mirror of bash clear_gate_failure()
// (autonomy/run.sh:5660). When the file does not exist this is a no-op so
// successful gates on a fresh repo do not create empty files.
export function clearGateFailure(name: string, lokiDirOverride?: string): void {
  const base = resolveBase(lokiDirOverride);
  const file = gateFilePath(base);
  if (!existsSync(file)) return;
  const counts = readCounts(base);
  counts[name] = 0;
  writeCounts(base, counts);
}

// Read-only view of the current count. Mirror of bash get_gate_failure_count().
export function getGateFailureCount(name: string, lokiDirOverride?: string): number {
  const counts = readCounts(resolveBase(lokiDirOverride));
  return counts[name] ?? 0;
}

// --- Stub gate runners (Phase 5+ replaces these with real ports) ----------

// Each stub honors a per-gate env override so tests (and operators wanting to
// dry-run the orchestration) can force a deterministic outcome without the
// real analyzer being available.
//
// LOKI_STUB_GATE_<UPPER>=fail  -> stub returns failure
// LOKI_STUB_GATE_<UPPER>=pass  -> stub returns pass (default)
function stubResult(name: GateName): GateResult {
  const key = `LOKI_STUB_GATE_${name.toUpperCase()}`;
  const v = process.env[key];
  if (v === "fail") return { passed: false, detail: `stub forced fail via ${key}` };
  return { passed: true, detail: "stub" };
}

// Recursively list files under `dir` whose name ends with `suffix`.
// Returns absolute paths. Returns [] if `dir` is missing -- callers treat
// that as "nothing to check" (see runStaticAnalysis below).
function listFilesBySuffix(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  let st;
  try {
    st = statSync(dir);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        // Skip node_modules and dotdirs to keep the scan bounded.
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith(suffix)) {
        out.push(p);
      }
    }
  }
  return out;
}

// Phase 5 real implementation. Mirrors the bash `enforce_static_analysis`
// shell-script + JS branches at autonomy/run.sh:5572-5593 and 5516-5543, but
// scoped to the directory layout the spec calls out (autonomy/*.sh +
// scripts/*.js). Both subprocess wrappers honor a 30s timeout per file so a
// hung interpreter cannot stall the iteration.
//
// Honors LOKI_STUB_GATE_STATIC_ANALYSIS for tests that prefer to drive the
// orchestrator without spawning real subprocesses (the stub override wins).
export async function runStaticAnalysis(ctx?: RunnerContext): Promise<GateResult> {
  const stubKey = "LOKI_STUB_GATE_STATIC_ANALYSIS";
  const stubVal = process.env[stubKey];
  if (stubVal === "fail" || stubVal === "pass") return stubResult("static_analysis");

  const root = ctx?.cwd ?? process.cwd();
  const shFiles = listFilesBySuffix(join(root, "autonomy"), ".sh");
  const jsFiles = listFilesBySuffix(join(root, "scripts"), ".js");

  const errors: string[] = [];
  const TIMEOUT_MS = 30_000;

  for (const f of shFiles) {
    const r = await run(["bash", "-n", f], { timeoutMs: TIMEOUT_MS });
    if (r.exitCode !== 0) {
      const msg = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split(/\r?\n/).slice(0, 3).join(" | ");
      errors.push(`bash -n ${f}: ${msg}`);
    }
  }
  for (const f of jsFiles) {
    const r = await run(["node", "--check", f], { timeoutMs: TIMEOUT_MS });
    if (r.exitCode !== 0) {
      const msg = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split(/\r?\n/).slice(0, 3).join(" | ");
      errors.push(`node --check ${f}: ${msg}`);
    }
  }

  const total = shFiles.length + jsFiles.length;
  if (errors.length > 0) {
    return {
      passed: false,
      detail: `static_analysis: ${errors.length}/${total} failed -- ${errors.slice(0, 3).join("; ")}`,
    };
  }
  return { passed: true, detail: `static_analysis: ${total} files clean` };
}

// Shape the bash gate writes to .loki/quality/test-results.json (see
// enforce_test_coverage at autonomy/run.sh:5704). When that artifact is
// already present we trust it -- this lets the bash gate (still running in
// production) hand off to the TS orchestrator without re-running the suite.
type TestResultsArtifact = {
  pass?: boolean;
  passed?: number;
  failed?: number;
  runner?: string;
  summary?: string;
};

function readTestResultsArtifact(base: string): TestResultsArtifact | null {
  const p = join(base, "quality", "test-results.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as TestResultsArtifact;
  } catch {
    return null;
  }
}

// Phase 5 real implementation. First checks .loki/quality/test-results.json
// (written by the bash gate or any prior TS run); falls back to `npm test
// --silent` with the 5-minute timeout the bash gate uses (autonomy/run.sh:5718).
//
// Honors LOKI_STUB_GATE_TEST_COVERAGE so existing orchestration tests can keep
// using the stub escape hatch.
export async function runTestCoverage(ctx?: RunnerContext): Promise<GateResult> {
  const stubKey = "LOKI_STUB_GATE_TEST_COVERAGE";
  const stubVal = process.env[stubKey];
  if (stubVal === "fail" || stubVal === "pass") return stubResult("test_coverage");

  const base = ctx?.lokiDir ?? lokiDir();
  const artifact = readTestResultsArtifact(base);
  if (artifact !== null) {
    // Treat explicit pass=false or any failed>0 as a failure. When pass is
    // missing we infer from failed count (defaulting to 0 -> pass).
    const failed = typeof artifact.failed === "number" ? artifact.failed : 0;
    const passed = typeof artifact.passed === "number" ? artifact.passed : 0;
    const explicitPass = artifact.pass === true;
    const explicitFail = artifact.pass === false;
    const ok = explicitFail ? false : explicitPass || failed === 0;
    const detail = `test_coverage(artifact:${artifact.runner ?? "unknown"}): passed=${passed} failed=${failed}`;
    return { passed: ok, detail };
  }

  // No artifact -- fall back to running `npm test --silent` if package.json exists.
  const cwd = ctx?.cwd ?? process.cwd();
  if (!existsSync(join(cwd, "package.json"))) {
    return { passed: true, detail: "test_coverage: no test-results.json and no package.json -- skipping" };
  }

  const r = await run(["npm", "test", "--silent"], { cwd, timeoutMs: 300_000 });
  if (r.exitCode === 0) {
    return { passed: true, detail: "test_coverage: npm test exit 0" };
  }
  const tail = (r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
  return { passed: false, detail: `test_coverage: npm test exit ${r.exitCode} -- ${tail}` };
}

// --- Code review: 3-reviewer parallel council ----------------------------
//
// Bash source: autonomy/run.sh:6234-6646 (run_code_review, ~413 LOC).
//
// Faithful TS port of the SELECTION + DISPATCH + AGGREGATION pipeline. The
// reviewer dispatch itself remains stubbed pending the providers.ts
// integration (v7.5.0+); the orchestration around it is real.
//
// Pipeline:
//   1. git diff HEAD~1 (fall back to git diff --cached, then "")
//   2. If diff is empty, skip (return passed=true)
//   3. Score 5 specialist reviewers by keyword presence in diff+filenames
//   4. Always select architecture-strategist + top 2 specialists
//   5. Dispatch all 3 reviewers in parallel via Promise.all
//   6. Write per-reviewer .txt outputs under .loki/quality/reviews/<id>/
//   7. Aggregate verdicts; any [Critical] or [High] -> BLOCK
//   8. Write aggregate.json + selection.json

export type Reviewer = {
  name: string;
  focus: string;
  checks: string;
};

export type ReviewerVerdict = {
  reviewer: string;
  verdict: "PASS" | "FAIL" | "UNKNOWN" | "NO_OUTPUT";
  blocking: boolean;
  output: string;
};

export type ReviewerInput = {
  reviewer: Reviewer;
  diff: string;
  files: string;
  prompt: string;
};

// Dispatcher contract: the orchestrator hands a built prompt to this fn and
// expects the raw reviewer output text back. Production wiring (v7.5.0+)
// calls the active provider; tests inject deterministic stubs.
export type ReviewerFn = (input: ReviewerInput) => Promise<string>;

type Specialist = {
  keywords: readonly string[];
  focus: string;
  checks: string;
  priority: number;
};

// Mirror of SPECIALISTS dict in autonomy/run.sh:6318-6349. Order preserved so
// the priority field acts as the same tie-breaker the bash code uses.
const SPECIALISTS: Readonly<Record<string, Specialist>> = {
  "security-sentinel": {
    keywords: ["auth", "login", "password", "token", "api", "sql", "query", "cookie", "cors", "csrf"],
    focus: "OWASP Top 10, injection, auth, secrets, input validation",
    checks: "injection (SQL, XSS, command, template), auth bypass, secrets in code, missing input validation, OWASP Top 10, insecure defaults",
    priority: 0,
  },
  "test-coverage-auditor": {
    keywords: ["test", "spec", "coverage", "assert", "mock", "fixture", "expect", "describe"],
    focus: "Missing tests, edge cases, error paths, boundary conditions",
    checks: "missing test cases, uncovered error paths, boundary conditions, mock correctness, test isolation, flaky test patterns",
    priority: 1,
  },
  "performance-oracle": {
    keywords: ["database", "query", "cache", "render", "loop", "fetch", "load", "index", "join", "pool"],
    focus: "N+1 queries, memory leaks, caching, bundle size, lazy loading",
    checks: "N+1 queries, unbounded loops, memory leaks, missing caching, excessive re-renders, large bundle imports, missing pagination",
    priority: 2,
  },
  "dependency-analyst": {
    keywords: ["package", "import", "require", "dependency", "npm", "pip", "yarn", "lock"],
    focus: "Outdated packages, CVEs, bloat, unused deps, license issues",
    checks: "outdated dependencies, known CVEs, unnecessary imports, dependency bloat, license compatibility, unused packages",
    priority: 3,
  },
  "legacy-healing-auditor": {
    keywords: ["legacy", "heal", "migrate", "cobol", "fortran", "refactor", "modernize", "deprecat", "adapter", "friction", "characterization"],
    focus: "Behavioral preservation, friction safety, institutional knowledge retention",
    checks: "behavioral change without characterization test, removal of quirky code without friction map check, missing adapter layer for replaced components, institutional knowledge loss (deleted comments, removed error messages), breaking changes to undocumented APIs",
    priority: 4,
  },
};

const ARCHITECTURE_STRATEGIST: Reviewer = {
  name: "architecture-strategist",
  focus: "SOLID, coupling, cohesion, patterns, abstraction, dependency direction",
  checks: "SOLID violations, excessive coupling, wrong patterns, missing abstractions, dependency direction issues, god classes/functions",
};

// Port of the Python keyword scorer at autonomy/run.sh:6396-6409. Returns
// architecture-strategist always first, then 2 specialists. When no keywords
// match, defaults to security-sentinel + test-coverage-auditor to match the
// bash behavior.
export type SelectionResult = {
  reviewers: Reviewer[];
  scores: Record<string, number>;
  pool_size: number;
};

export function selectReviewers(diff: string, files: string): SelectionResult {
  const search = `${diff} ${files}`.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [name, spec] of Object.entries(SPECIALISTS)) {
    let s = 0;
    for (const kw of spec.keywords) if (search.includes(kw)) s += 1;
    scores[name] = s;
  }

  const allZero = Object.values(scores).every((v) => v === 0);
  let selected: string[];
  if (allZero) {
    selected = ["security-sentinel", "test-coverage-auditor"];
  } else {
    selected = Object.keys(SPECIALISTS)
      .slice()
      .sort((a, b) => {
        const sa = scores[a] ?? 0;
        const sb = scores[b] ?? 0;
        if (sb !== sa) return sb - sa;
        return SPECIALISTS[a]!.priority - SPECIALISTS[b]!.priority;
      })
      .slice(0, 2);
  }

  const reviewers: Reviewer[] = [
    ARCHITECTURE_STRATEGIST,
    ...selected.map((name) => {
      const spec = SPECIALISTS[name]!;
      return { name, focus: spec.focus, checks: spec.checks };
    }),
  ];

  return { reviewers, scores, pool_size: Object.keys(SPECIALISTS).length };
}

// Port of the BUILD_PROMPT block at autonomy/run.sh:6486-6505.
export function buildReviewerPrompt(reviewer: Reviewer, diff: string, files: string): string {
  return `You are ${reviewer.name}. Your SOLE focus is: ${reviewer.focus}.

Review ONLY for: ${reviewer.checks}.

Files changed:
${files.trim()}

Diff:
${diff.trim()}

Output format (STRICT - follow exactly):
VERDICT: PASS or FAIL
FINDINGS:
- [severity] description (file:line)
Severity levels: Critical, High, Medium, Low

If no issues found, output:
VERDICT: PASS
FINDINGS:
- None`;
}

// STUB: Phase 5 next iteration -- real provider dispatch pending.
// Default reviewer that returns a deterministic PASS so the orchestration is
// exercisable end-to-end before providers.ts wiring lands. Tests inject their
// own ReviewerFn to drive specific verdicts.
export const stubReviewer: ReviewerFn = async () => "VERDICT: PASS\nFINDINGS:\n- (stub)";

// Parse a reviewer output blob into a structured verdict. Mirrors the bash
// `grep -i "^VERDICT:"` + `grep -qiE "\[(Critical|High)\]"` checks at
// autonomy/run.sh:6577-6594.
export function parseVerdict(reviewer: string, output: string): ReviewerVerdict {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return { reviewer, verdict: "NO_OUTPUT", blocking: false, output };
  }
  const verdictLine = output
    .split(/\r?\n/)
    .find((line) => /^VERDICT:/i.test(line));
  let verdict: ReviewerVerdict["verdict"] = "UNKNOWN";
  if (verdictLine !== undefined) {
    const raw = verdictLine.replace(/^VERDICT:/i, "").trim().toUpperCase();
    if (raw === "PASS" || raw === "FAIL") verdict = raw;
  }
  const hasBlockingSeverity = /\[(Critical|High)\]/i.test(output);
  return {
    reviewer,
    verdict,
    blocking: verdict === "FAIL" && hasBlockingSeverity,
    output,
  };
}

// Port of the diff-fetching block at autonomy/run.sh:6243. Tries `git diff
// HEAD~1` first; falls back to `git diff --cached`; returns "" on both
// failures (matches the bash `2>/dev/null || ... || echo ""` chain).
async function readDiffAndFiles(cwd: string): Promise<{ diff: string; files: string }> {
  const tryGit = async (args: readonly string[]): Promise<string | null> => {
    const r = await run(["git", "-C", cwd, ...args], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) return null;
    return r.stdout;
  };
  const diff = (await tryGit(["diff", "HEAD~1"])) ?? (await tryGit(["diff", "--cached"])) ?? "";
  const files = (await tryGit(["diff", "--name-only", "HEAD~1"])) ?? (await tryGit(["diff", "--name-only", "--cached"])) ?? "";
  return { diff, files };
}

export type CodeReviewOpts = {
  // Allow tests to inject a deterministic ReviewerFn instead of calling the
  // real provider. Production callers omit this and get the stub for now.
  reviewer?: ReviewerFn;
  // Allow tests to inject pre-computed diff/files instead of shelling out to
  // git. When omitted the runner reads from `git -C ctx.cwd diff HEAD~1`.
  diffOverride?: { diff: string; files: string };
};

// Aggregated artifact written to .loki/quality/reviews/<id>/aggregate.json.
// Shape mirrors the bash AGG_SCRIPT block (autonomy/run.sh:6605-6617).
export type AggregateArtifact = {
  review_id: string;
  iteration: number;
  pass_count: number;
  fail_count: number;
  has_blocking: boolean;
  verdicts: string;
};

export async function runCodeReview(
  ctx?: RunnerContext,
  opts: CodeReviewOpts = {},
): Promise<GateResult> {
  // Honor stub override first so existing orchestration tests (which set
  // LOKI_STUB_GATE_CODE_REVIEW=fail/pass) keep working without hitting git.
  const stubKey = "LOKI_STUB_GATE_CODE_REVIEW";
  const stubVal = process.env[stubKey];
  if (stubVal === "fail" || stubVal === "pass") return stubResult("code_review");

  if (ctx === undefined) {
    return { passed: true, detail: "code_review: no ctx, skipped" };
  }

  const cwd = ctx.cwd;
  const base = ctx.lokiDir;
  const reviewer = opts.reviewer ?? stubReviewer;

  const { diff, files } = opts.diffOverride ?? (await readDiffAndFiles(cwd));
  if (diff.trim().length === 0) {
    return { passed: true, detail: "code_review: no diff to review" };
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const reviewId = `review-${ts}-${ctx.iterationCount}`;
  const reviewDir = join(base, "quality", "reviews", reviewId);
  mkdirSync(reviewDir, { recursive: true });

  writeFileSync(join(reviewDir, "diff.txt"), diff);
  writeFileSync(join(reviewDir, "files.txt"), files);

  const selection = selectReviewers(diff, files);
  atomicWrite(join(reviewDir, "selection.json"), `${JSON.stringify(selection, null, 2)}\n`);

  // Dispatch all reviewers in parallel via Promise.all (parity with the bash
  // backgrounding-and-wait loop at run.sh:6516-6556).
  const results = await Promise.all(
    selection.reviewers.map(async (rv): Promise<ReviewerVerdict> => {
      const prompt = buildReviewerPrompt(rv, diff, files);
      writeFileSync(join(reviewDir, `${rv.name}-prompt.txt`), prompt);
      let output: string;
      try {
        output = await reviewer({ reviewer: rv, diff, files, prompt });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output = `VERDICT: FAIL\nFINDINGS:\n- [Critical] reviewer threw: ${msg}`;
      }
      writeFileSync(join(reviewDir, `${rv.name}.txt`), output);
      return parseVerdict(rv.name, output);
    }),
  );

  let passCount = 0;
  let failCount = 0;
  let hasBlocking = false;
  const verdictTokens: string[] = [];
  for (const v of results) {
    if (v.verdict === "PASS") passCount += 1;
    else if (v.verdict === "FAIL") failCount += 1;
    if (v.blocking) hasBlocking = true;
    verdictTokens.push(`${v.reviewer}:${v.verdict}`);
  }
  const verdictsSummary = verdictTokens.join(" ");

  const aggregate: AggregateArtifact = {
    review_id: reviewId,
    iteration: ctx.iterationCount,
    pass_count: passCount,
    fail_count: failCount,
    has_blocking: hasBlocking,
    verdicts: verdictsSummary,
  };
  atomicWrite(join(reviewDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);

  // Anti-sycophancy note (autonomy/run.sh:6629-6635).
  if (passCount === selection.reviewers.length && failCount === 0) {
    writeFileSync(
      join(reviewDir, "anti-sycophancy.txt"),
      `UNANIMOUS_PASS: All reviewers approved - potential sycophancy risk\n`,
    );
  }

  if (hasBlocking) {
    return {
      passed: false,
      detail: `code_review: ${passCount}/${selection.reviewers.length} pass, ${failCount} fail, blocking severity present (${reviewId})`,
    };
  }
  return {
    passed: true,
    detail: `code_review: ${passCount}/${selection.reviewers.length} pass, ${failCount} fail (${reviewId})`,
  };
}

// Phase 5 real implementation. Doc quality gate scans the canonical project
// docs (README.md, CLAUDE.md, SKILL.md, docs/**/*.md) for three classes of
// problem mirrored from `run_doc_quality_gate` (autonomy/run.sh:5884-5933):
//
//   1. Minimum length -- a doc that is empty / near-empty is treated the same
//      as the bash gate's "README missing or empty" check.
//   2. Header presence -- every scanned doc must contain at least one ATX
//      header line (`# ...`) so it is not a wall of prose.
//   3. Broken local links -- markdown links of the form `[text](path)` whose
//      target is a relative on-disk path that does not exist. External (http,
//      mailto, ftp, tel), in-document anchors (`#section`), and template
//      placeholders are skipped.
//
// The gate is intentionally cheap (no subprocesses, no git lookups) so it
// can run on every iteration without slowing the loop. It honors
// LOKI_STUB_GATE_DOC_COVERAGE so orchestration tests keep their escape hatch.
//
// README.md, CLAUDE.md, and SKILL.md are required (parity with the bash
// README check). When a required file is missing the gate fails with a
// single clear error so the reviewer prompt has actionable feedback.
const DOC_MIN_BYTES = 64;

function listDocFiles(root: string): { path: string; required: boolean }[] {
  const out: { path: string; required: boolean }[] = [];
  // Required top-level docs. README is the user-facing entry, CLAUDE.md
  // carries the rules, SKILL.md is the skill manifest -- all first-class
  // artifacts of this repo.
  for (const name of ["README.md", "CLAUDE.md", "SKILL.md"]) {
    out.push({ path: join(root, name), required: true });
  }
  // docs/**/*.md -- best-effort, optional. Missing dir is fine.
  const docsDir = join(root, "docs");
  for (const f of listFilesBySuffix(docsDir, ".md")) {
    out.push({ path: f, required: false });
  }
  return out;
}

// Match `[text](target)` -- non-greedy on text, stop on `)` or whitespace in
// target so we do not gobble across multiple links on one line.
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function findBrokenLinks(filePath: string, body: string): string[] {
  const broken: string[] = [];
  const dir = dirname(filePath);
  for (const m of body.matchAll(LINK_RE)) {
    const target = m[2];
    if (target === undefined) continue;
    // Skip external schemes, in-doc anchors, and template placeholders.
    if (/^(https?:|mailto:|ftp:|tel:)/i.test(target)) continue;
    if (target.startsWith("#")) continue;
    if (target.startsWith("<") || target.includes("{{")) continue;
    // Strip query/fragment before existence check.
    const cleaned = target.split("#")[0]?.split("?")[0] ?? "";
    if (cleaned === "") continue;
    const resolved = cleaned.startsWith("/") ? cleaned : join(dir, cleaned);
    if (!existsSync(resolved)) {
      broken.push(`${filePath}: broken link -> ${target}`);
    }
  }
  return broken;
}

export async function runDocQualityGate(ctx?: RunnerContext): Promise<GateResult> {
  const stubKey = "LOKI_STUB_GATE_DOC_COVERAGE";
  const stubVal = process.env[stubKey];
  if (stubVal === "fail" || stubVal === "pass") return stubResult("doc_coverage");

  const root = ctx?.cwd ?? process.cwd();
  const docs = listDocFiles(root);
  const errors: string[] = [];
  let scanned = 0;

  for (const { path: p, required } of docs) {
    if (!existsSync(p)) {
      if (required) errors.push(`${p}: required doc missing`);
      continue;
    }
    let body = "";
    try {
      body = readFileSync(p, "utf-8");
    } catch (e) {
      errors.push(`${p}: unreadable (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    scanned += 1;
    if (body.trim().length < DOC_MIN_BYTES) {
      errors.push(`${p}: below minimum length (${body.trim().length} < ${DOC_MIN_BYTES} bytes)`);
    }
    // Require at least one ATX header line. /m so `^` matches per-line.
    if (!/^#{1,6}\s+\S/m.test(body)) {
      errors.push(`${p}: no markdown header found`);
    }
    for (const b of findBrokenLinks(p, body)) errors.push(b);
  }

  if (errors.length > 0) {
    return {
      passed: false,
      detail: `doc_coverage: ${errors.length} issue(s) across ${scanned} doc(s) -- ${errors.slice(0, 3).join("; ")}`,
    };
  }
  return { passed: true, detail: `doc_coverage: ${scanned} doc(s) clean` };
}

// Phase 5 real implementation. Magic-modules debate gate, modeled after
// `run_magic_debate_gate` (autonomy/run.sh:5941-5979) but specialized to a
// cheap structural heuristic instead of spawning the `loki magic debate`
// subprocess: every spec under .loki/magic/specs/*.md must contain at least
// one "Pros" header and one "Cons" header (case-insensitive ATX header).
//
// The gate is opt-in: it short-circuits to pass unless LOKI_GATE_MAGIC_DEBATE
// is explicitly set to "true" (per Phase 5 spec, default off). The
// orchestrator's PHASE/LOKI_GATE_* toggles still control whether the gate is
// *invoked*, but even when invoked the gate self-skips unless the operator
// has opted in, so a fresh checkout never trips it.
//
// When no specs directory exists the gate also passes (parity with bash).
function hasDebateHeader(body: string, kind: "pros" | "cons"): boolean {
  const re = new RegExp(`^#{1,6}\\s+${kind}\\b`, "im");
  return re.test(body);
}

export async function runMagicDebateGate(ctx?: RunnerContext): Promise<GateResult> {
  const stubKey = "LOKI_STUB_GATE_MAGIC_DEBATE";
  const stubVal = process.env[stubKey];
  if (stubVal === "fail" || stubVal === "pass") return stubResult("magic_debate");

  // Opt-in: default off per Phase 5 spec.
  if (process.env["LOKI_GATE_MAGIC_DEBATE"] !== "true") {
    return { passed: true, detail: "magic_debate: disabled (LOKI_GATE_MAGIC_DEBATE!=true)" };
  }

  const root = ctx?.cwd ?? process.cwd();
  const specsDir = join(root, ".loki", "magic", "specs");
  if (!existsSync(specsDir)) {
    return { passed: true, detail: "magic_debate: no specs dir -- skipping" };
  }
  const specs = listFilesBySuffix(specsDir, ".md");
  if (specs.length === 0) {
    return { passed: true, detail: "magic_debate: no specs found -- skipping" };
  }

  const errors: string[] = [];
  for (const p of specs) {
    let body = "";
    try {
      body = readFileSync(p, "utf-8");
    } catch (e) {
      errors.push(`${p}: unreadable (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (!hasDebateHeader(body, "pros")) errors.push(`${p}: missing 'Pros' section header`);
    if (!hasDebateHeader(body, "cons")) errors.push(`${p}: missing 'Cons' section header`);
  }

  if (errors.length > 0) {
    return {
      passed: false,
      detail: `magic_debate: ${errors.length} issue(s) across ${specs.length} spec(s) -- ${errors.slice(0, 3).join("; ")}`,
    };
  }
  return { passed: true, detail: `magic_debate: ${specs.length} spec(s) clean` };
}

// --- Orchestrator ---------------------------------------------------------

// Per-iteration toggles read from env. These mirror the bash gate-block guards
// at autonomy/run.sh:10851-10941 so the TS loop honors the same operator
// switches without re-reading them in every gate body.
type GateToggles = {
  hardGates: boolean;
  staticAnalysis: boolean;
  testCoverage: boolean;
  codeReview: boolean;
  docCoverage: boolean;
  magicDebate: boolean;
};

function readToggles(): GateToggles {
  const flag = (key: string, fallback: boolean): boolean => {
    const v = process.env[key];
    if (v === undefined || v === "") return fallback;
    return v === "true" || v === "1";
  };
  return {
    hardGates: flag("LOKI_HARD_GATES", true),
    staticAnalysis: flag("PHASE_STATIC_ANALYSIS", true),
    testCoverage: flag("PHASE_UNIT_TESTS", true),
    codeReview: flag("PHASE_CODE_REVIEW", true),
    docCoverage: flag("LOKI_GATE_DOC_COVERAGE", true),
    magicDebate: flag("LOKI_GATE_MAGIC_DEBATE", true),
  };
}

// Apply the escalation ladder for one failed gate. Returns the bookkeeping
// outcome the orchestrator needs without touching the loop's mutable state
// directly. Mirrors autonomy/run.sh:10904-10921.
type EscalationOutcome = {
  // True when the failure should be treated as passing (CLEAR_LIMIT rule).
  cleared: boolean;
  // True when ESCALATE_LIMIT or PAUSE_LIMIT was hit.
  escalated: boolean;
  // True only when PAUSE_LIMIT was hit -- caller writes the PAUSE signal.
  pause: boolean;
  count: number;
};

function applyEscalation(
  name: GateName,
  base: string,
  limits: EscalationLimits,
  ctx: RunnerContext,
): EscalationOutcome {
  const count = trackGateFailure(name, base);
  if (count >= limits.pause) {
    ctx.log(
      `Gate escalation: ${name} failed ${count} times (>= ${limits.pause}) - forcing PAUSE`,
    );
    writePauseSignal(base, name, count);
    return { cleared: false, escalated: true, pause: true, count };
  }
  if (count >= limits.escalate) {
    ctx.log(
      `Gate escalation: ${name} failed ${count} times (>= ${limits.escalate}) - escalating`,
    );
    writeEscalationSignal(base, name, count, "ESCALATE");
    return { cleared: false, escalated: true, pause: false, count };
  }
  if (count >= limits.clear) {
    ctx.log(
      `Gate cleared: ${name} failed ${count} times (>= ${limits.clear}) - passing this iteration, counter continues`,
    );
    return { cleared: true, escalated: false, pause: false, count };
  }
  return { cleared: false, escalated: false, pause: false, count };
}

// Match autonomy/run.sh:10906-10908. Two-line file: action then reason.
function writeEscalationSignal(base: string, gate: string, count: number, action: "PAUSE" | "ESCALATE"): void {
  const target = join(base, "signals", "GATE_ESCALATION");
  mkdirSync(dirname(target), { recursive: true });
  const body = `${action}\n${gate} gate failed ${count} consecutive times\n`;
  atomicWrite(target, body);
}

function writePauseSignal(base: string, gate: string, count: number): void {
  writeEscalationSignal(base, gate, count, "PAUSE");
  // Bash: `touch "${TARGET_DIR:-.}/.loki/PAUSE"` (run.sh:10908).
  const pause = join(base, "PAUSE");
  mkdirSync(dirname(pause), { recursive: true });
  writeFileSync(pause, "");
}

// Persist the comma-trailing failure list for prompt injection. Mirrors the
// `gate-failures.txt` write at autonomy/run.sh:10952-10955: write when there
// is at least one entry, delete otherwise.
function persistFailureList(base: string, failed: string[]): void {
  const target = join(base, "quality", "gate-failures.txt");
  if (failed.length === 0) {
    // Best-effort cleanup; rmSync with force ignores missing files already.
    try {
      rmSync(target, { force: true });
    } catch {
      // Nothing else depends on this file existing.
    }
    return;
  }
  const body = `${failed.join(",")},\n`;
  atomicWrite(target, body);
}

// Run every enabled gate in the bash order. Returns a structured outcome the
// caller (autonomous.ts) maps onto the iteration's terminate decision. The
// runner tolerates individual gate-runner exceptions: a thrown stub counts as
// a failure but does not abort the rest of the pipeline (bash treats a non-
// zero exit identically).
export async function runQualityGates(ctx: RunnerContext): Promise<GateOutcome> {
  const base = ctx.lokiDir;
  const limits = readEscalationLimits();
  const toggles = readToggles();
  const passed: string[] = [];
  const failed: string[] = [];
  let escalated = false;

  // Soft-gates path matches autonomy/run.sh:10957-10961: only code_review runs
  // (advisory) and the failure list is not persisted. We honor that in the
  // structured outcome by leaving `blocked` false even on advisory failures.
  if (!toggles.hardGates) {
    if (toggles.codeReview) {
      try {
        const r = await runCodeReview(ctx);
        if (r.passed) passed.push("code_review");
        else failed.push("code_review");
      } catch {
        failed.push("code_review");
      }
    }
    return { passed, failed, blocked: false, escalated: false };
  }

  // Hard-gates path -- mirror the bash ordering exactly. Real runners take
  // ctx so they can resolve repo + .loki paths without leaking env globals.
  const sequence: Array<{ name: GateName; enabled: boolean; run: () => Promise<GateResult> }> = [
    { name: "static_analysis", enabled: toggles.staticAnalysis, run: () => runStaticAnalysis(ctx) },
    { name: "test_coverage", enabled: toggles.testCoverage, run: () => runTestCoverage(ctx) },
    { name: "code_review", enabled: toggles.codeReview, run: () => runCodeReview(ctx) },
    { name: "doc_coverage", enabled: toggles.docCoverage, run: () => runDocQualityGate(ctx) },
    { name: "magic_debate", enabled: toggles.magicDebate, run: () => runMagicDebateGate(ctx) },
  ];

  for (const gate of sequence) {
    if (!gate.enabled) continue;
    let result: GateResult;
    try {
      result = await gate.run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { passed: false, detail: `runner threw: ${msg}` };
    }
    if (result.passed) {
      clearGateFailure(gate.name, base);
      passed.push(gate.name);
      continue;
    }
    const esc = applyEscalation(gate.name, base, limits, ctx);
    if (esc.escalated) escalated = true;
    if (esc.cleared) {
      // Per bash CLEAR_LIMIT semantics the gate is treated as passing this
      // iteration even though the counter keeps climbing. Surface it under
      // `passed` so the caller's prompt-injection logic does not double-warn.
      passed.push(gate.name);
    } else {
      failed.push(gate.name);
    }
    if (esc.pause) {
      // PAUSE signal already written; stop running further gates so the
      // operator inspects state from a deterministic point. Matches the
      // intent of bash's PAUSE_LIMIT branch which signals immediate human
      // intervention.
      break;
    }
  }

  persistFailureList(base, failed);
  return {
    passed,
    failed,
    blocked: failed.length > 0,
    escalated,
  };
}
