// D61-16: LOKI_SPEED group entry. Called from engine10/supervisor.ts main() for free-text tasks and spec files only (never issue refs).
//
// Spec files: a task is read as a file ONLY when it is explicitly a path (contains "/" or ends in
// .md .txt .yaml .yml .json, no whitespace). A relative path resolves against process.cwd(). The real path
// must stay inside the repo (symlink escapes are rejected); content over 1 MB or containing NUL is rejected.
// "loki: reading spec from <path>" is printed on stderr. A bare word like TODO or -x is always literal.
//
// Fallback meaning (one rule): maybeRunGroup returns { code, task }. code is the group exit code, or null
// when the caller must run the single sequential path. On fallback, task is exactly what the group path
// would have decomposed: the spec file CONTENTS if a spec file was read, else the original literal task.
// A rejected spec (escape, cap, NUL) hands the literal path string to the sequential agent, which then sees only the path.
// Contents go to the sequential run only when <= 64 KB (MAX_SEQ_TASK_BYTES): the task travels in an env var and
// Linux caps one env string at 131072 bytes (E2BIG), so a larger spec falls back to the literal path. After deps.group() has started there
// is never a fallback: a throw returns code 1 with a message.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { decompose, parseItems, parseMilestones, type Dag } from "../decompose.ts";
import { buildRepoMap, type RepoMap } from "../../engine10/repomap.ts";
import { selectRelevantFiles } from "../../engine10/relevant_files.ts";
import type { BacklogLauncher, SealDeps } from "./run_group.ts";

export const MAX_SPEC_BYTES = 1_048_576;
export const MAX_SEQ_TASK_BYTES = 65_536;
const SPEC_PATH_RE = /\/|\.(md|txt|ya?ml|json)$/i;

export interface GroupCtx { task: string; repoDir: string; env: NodeJS.ProcessEnv; provider: string; spec: string; specPath: string | null; seal?: SealDeps; say?: (s: string) => void }
/** Group execution (D61-10..13: unit runner, unit mode, integrator, seal group). Returns an exit code. */
export type GroupRunner = (dag: Dag, ctx: GroupCtx) => Promise<number>;

/** Parallel unit slots per provider (providers/*.sh PROVIDER_MAX_PARALLEL). Unknown providers are sequential: never guess parallel. */
const PROVIDER_SLOTS: Record<string, number> = { claude: 10, codex: 2, cline: 1, aider: 1, opencode: 1 };
export function providerSlots(env: NodeJS.ProcessEnv, provider?: string): { provider: string; slots: number } {
  provider = (provider || env.LOKI_PROVIDER || "claude").toLowerCase();
  return { provider, slots: PROVIDER_SLOTS[provider] ?? 1 };
}

export interface RouteDeps {
  group?: GroupRunner;
  /** Test seam for the default group runner: replaces the backlog.py launcher. */
  backlog?: BacklogLauncher;
  /** Seal and verify implementations for the default group runner; supplied by the caller outside features/. Missing means NOT PROVEN. */
  seal?: SealDeps;
  listFiles?: (repoDir: string) => string[];
  select?: (task: string, map: RepoMap, max: number) => string[];
  stderr?: (s: string) => void;
  cwd?: string;
  /** The provider the run resolved (--provider wins over LOKI_PROVIDER); sets the slot cap and is forwarded to every unit. */
  provider?: string;
}
export interface RouteResult { code: number | null; task: string }

type SpecRead = { kind: "text" } | { kind: "file"; path: string; text: string } | { kind: "reject"; reason: string } | { kind: "missing"; path: string };

function readSpec(task: string, repoDir: string, cwd: string): SpecRead {
  if (/\s/.test(task) || !SPEC_PATH_RE.test(task)) return { kind: "text" };
  const p = isAbsolute(task) ? task : resolve(cwd, task);
  let real: string;
  try {
    real = realpathSync(p); // resolves symlinks, so containment below is on the true target
  } catch { return { kind: "missing", path: p }; }
  const rel = relative(realpathSync(repoDir), real);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return { kind: "reject", reason: `spec path escapes the repo: ${task}` };
  let fd = -1;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); // symlink swap fails here; O_NONBLOCK keeps a FIFO from blocking open, fstat then rejects it
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "text" };
    if (st.size > MAX_SPEC_BYTES) return { kind: "reject", reason: `spec file over ${MAX_SPEC_BYTES} bytes` };
    const buf = readFileSync(fd);
    if (buf.length > MAX_SPEC_BYTES) return { kind: "reject", reason: `spec file over ${MAX_SPEC_BYTES} bytes` };
    if (buf.includes(0)) return { kind: "reject", reason: "spec file contains NUL bytes" };
    return { kind: "file", path: real, text: buf.toString("utf8") };
  } catch (e) { return { kind: "reject", reason: `spec file unreadable: ${(e as Error).message.split("\n")[0]}` }; }
  finally { if (fd >= 0) closeSync(fd); }
}

