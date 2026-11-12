// S41-10: the implement/fix brief's repo context. Replaces the first 200 repo paths with up to 20
// relevant files (plan relevant_files, else keyword selection over the tree-keyed cached map), their
// impacted tests with one exact command each, and E-126 repo memory's verified command. Data only, no
// verdict logic (D42). plan.ts/verify.ts are stages, so core passes selectRelevantFiles and runnerCmd in.
import { isOff } from "../council/role_agents.ts";
import { readRepoMapCache, repoCacheDir, repoKey } from "../engine10/cache.ts";
import type { RepoMap } from "../engine10/repomap.ts";
import { loadRepoMap } from "../engine10/sizing.ts";
import { FINISH_LINE, type RunContext, type TestMap, type TestRef } from "../engine10/types.ts";
import { unitBrief } from "../features/speed/unit_mode.ts";
import { signatureDigest } from "../util/ts_signatures.ts";
import { contextPack, packEnabled, type ContextPack } from "../util/context_pack.ts";
import { findDefectPins } from "../util/test_guard.ts";
import { releaseNoteBrief } from "../project_model/conventions.ts";
import { leanCallsEnabled } from "../util/cost_profile.ts";
import { readVerifiedCommand } from "./repomemory.ts"; import { profileBrief } from "../runner/repo_profile.ts"; import { exampleFiles } from "../util/pr_lessons.ts";

export interface ContextDeps {
  select: (task: string, map: RepoMap, max: number) => string[];
  cmd: (t: TestRef, repoDir: string) => [string, string[], unknown?, string?]; // 4th: package dir the command runs in (FC-01); absent or "." = repo root
}

// S41-10b: the implement/fix brief's leading block. A plain constant, no task text or interpolation, so
// every brief starts with the same bytes (cache-stable prefix). Per-task context is appended after it. E-150: repeated verbatim as the brief's last line (recency); same bytes every task.
export { FINISH_LINE }; // defined in engine10/types.ts, a leaf module, so conflict_resume and steer import it without a cycle through this file
export const FIXED_RULES = [
  "You are the Loki 10 implement stage, doing the complete task described below in this repository. Do whatever a senior engineer would do to finish it correctly: read, change and test as needed across any files the task requires.",
  "Rules:",
  "- The Wall tests are read-only: do not edit or delete them. Add the regression test where the repository's existing tests for that code live, following their conventions, and never delete, skip or loosen an existing assertion.",
  "- Exception: when the task names an existing test file or asks to change tests, change only what it asks; never remove, skip or loosen any other assertion. An existing test that contradicts the task otherwise is a spec conflict: cite it.",
  "- Before editing a function, open the file and read the whole function, not only the snippet or suggested code quoted in the task (that text is a hint, not the spec). Make the branch you change match its sibling branches in that function: append, return or pass through the same variables they use (raw or normalized input), and add a test case that tells those two apart if the function normalizes input.",
  "- Implement the fix the issue prefers; add a fallback or workaround only on top of it, never in its place.",
  "- Run the impacted tests named below and any other targeted tests you need (the Project Model commands below say how), not the package's full suite and never npm test, nx test or another workspace-wide run: after you stop the harness re-runs your checks, and the full suite when the diff's risk tier is medium or high; a pass that exists only in your reply does not count. Run tests with the exact command the Project Model lists, never a shortened variant that changes how imports resolve; never create files or symlinks in a test directory to make an import work.",
  "- Do not edit test, build, lint or type-check config (vitest, jest, vite, tsconfig, eslint) or a lockfile unless the task asks for it. If a listed command cannot start because of that config, leave the config alone, say so in your reply, and continue without that check.",
  "- Never leave a long-lived server running.",
  "- Never kill processes.",
  "- Write no documentation unless the task explicitly asks for it, except the release-note fragment a repository convention listed below requires. Never write documentation, changelog or README text that announces a behavior the code does not have, even to make a test pass: if the task needs code that is not in this repository, finish with LOKI_SPEC_CONFLICT.",
  "- Do not commit or push.",
  "- If you add a new third-party registry dependency, list it in .loki/supply-declared.json as a JSON array of {ecosystem,name,version_spec,registry}, leaving out workspace, path, git and local packages.",
  FINISH_LINE,
].join("\n");

