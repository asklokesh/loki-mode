// S41-10: the implement/fix brief's repo context. Replaces the first 200 repo paths with up to 20
// relevant files (plan relevant_files, else keyword selection over the tree-keyed cached map), their
// impacted tests with one exact command each (the repo card, e10ext/repomemory.ts, is added by the implement stage). Data only, no
// verdict logic (D42). plan.ts/verify.ts are stages, so core passes selectRelevantFiles and runnerCmd in.
import { isOff } from "../council/role_agents.ts";
import { readRepoMapCache, repoCacheDir, repoKey } from "../engine10/cache.ts";
import type { RepoMap } from "../engine10/repomap.ts";
/** PLAN-HINTS LOKI_E10_PLAN_HINTS (default on, =0 opts out): the plan's steps and files are a hint, never the scope. The task states the cases; the plan can miss one
 *  (dev2 tera: the plan covered a top-level -1 and left `[-1]` and `{a: -1}`, which the issue states). The brief says so where "Follow this plan" used to stand, including
 *  that any file the fix needs may be edited. Fire marker: implement records plan_hints: true when a plan was given. */
export const planHintsOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PLAN_HINTS"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
export const PLAN_HINT_LEAD = "A plan from an earlier session (a hint, not the scope: the task decides what to change; cover every case the task states even where the plan leaves it out, and edit any file the fix needs):";
import { loadRepoMap } from "../engine10/sizing.ts";
import { FINISH_LINE, ISSUE_FINISH_LINE, issueRunBrief, proveByRunningOn, taskWording, TEXT_FINISH_LINE, type RunContext, type TestMap, type TestRef } from "../engine10/types.ts";
import { unitBrief } from "../features/speed/unit_mode.ts";
import { signatureDigest } from "../util/ts_signatures.ts";
import { contextPack, packEnabled, type ContextPack } from "../util/context_pack.ts";
import { findDefectPins } from "../util/test_guard.ts";
import { releaseNoteBrief } from "../project_model/conventions.ts";
import { guideSentence } from "../project_model/guides.ts"; import { repoCardOn, SETUP_FIRST_LINE } from "./repomemory.ts"; import { profileBrief } from "../runner/repo_profile.ts"; import { exampleFiles } from "../util/pr_lessons.ts";

export interface ContextDeps {
  select: (task: string, map: RepoMap, max: number) => string[];
  cmd: (t: TestRef, repoDir: string) => [string, string[], unknown?, string?]; // 4th: package dir the command runs in (FC-01); absent or "." = repo root
}