export async function maybeRunGroup(task: string, repoDir: string, env: NodeJS.ProcessEnv, deps: RouteDeps = {}): Promise<RouteResult> {
  if (env.LOKI_SPEED === "0") return { code: null, task };
  if (env.LOKI_UNIT_ID) return { code: null, task }; // a unit child never re-decomposes into a nested group
  const say = deps.stderr ?? ((s: string): void => { process.stderr.write(s); });
  const seq = (t: string): string => {
    if (Buffer.byteLength(t) <= MAX_SEQ_TASK_BYTES) return t;
    if (t !== task) say("loki: spec over 64 KB, passing the path\n");
    return task;
  };
  const fb = (t: string, reason: string): RouteResult => { say(`loki: sequential (reason: ${reason})\n`); return { code: null, task: seq(t) }; };
  // The real group runner launches units through backlog.py, which needs an owner/repo origin. An injected runner (tests) has no such need.
  const NO_ORIGIN = "no origin remote of the form owner/repo on github.com, which group units need; running the task as one local run";
  const groupFailed = async (e: unknown): Promise<number> => { // a throw out of the group runner is FAILED; it still leaves a verifiable refusal receipt when a sealer was supplied
    const why = `loki: group run failed: ${(e as Error).message.split("\n")[0]}`;
    say(`${why}\n`);
    const sealed = await deps.seal?.refuse?.({ repoDir, task, reason: why, provider: deps.provider }).catch(() => null);
    if (sealed) say(`loki: refusal receipt ${sealed.receiptPath}; run: loki verify ${sealed.runId}\n`);
    return 1;
  };
  const lacksOrigin = async (): Promise<boolean> => deps.group === undefined && (await import("./run_group.ts")).originSlug(repoDir) === undefined;
  let spec = task, specPath: string | null = null, dag: Dag | undefined;
  let missions: ReturnType<typeof parseMilestones> = [];
  let mdags: Dag[] = [];
  try {
    const r = readSpec(task, repoDir, deps.cwd ?? process.cwd());
    if (r.kind === "reject") return fb(task, r.reason);
    if (r.kind === "missing") say(`loki: spec path not readable (${r.path}); treating the argument as a literal task\n`);
    if (r.kind === "file") { spec = r.text; specPath = r.path; say(`loki: reading spec from ${r.path}\n`); }
    missions = parseMilestones(spec);
    if (!missions.length && parseItems(spec).length < 2) return { code: null, task: seq(spec) }; // a small task never decomposes
    const files = deps.listFiles ? deps.listFiles(repoDir) : buildRepoMap(repoDir).files;
    const map: RepoMap = { files, entries: files.map((f) => ({ path: f, symbols: [] })), truncated: false };
    const select = deps.select ?? selectRelevantFiles;
    if (missions.length) mdags = missions.map((m) => decompose(m.body, map, { select }));
    else dag = decompose(spec, map, { select });
  } catch (e) {
    return fb(spec, `group setup failed: ${(e as Error).message.split("\n")[0]}`);
  }
  if (missions.length) {
    // Mission: milestone by milestone, in order. 1-unit groups and sequential providers are allowed here.
    const cap = providerSlots(env, deps.provider);
    if (await lacksOrigin()) return fb(spec, NO_ORIGIN);
    try {
      const group = deps.group ?? (await import("./run_group.ts")).runGroup.bind(null, deps.backlog);
      for (let i = 0; i < missions.length; i++) {
        const m = missions[i]!, k = i + 1, N = missions.length;
        say(`loki: milestone ${k}/${N}: ${m.title || `Milestone ${m.n}`}\n`);
        const code = await group(mdags[i]!, { task, repoDir, env, provider: cap.provider, spec: m.body, specPath, seal: deps.seal, say });
        if (code !== 0) {
          say(`loki: milestone ${k}/${N} failed (exit ${code}); rerun the same loki start to resume\n`);
          return { code, task: spec };
        }
      }
      return { code: 0, task: spec };
    } catch (e) {
      return { code: await groupFailed(e), task: spec };
    }
  }
  if (!dag || dag.units.length < 2) return fb(spec, `decomposer returned ${dag?.units.length ?? 0} unit`);
  const cap = providerSlots(env, deps.provider);
  if (cap.slots < 2) return fb(spec, `provider ${cap.provider} runs units sequentially`);
  if (await lacksOrigin()) return fb(spec, NO_ORIGIN);
  try {
    const group = deps.group ?? (await import("./run_group.ts")).runGroup.bind(null, deps.backlog);
    return { code: await group(dag, { task, repoDir, env, provider: cap.provider, spec, specPath, seal: deps.seal, say }), task: spec };
  } catch (e) {
    return { code: await groupFailed(e), task: spec };
  }
}