const MAX_FILES = 20;
const MAX_TESTS = 10;
// Brief diet (lever B), both on by default under LOKI_E10_LEAN_CALLS (util/cost_profile.ts). On the 20-task Haiku bench (L-Haiku-lean139) implement briefs averaged 24,484 chars;
// Go briefs carried 4,186 chars of impacted `-run '^(A|B|...)$'` commands per run (up to 17,145) and the Key signatures block 3,707 chars per run beside a context pack.
// LOKI_E10_CMD_DIET (=0 opts out): at most CMD_LINES impacted test commands of at most CMD_CHARS each. A longer command is never printed cut (the rules say run the exact
// command): its test file is named instead. The harness reruns every impacted test after the session stops.
// LOKI_E10_SIGS: =0 never prints Key signatures, =1 always does; unset drops them when a context pack is present.
const CMD_LINES = 3, CMD_CHARS = 200;
const dietDefault = (v: string | undefined, env: NodeJS.ProcessEnv): boolean => (v === undefined || v.trim() === "" ? leanCallsEnabled(env) : !isOff(v));
export const cmdDietEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => dietDefault(env["LOKI_E10_CMD_DIET"], env);
export const sigsShown = (packPresent: boolean, env: NodeJS.ProcessEnv = process.env): boolean => { const v = (env["LOKI_E10_SIGS"] ?? "").trim(); return v === "0" ? false : v !== "" ? true : !(packPresent && leanCallsEnabled(env)); };
/** The impacted-test block: every command (diet off), or at most CMD_LINES commands of at most CMD_CHARS each plus the files of the rest, named, never cut. */
export function impactedCmdBlock(cmds: { cmd: string; file: string }[], diet: boolean = cmdDietEnabled()): string {
  if (!cmds.length) return "";
  if (!diet) return `Impacted test commands:\n${cmds.map((c) => c.cmd).join("\n")}`;
  const shown = cmds.filter((c) => c.cmd.length <= CMD_CHARS).slice(0, CMD_LINES), rest = cmds.filter((c) => !shown.includes(c)).map((c) => c.file);
  return [shown.length ? `Impacted test commands:\n${shown.map((c) => c.cmd).join("\n")}` : "", rest.length ? `Other impacted test files (run each with its runner's Project Model command; the harness reruns them after you stop): ${[...new Set(rest)].join(", ")}` : ""].filter(Boolean).join("\n");
}

const shq = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);