// S41-10b: the implement/fix brief's leading block. A plain constant, no task text or interpolation, so
// every brief starts with the same bytes (cache-stable prefix). Per-task context is appended after it. E-150: repeated verbatim as the brief's last line (recency); same bytes every task.
export { FINISH_LINE, ISSUE_FINISH_LINE, issueRunBrief, proveByRunningOn, TEXT_FINISH_LINE }; // defined in engine10/types.ts, a leaf module, so conflict_resume and steer import it without a cycle through this file
// Z2 LOKI_E10_PINNED_TEST_UPDATE (default on, =0 opts out): an existing test that pins the OLD behavior the issue explicitly asks to change is updated, not declared a spec conflict.
// On the real-world bench this rule's older form ("an existing test that contradicts the task is a spec conflict") made Haiku skip a site the issue named (old tests pinned private
// state the fix had to change), and stopped two other runs BLOCKED; raw Haiku simply updated those tests. Each update is reported on an UPDATED TEST line that the implement stage
// checks against base, head and the task and seal lists in the receipt (pinned_test_updates). Every other protection stays.
export const PINNED_UPDATE_LINE = "UPDATED TEST";
const PINNED_RULE = "- Exception: when the task names an existing test file or asks to change tests, change only what it asks. An existing assertion that pins the OLD behavior the issue explicitly asks to change is not a spec conflict: change its expected value to the behavior the issue states, change nothing else in that test, and before the last line of your reply write one line per such change: `UPDATED TEST <path>:<line>: <old expectation> -> <new expectation>; issue: \"<the issue sentence that asks for the new behavior>\"`. Never delete a test, add skip, xfail or only, widen a tolerance, or touch a test unrelated to the behavior the issue names; any other existing test that contradicts the task is a spec conflict: cite it. Two more cases are not spec conflicts either. A test file this run itself added is yours: change it as the work needs. And when a test only pins the exact order or number of internal calls through a mock (not a result), and your change legitimately adds a call, extend that mock with the new call and keep every assertion about results; say in your reply which test and why.";
// UD LOKI_E10_DOC_UPDATE_RULE (default on, =0 opts out): the documentation rule asks the model to keep existing docs that enumerate what it changed in step, instead
// of "write no documentation". The failure: both Loki arms left a rule's README, which lists every option, without the option the change added, while every raw arm
// updated it. =0 restores DOC_RULE_V139 byte for byte; either text is a constant, so the rules prefix stays cache-stable.
export const DOC_RULE_V139 = "- Write no documentation unless the task explicitly asks for it, except the release-note fragment a repository convention listed below requires. Never write documentation, changelog or README text that announces a behavior the code does not have, even to make a test pass: if the task needs code that is not in this repository, finish with LOKI_SPEC_CONFLICT.";
export const DOC_RULE_UPDATE = "- Write no new documentation pages unless the task asks for them, except the release-note fragment a repository convention listed below requires. Do update existing docs that list what you changed: when you add or change an option, flag, method, rule or name that a README or doc page in the repository already lists, add or fix its entry there, written like the entries around it. Never write documentation, changelog or README text that announces a behavior the code does not have, even to make a test pass: if the task needs code that is not in this repository, finish with LOKI_SPEC_CONFLICT.";
const DOC_RULE = DOC_RULE_UPDATE;
/** STASH-GUARD: a session stopped between `git stash` and `git stash pop` left its whole finished change in the stash and the run delivered nothing (opencode 63310).
 *  The command guard refuses the command (autonomy/hooks/validate-bash.sh git_stash); this line says so up front, with the reason and what to use instead. A constant: the prefix stays cache-stable. */
export const STASH_RULE = "- Never run git stash, alone or inside a longer command: if this session is stopped between the stash and the pop, your whole change is left outside the work tree and nothing is delivered. To see the code without your change use git diff, git show HEAD:<file>, or a temporary copy of the file under $TMPDIR.";
export const FIXED_RULES = [
  "You are the Loki 10 implement stage, doing the complete task described below in this repository. Do whatever a senior engineer would do to finish it correctly: read, change and test as needed across any files the task requires.",
  "Rules:",
  "- The Wall tests are read-only: do not edit or delete them. Add the regression test where the repository's existing tests for that code live, following their conventions, and never delete, skip or loosen an existing assertion.",
  PINNED_RULE,
  "- Before editing a function, open the file and read the whole function, not only the snippet or suggested code quoted in the task (that text is a hint, not the spec). Make the branch you change match its sibling branches in that function: append, return or pass through the same variables they use (raw or normalized input), and add a test case that tells those two apart if the function normalizes input.",
  "- Implement the fix the issue prefers; add a fallback or workaround only on top of it, never in its place.",
  "- Run the impacted tests named below and any other targeted tests you need (the Project Model commands below say how), not the package's full suite and never npm test, nx test or another workspace-wide run: after you stop the harness re-runs your checks, and the full suite when the diff's risk tier is medium or high; a pass that exists only in your reply does not count. Run tests with the exact command the Project Model lists, never a shortened variant that changes how imports resolve; never create files or symlinks in a test directory to make an import work.",
  "- Do not edit test, build, lint or type-check config (vitest, jest, vite, tsconfig, eslint) or a lockfile unless the task asks for it. If a listed command cannot start because of that config, leave the config alone, say so in your reply, and continue without that check.",
  "- Never leave a long-lived server running.",
  "- Never kill processes.",
  DOC_RULE,
  "- Do not commit or push.",
  STASH_RULE,
  "- If you add a new third-party registry dependency, list it in .loki/supply-declared.json as a JSON array of {ecosystem,name,version_spec,registry}, leaving out workspace, path, git and local packages.",
  FINISH_LINE,
].join("\n");
/** FIXED_RULES with the v11.139.0 documentation rule (LOKI_E10_DOC_UPDATE_RULE=0). */
export const FIXED_RULES_DOC_V139 = FIXED_RULES.replace(DOC_RULE_UPDATE, DOC_RULE_V139);
export const docUpdateRuleOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_DOC_UPDATE_RULE"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
/** The old rules text (LOKI_E10_PINNED_TEST_UPDATE=0): byte-identical to v11.139.0. */
export const LEGACY_FIXED_RULES = [
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
/** F5 PROVE-BY-RUNNING and candidate 1 (LOKI_E10_PROVE_BY_RUNNING, default on; 0/off/false/no restores today's issue-run brief): an issue run (intake source
 *  "issue") on the claude provider gets its own rules constant (ISSUE_RULE_LINE in place of "Never leave a long-lived server running." and "Never kill processes.",
 *  ISSUE_FINISH_LINE in place of FINISH_LINE), the prove-by-running block, the take-the-time and deliver-each lines, the small environment card line, and no
 *  time-budget sentence (engine10/machine.ts). A text goal, opencode and every other stage keep today's constants and briefs byte for byte. FireLater#24: 27 Loki
 *  implement sessions never started the product; plain sessions did, unprompted, and scored 8 and 9; the rehearsal with permission inside the block and the
 *  broad "never" in the rules ran nothing. */
export const ISSUE_RULE_LINE = "- You may start this repository's own services and throwaway dependencies to exercise your change. Bind anything you start to 127.0.0.1 or a unix socket, never to all interfaces. Create data directories, sockets and scratch files under $TMPDIR. Leave what you started running; Loki stops it after the session. Never stop or signal a process you did not start. Use only a database, cache or server you started yourself under $TMPDIR; never connect to one named in the repository's env files or in your environment, and never apply migrations to it.";
const SERVER_RULES = "- Never leave a long-lived server running.\n- Never kill processes.";
/** An issue run's rules: the given rules constant with the two process rules and the finish rule replaced, everything else word for word. */
export function issueRules(rules: string, text = false): string {
  if (!rules.includes(SERVER_RULES) || !rules.endsWith(FINISH_LINE)) return rules; // a rules text without these lines is left as it is
  return rules.replace(SERVER_RULES, ISSUE_RULE_LINE).slice(0, -FINISH_LINE.length) + (text ? TEXT_FINISH_LINE : ISSUE_FINISH_LINE); // text: a text task on the work road (types.ts taskWording)
}
export const PROVE_BY_RUNNING_BLOCK = "Before you finish, prove the change works by running it, not by reading it. Exercise each thing the task asks for the way its user or caller reaches it: start the service or program this repository provides (if it needs a database or another dependency, start a throwaway one in a temporary directory), and call every new or changed entry point exactly as its real caller does; for a web or API client, use the exact paths the client code sends. Never use a fixed port number: pick a port you have just checked is free, or a unix socket inside your temporary directory, and call only the processes you started; before the first call, confirm the process answering on that port is the one whose process id you recorded. Prove a fresh install, not only an existing one: start from an empty database or data directory, set it up with the repository's own migrations or setup command, and create the first account, tenant or other record through the product's own code path after your change. Fix whatever fails and run it again. You may say something cannot be run only after you have tried: list each command you tried to find or start it and what it printed. A missing program on PATH is not enough; look where this machine installs it. Before the finish line, list each requested item with the command you ran to prove it and what it returned, then one line starting `Fresh install:` with the commands that built the empty environment and created the first record, and what they returned. Loki checks the label against this list, so an item with no command and result counts as not proved.";
/** The script the session leaves so Loki can re-run the proof itself (engine10/proof_rerun.ts): the label comes from that run, not from the reply. */
export const PROOF_SCRIPT_LINE = "Put your proof in one script at exactly $LOKI_SCRATCH/loki-proof.sh (the same directory as $TMPDIR; never inside the repository, so it is not part of the change, and never delete it: Loki copies it from there when you finish) and run it yourself until it passes. The acceptance lines the label is checked against are numbered in $LOKI_SCRATCH/acceptance.txt: read it first. The script takes one argument, an empty directory, and must do everything inside it from nothing: create the database or data directory there, apply the repository's own migrations or setup, start what it needs on ports it has just checked are free (bound to 127.0.0.1), and create the first account, tenant or record through the product's own code. Then it proves each numbered item with the functions in $LOKI_SCRATCH/loki-check.sh (the first argument is the item's number in acceptance.txt, 1, 2, 3 and so on, never a line number of your script), which it must source by that exact path (when Loki runs your script the variable points at Loki's own copy): `loki_http <item number> \"<what is proved>\" <expected status> <curl arguments>` for a request, sent the way the real caller sends it (for a page, every path its client code calls, same method and parameters; set LOKI_BODY_MATCH to a pattern the response must contain), and `loki_cmd <item number> \"<what is proved>\" <command>` for anything else (a test run, a query plan, a file that must exist). Only lines these functions print count: a line with no passing check is not met, and one failing check makes it not met, so give every line, including the fresh-install line if listed, at least one real check. It must stop what it started and exit 0 only when every required line is proved. Use paths relative to the repository root for the repository's own files. Loki runs this same script again by itself after you finish, in a new empty directory, and the label is a count of the checks that pass in that run, not of what you write about it. The same file gives you throwaway services: loki_pg_start <dir> and loki_redis_start <dir> start a new empty PostgreSQL or Redis on a free port and export its connection settings, loki_free_port prints a free port, loki_services_stop stops them. Use these for the proof and for your own runs; never use, and never expect, a database or cache that is already running on this machine.";
export const TAKE_THE_TIME_LINE = "This is an issue to deliver in full, not a quick fix: take the time the work needs and finish every item the issue asks for. Starting this repository's own services and their dependencies to prove the change is expected here, not discouraged. Your reply ends this session and nothing runs after it: never end your turn while a subagent or a command is still working, and never say you will wait for a notification: none arrives. Run long commands in the foreground (up to ten minutes each), read the result, and only then reply.";
export const DELIVER_EACH_LINE = "This issue lists several things to deliver. Deliver each one. If a required one is left undone, finish with LOKI_UNFINISHED and say which. An item the issue marks optional may be skipped: say so and finish with LOKI_DONE.";
/** The per-task issue-run lines (block, take the time, deliver each, and the environment card line when one was made), or "" outside an issue run on claude. */
export const proveByRunningBlock = (provider: string, source: unknown, env: NodeJS.ProcessEnv = process.env, cardLine: string | null = null): string =>
  issueRunBrief(provider, source, env) ? [PROVE_BY_RUNNING_BLOCK, PROOF_SCRIPT_LINE, ...(repoCardOn(env) ? [SETUP_FIRST_LINE] : []), ...[TAKE_THE_TIME_LINE, DELIVER_EACH_LINE].map((l) => (source === "text" ? taskWording(l) : l)), ...(cardLine ? [cardLine] : [])].join("\n\n") : "";
export const pinnedTestUpdateEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PINNED_TEST_UPDATE"] ?? "").trim());
/** The rules block the implement and fix briefs lead with: FIXED_RULES by default, the v11.139.0 text with the knob off. Either way a constant, so the prefix stays cache-stable. */
export const fixedRules = (env: NodeJS.ProcessEnv = process.env, issue: boolean | "text" = false): string => { const r = pinnedTestUpdateEnabled(env) ? (docUpdateRuleOn(env) ? FIXED_RULES : FIXED_RULES_DOC_V139) : LEGACY_FIXED_RULES; return issue ? issueRules(r, issue === "text") : r; }; // issue: the caller's issueRunBrief(provider, source); each result is a constant, so the prefix stays cache-stable per route

/** REPO-GUIDES (LOKI_E10_REPO_GUIDES, default on): the lead of the one per-repository block the implement and fix briefs carry when the repository's own guides
 *  name a test command, a setup command or a prohibition (project_model/guides.ts guideSentence, read at intake). The sentence after it differs per repository,
 *  so the block sits in the per-task context below, after the cache-stable rules prefix, never inside it. */
export const REPO_GUIDE_LEAD = "This repository's own instructions:";
export const repoGuideBlock = (repoDir: string): string => { try { const s = guideSentence(repoDir, repoDir); return s ? `${REPO_GUIDE_LEAD} ${s}` : ""; } catch { return ""; } };

const MAX_FILES = 20;
const MAX_TESTS = 10;

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
  // L020: no plan and no ranked file leaves the Relevant files block out (the head of `git ls-files` named files the task never touches)
  const pack = model !== undefined && packEnabled(model) && files.length ? contextPack(ctx.repoDir, task, files, map?.entries ?? []) : null; // L021: haiku and sonnet only; Opus keeps today's bytes
  const whole = new Set((pack?.spans ?? []).filter((s) => s.symbol === null).map((s) => s.path)); // a file the pack shows whole needs no signatures
  const sigs = process.env["LOKI_E10_SIGS"] === "0" || !files.length ? "" : signatureDigest(ctx.repoDir, files.filter((f) => !whole.has(f)).slice(0, 5));
  // E4: existing assertions whose expected value is the wrong value the issue reports. On by default; LOKI_E10_DEFECT_PIN=0 opts out.
  const pins = !isOff(process.env["LOKI_E10_DEFECT_PIN"]) ? findDefectPins(ctx.repoDir, task).slice(0, 5) : [];
  const guide = repoGuideBlock(ctx.repoDir), guideNamesCommand = guide.includes("run tests with"); // REPO-GUIDES: the repository's own command stands in for a detected interpreter, which could be the form the guide forbids
  const text = [
    files.length ? `Relevant files:\n${files.join("\n")}` : "", // kept byte-identical (the L021 Opus golden and the exemplar lookup read it); PLAN-HINTS says "edit any file the fix needs" in the plan lead
    sigs ? `Key signatures (read the files for bodies):\n${sigs}` : "",
    pack ? pack.text : "",
    interps.length && !guideNamesCommand ? `Detected test interpreter (no test file to run yet; use exactly this executable, never a guessed one): ${interps.join(", ")}` : "",
    pins.length ? `Existing assertions that pin the behavior the task reports as wrong (the correct fix is expected to change these expected values; change only these, and make sure each new expected value fails on the unfixed code):\n${pins.map((p) => `${p.file}:${p.line}: ${p.text.slice(0, 140)}`).join("\n")}` : "",
    cmds.length ? `Impacted test commands:\n${cmds.join("\n")}` : "",
    guide, // REPO-GUIDES: per repository, after the cache prefix; "" when the guides say nothing usable
    releaseNoteBrief(ctx.repoDir, files), // L3: one per-run line after the cache prefix; "" when the repo has no fragment convention
    profileBrief(ctx.repoDir), // REPOMEM: validated repo commands + baseline-red tests; byte-stable for an unchanged profile
  ].filter(Boolean).join("\n\n");
  if (!pack) return { text, files, pack: null };
  const { text: _packText, ...record } = pack;
  return { text, files: [...new Set([...files, ...pack.files])], pack: record, packText: pack.text };
}