const detectedInterpreters = (tm: TestMap | undefined, repoDir: string, d: ContextDeps): string[] => [...new Set((tm?.runners ?? []).flatMap((runner) => { try { const c = d.cmd({ runner, path: "" } as TestRef, repoDir)[0]; return c ? [`${shq(c.startsWith(`${repoDir}/`) ? c.slice(repoDir.length + 1) : c)} (${runner})`] : []; } catch { return []; } }))]; // RUN5-C1i: executable per detected runner via the test-run resolver; none detected, none invented
export function briefContext(ctx: RunContext, d: ContextDeps): string { return briefRecord(ctx, d).text; }
/** L021/L022: the brief context, the exact file list it names (brief_files) and, for a haiku or sonnet executor, the context pack it carries. No model (fix stage) or an Opus model: the text is byte-identical to briefContext before L021. */
export interface BriefRecord { text: string; files: string[]; pack: Omit<ContextPack, "text"> | null; packText?: string /* the pack block alone (the patch protocol's dossier) */ }
export function briefRecord(ctx: RunContext, d: ContextDeps, model?: string): BriefRecord {
  const unit = unitBrief(); // D61-11: a unit brief is its pack files only
  if (unit !== null) return { text: unit, files: unit ? unit.split("\n").slice(1) : [], pack: null };
  const o = ctx.outputs();
  const tree = o.intake?.tree as string | undefined;
  const task = (o.intake?.task as string | undefined) ?? "";
  const map = (tree ? readRepoMapCache(repoCacheDir(repoKey(null, ctx.repoDir)), tree) : null) ?? loadRepoMap(o.intake?.repomap_ref as string | undefined);
  const planned = o.plan?.relevant_files as string[] | undefined;
  const safe = (planned ?? []).filter((f) => !/^([/~]|[A-Za-z]:[\\/])/.test(f) && !f.split(/[\\/]/).includes(".."));
  let files = safe.length ? safe : map ? d.select(task, map, MAX_FILES) : [];
  files = [...new Set([...exampleFiles(ctx.repoDir, task), ...files])].slice(0, MAX_FILES); // L043: the worked example's files lead (util/pr_lessons.ts workedExampleFor)
  const tm = o.intake?.testmap as TestMap | undefined;
  const refs = tm && files.length ? ctx.tests.impacted(tm, files).slice(0, MAX_TESTS) : [];
  const rel = (p: string): string => (p.startsWith(`${ctx.repoDir}/`) ? p.slice(ctx.repoDir.length + 1) : p);
  const cmds = refs.map((t) => { const [c, a, , dir] = d.cmd(t, ctx.repoDir); return `${dir && dir !== "." ? `cd ${shq(dir)} && ` : ""}${[rel(c), ...a].map(shq).join(" ")}`; });
  const interps = cmds.length ? [] : detectedInterpreters(tm, ctx.repoDir, d); // no impacted test: still name the interpreter intake detected
  const verified = readVerifiedCommand(repoCacheDir(repoKey(null, ctx.repoDir)));
  // L020: no plan and no ranked file leaves the Relevant files block out (the head of `git ls-files` named files the task never touches)
  const pack = model !== undefined && packEnabled(model) && files.length ? contextPack(ctx.repoDir, task, files, map?.entries ?? []) : null; // L021: haiku and sonnet only; Opus keeps today's bytes
  const whole = new Set((pack?.spans ?? []).filter((s) => s.symbol === null).map((s) => s.path)); // a file the pack shows whole needs no signatures
  const sigs = !sigsShown(pack !== null) || !files.length ? "" : signatureDigest(ctx.repoDir, files.filter((f) => !whole.has(f)).slice(0, 5));
  // E4: existing assertions whose expected value is the wrong value the issue reports. On by default; LOKI_E10_DEFECT_PIN=0 opts out.
  const pins = !isOff(process.env["LOKI_E10_DEFECT_PIN"]) ? findDefectPins(ctx.repoDir, task).slice(0, 5) : [];
  const text = [
    files.length ? `Relevant files:\n${files.join("\n")}` : "",
    sigs ? `Key signatures (read the files for bodies):\n${sigs}` : "",
    pack ? pack.text : "",
    interps.length ? `Detected test interpreter (no test file to run yet; use exactly this executable, never a guessed one): ${interps.join(", ")}` : "",
    pins.length ? `Existing assertions that pin the behavior the task reports as wrong (the correct fix is expected to change these expected values; change only these, and make sure each new expected value fails on the unfixed code):\n${pins.map((p) => `${p.file}:${p.line}: ${p.text.slice(0, 140)}`).join("\n")}` : "",
    impactedCmdBlock(cmds.map((cmd, i) => ({ cmd, file: rel(refs[i]!.path) }))), // LOKI_E10_CMD_DIET
    verified ? `Last verified test command: ${verified}` : "",
    releaseNoteBrief(ctx.repoDir, files), // L3: one per-run line after the cache prefix; "" when the repo has no fragment convention
    profileBrief(ctx.repoDir), // REPOMEM: validated repo commands + baseline-red tests; byte-stable for an unchanged profile
  ].filter(Boolean).join("\n\n");
  if (!pack) return { text, files, pack: null };
  const { text: _packText, ...record } = pack;
  return { text, files: [...new Set([...files, ...pack.files])], pack: record, packText: pack.text };
}
