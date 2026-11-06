// E1 config and lockfile write fence (on by default; LOKI_CONFIG_FENCE=0 opts out). Implement and fix sessions may not change test, build, lint or type config or a lockfile unless the task names it.
// Two layers: a tool-time deny on Edit/Write/MultiEdit (runner/host_guard.ts, runner/providers.ts) and, because Bash and other tools can write too,
// a snapshot before each session and a restore after it of every fenced file the session changed (no regex over Bash commands). Path predicate: util/config_paths.ts.
// Nothing here may fail a session: every filesystem step is caught and reported on the receipt instead.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LOCKFILE, MANIFEST, manifestChanged } from "../e10ext/commit_filter.ts";
import { isFencedPath, taskNamesFenced, TEST_DIR } from "./config_paths.ts";
import { safeGit } from "./safe_git.ts";

const MAX_BYTES = 32 * 1024 * 1024, LIST_BUFFER = 256 * 1024 * 1024, LIST_TIMEOUT_MS = 60_000; // the ls-files output of a 100k-file repo is megabytes: the default 1 MiB buffer would throw
export const FENCE_TASK_MAX = 8000; // one length at tool time and at restore time
export const FENCE_STAGES: ReadonlySet<string> = new Set(["implement", "fix"]);
/** Default ON; LOKI_CONFIG_FENCE=0 opts out. A task that names a setting concept (strict, coverage threshold, setup file, lint rule, a dependency to add) is allowed the matching config edit (util/config_paths.ts). */
export const fenceEnabled = (stage: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean => !!stage && FENCE_STAGES.has(stage) && env["LOKI_CONFIG_FENCE"] !== "0";
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160);

/** The task text the engine already carries (the env var, else the run's issue json), cut once to FENCE_TASK_MAX. Empty when unknown: the fence then holds. */
export function fenceTask(env: NodeJS.ProcessEnv = process.env, runDir?: string): string {
  if (env["LOKI_E10_TASK_TEXT"]) return env["LOKI_E10_TASK_TEXT"].slice(0, FENCE_TASK_MAX);
  for (const p of [env["LOKI_E10_ISSUE_JSON"], runDir ? join(runDir, "issue.json") : undefined]) {
    if (!p || !existsSync(p)) continue;
    try { const i = JSON.parse(readFileSync(p, "utf8")) as { title?: string; body?: string }; const t = [i.title, i.body].filter((s) => typeof s === "string" && s).join("\n\n"); if (t) return t.slice(0, FENCE_TASK_MAX); } catch { /* unreadable: next */ }
  }
  return "";
}

export type FenceAllow = (rel: string) => boolean;
/** A fenced path is editable when the task names it or a spec conflict allowlisted it for this session. */
export const allowFor = (task: string, allowed: Iterable<string> = []): FenceAllow => { const a = new Set(allowed); return (rel) => a.has(rel) || taskNamesFenced(task, rel); };

// HARNESS-OUTPUTS: a stage brief can name a file under .loki/ for the session to write (plan-output.txt, plan-scope.json, project-model.answer.json,
// spec-criteria.json). session.ts passes those exact absolute paths in this env var; the .loki/ deny lets each one through and nothing else.
// A run record name is never let through, even if a caller lists it: the receipt, the event log, run and fence state are the harness's alone.
export const HARNESS_OUTPUTS_ENV = "LOKI_E10_WRITE_OUTPUTS";
export const RUN_RECORD = /(^|\/)(receipt[^/]*|events\.jsonl|[^/]*state\.json|config_fence\.jsonl|[^/]*ledger[^/]*|checkpoints?|state)(\/|$)/;
/** The harness-directed output files for this session: absolute, under `cwd`/.loki/, never a run record. Anything malformed is dropped (the deny then holds). */
export function harnessOutputs(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let a: unknown; try { a = JSON.parse(env[HARNESS_OUTPUTS_ENV] ?? "[]"); } catch { return []; }
  if (!Array.isArray(a)) return [];
  const root = resolve(cwd, ".loki");
  return [...new Set(a.filter((p): p is string => typeof p === "string" && isAbsolute(p)).map((p) => resolve(p)).filter((p) => { const r = relative(root, p); return r !== "" && !r.startsWith("..") && !isAbsolute(r) && !RUN_RECORD.test(r); }))];
}

/** Deny reason for a write tool aimed at a fenced path (or, with `state`, anything under .loki/, the harness's run state, except the exact `outputs` the stage brief names), else null. `file` is the tool's file_path; a path outside `cwd` is not this fence's concern. */
export function fenceDenied(tool: string, file: unknown, cwd: string, allow: FenceAllow, state = false, onNewTestFile?: (rel: string) => void, outputs: readonly string[] = []): { rel: string; reason: string } | null {
  if (!/^(Edit|Write|MultiEdit)$/.test(tool) || typeof file !== "string" || !file) return null;
  const abs = resolve(cwd, file), rel = relative(resolve(cwd), abs);
  if (state && /^\.loki(\/|$)/.test(rel) && outputs.includes(abs)) return null; // the stage's own brief asked for exactly this file
  if (state && /^\.loki(\/|$)/.test(rel)) return { rel, reason: `LOKI_RUN_STATE: ${rel} is the harness's own run state (the receipt and checkpoints are built from it), so the edit was denied. Nothing in the task needs it.` };
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !isFencedPath(rel) || allow(rel)) return null;
  if (TEST_DIR.test(rel) && !existsSync(resolve(cwd, rel))) { onNewTestFile?.(rel); return null; } // a new config-named file under a test directory is scaffolding
  return { rel, reason: `LOKI_CONFIG_FENCE: ${rel} is test, build, lint, type config or a lockfile and the task does not ask for it, so the edit was denied. Leave it alone, say so in your reply, and continue without that check. If the task cannot be done without it, finish with LOKI_SPEC_CONFLICT naming ${rel}.` };
}

/** Every tracked and untracked (not ignored) path; throws when git fails or the listing cannot be read whole. */
const scan = (cwd: string): string[] => safeGit(cwd, ["ls-files", "-z", "-c", "-o", "--exclude-standard"], { maxBuffer: LIST_BUFFER, timeout: LIST_TIMEOUT_MS }).split("\0").filter((f) => f && !/(^|\/)node_modules\//.test(f));
const readSmall = (p: string): Buffer | null => { try { return statSync(p).size <= MAX_BYTES ? readFileSync(p) : null; } catch { return null; } };

export interface FenceSnap { files: Map<string, Buffer>; manifests: Map<string, Buffer>; error?: string }
/** Content of every fenced file present at session start, plus the dependency manifests (a lockfile follows a manifest change the session made). One listing; a failed one sets `error` and the fence is inactive for the session. */
export function snapshotFenced(cwd: string): FenceSnap {
  const snap: FenceSnap = { files: new Map(), manifests: new Map() };
  try {
    for (const rel of scan(cwd)) {
      const to = isFencedPath(rel) ? snap.files : MANIFEST.test(rel) ? snap.manifests : null;
      const b = to ? readSmall(join(cwd, rel)) : null;
      if (to && b) to.set(rel, b);
    }
  } catch (e) { snap.error = msg(e); }
  return snap;
}

export interface FenceRestore { restored: string[]; created: string[]; failed: { path: string; reason: string }[]; error?: string }
/** Puts back every fenced file the session changed, deleted or created, except what `allow` lets through. One failing file never stops the rest; nothing here throws. */
export function restoreFenced(cwd: string, snap: FenceSnap, allow: FenceAllow): FenceRestore {
  const out: FenceRestore = { restored: [], created: [], failed: [] };
  if (snap.error) return { ...out, error: `config fence inactive for this session: ${snap.error}` };
  let now: string[] = [];
  try { now = scan(cwd); } catch (e) { out.error = `config fence could not list new files after the session (${msg(e)}); only files that existed before it were checked`; }
  const changedManifests = [...new Set([...snap.manifests.keys(), ...now.filter((f) => MANIFEST.test(f))])].filter((m) => { const b = snap.manifests.get(m), n = readSmall(join(cwd, m)); return b ? !n || !b.equals(n) : !!n; });
  for (const rel of new Set([...snap.files.keys(), ...now.filter(isFencedPath)])) {
    if (allow(rel) || (LOCKFILE.test(rel) && manifestChanged(changedManifests.map((f) => ({ st: "M", f })), rel))) continue;
    try {
      const p = join(cwd, rel), before = snap.files.get(rel), cur = existsSync(p) ? readSmall(p) : null;
      if (before) { if (cur && before.equals(cur)) continue; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, before); out.restored.push(rel); }
      else if (cur && TEST_DIR.test(rel)) out.created.push(rel); // test scaffolding the run made (absent at session start, under a test directory): kept, and editable again later in this run
      else if (cur) { rmSync(p, { force: true }); out.restored.push(rel); } // created by the session; a file over the size cap stays and is not counted
    } catch (e) { out.failed.push({ path: rel, reason: msg(e) }); }
  }
  return out;
}

export interface FenceRecord {
  restored: { path: string; stage: string; session: string }[]; allowlisted: { path: string; session: string }[];
  denied: { path: string; session: string }[]; failures: string[];
}
const recPath = (runDir: string): string => join(runDir, "config_fence.jsonl");
// The runner process owns the record. The file under .loki/runs/ is output only: the model can reach it (Bash, or any writer the hook does not see), so what seal reads
// comes from this in-memory ledger, and the file is rewritten from it after every session (healRecord). A model that deletes, truncates or forges lines loses them again.
const ledger = new Map<string, Record<string, string>[]>();
const parseLines = (text: string): Record<string, string>[] => text.split("\n").flatMap((l) => { try { const e = JSON.parse(l) as Record<string, string>; return e && typeof e === "object" && typeof e["k"] === "string" ? [e] : []; } catch { return []; } }); // a torn line is skipped
const linesOf = (runDir: string): Record<string, string>[] => {
  let l = ledger.get(runDir);
  if (!l) { let text = ""; try { text = readFileSync(recPath(runDir), "utf8"); } catch { /* none yet */ } l = parseLines(text); ledger.set(runDir, l); } // first sight of this run in this process (a resume): seed from the file
  return l;
};
export function readFenceRecord(runDir: string): FenceRecord {
  const r: FenceRecord = { restored: [], allowlisted: [], denied: [], failures: [] };
  for (const e of linesOf(runDir)) {
    if (e["k"] === "restored") r.restored.push({ path: e["path"]!, stage: e["stage"]!, session: e["session"]! });
    else if (e["k"] === "allowlisted") r.allowlisted.push({ path: e["path"]!, session: e["session"]! });
    else if (e["k"] === "denied") r.denied.push({ path: e["path"]!, session: e["session"]! });
    else if (e["k"] === "failure") r.failures.push(e["text"]!);
  }
  return r;
}
/** Records facts in the ledger and appends them to the run file. Never throws. */
export function appendFence(runDir: string, ...lines: Record<string, string>[]): void {
  linesOf(runDir).push(...lines);
  try { mkdirSync(runDir, { recursive: true }); appendFileSync(recPath(runDir), lines.map((l) => `${JSON.stringify(l)}\n`).join("")); } catch { /* the fence already acted; a failed record must not fail the session */ }
}
/** Rewrites the run file from the ledger: undoes any edit a session made to it. Never throws. */
export function healRecord(runDir: string): void {
  try { const l = linesOf(runDir); if (l.length === 0) { rmSync(recPath(runDir), { force: true }); return; } mkdirSync(runDir, { recursive: true }); writeFileSync(recPath(runDir), l.map((e) => `${JSON.stringify(e)}\n`).join("")); } catch { /* best effort */ }
}
/** The hook runs inside the session process and writes denials to a private per-session log (path in LOKI_E10_FENCE_DENYLOG, outside the repo and not in the model's environment); the runner merges it after the session. */
export function appendDenial(logPath: string, path: string, session: string): void { try { appendFileSync(logPath, `${JSON.stringify({ k: "denied", path, session })}\n`); } catch { /* the deny already happened */ } }
export function mergeDenials(runDir: string, logPath: string): void {
  let text = ""; try { text = readFileSync(logPath, "utf8"); } catch { return; }
  const d = parseLines(text).filter((e) => e["k"] === "denied" && typeof e["path"] === "string").map((e) => ({ k: "denied", path: e["path"]!, session: e["session"] ?? "" }));
  if (d.length > 0) appendFence(runDir, ...d);
  try { rmSync(logPath, { force: true }); } catch { /* best effort */ }
}

// Config-named test files this run created. Kept in the runner process, never read back from a file the model can reach.
const createdByRun = new Map<string, Set<string>>();
export const markCreated = (runDir: string, paths: Iterable<string>): void => { const s = createdByRun.get(runDir) ?? new Set<string>(); for (const p of paths) if (TEST_DIR.test(p) && isFencedPath(p)) s.add(p); createdByRun.set(runDir, s); };
export const createdOf = (runDir: string): string[] => [...(createdByRun.get(runDir) ?? [])];

/** Existing fenced files a LOKI_SPEC_CONFLICT reason names (path, or basename), minus what the task already allows. */
export const conflictNamed = (reason: string, known: Iterable<string>, allow: FenceAllow): string[] => {
  const r = reason.toLowerCase();
  return [...known].filter((rel) => !allow(rel) && (r.includes(rel.toLowerCase()) || r.includes(rel.slice(rel.lastIndexOf("/") + 1).toLowerCase())));
};

/** Receipt lines. A spec-conflict allowlist (an unreviewed edit) always caps below VERIFIED (capFenceVerdict); a hook denial caps only when the final tree has no passing executed check (`provenPass`). A restore or a fence failure is disclosed only. */
export function fenceNotes(r: FenceRecord, provenPass = false): { notProven: string[]; capped: boolean } {
  const files = (l: { path: string }[]): string => [...new Set(l.map((x) => x.path))].join(", ");
  return {
    notProven: [
      ...(r.restored.length ? [`Config fence restored changes to test, build, lint or type config or a lockfile the task did not ask for: ${files(r.restored)}`] : []),
      ...(r.denied.length ? [`Config fence denied an edit to ${files(r.denied)}: a fenced config edit was denied${provenPass ? "; the run has a passing executed check without it (disclosed only)" : " and the run has no passing executed check, so it is not VERIFIED"}`] : []),
      ...(r.allowlisted.length ? [`Config fence allowlisted after the session declared a spec conflict naming it: ${files(r.allowlisted)}; the edit is unreviewed, so the run is not VERIFIED`] : []),
      ...[...new Set(r.failures)].map((f) => `Config fence off or partial: ${f}`),
    ],
    capped: r.allowlisted.length > 0 || (r.denied.length > 0 && !provenPass),
  };
}
/** A fence denial or allowlist caps VERIFIED and ALREADY_SATISFIED at PARTIAL. */
export const capFenceVerdict = <V extends string>(verdict: V, rec: { capped: boolean }): V | "PARTIAL" => (rec.capped && (verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED") ? "PARTIAL" : verdict);

/** CLI-route deny rules for .loki/ (a Claude Code deny rule always beats an allow rule, so the exception is built by omission): one rule for the whole
 *  tree without outputs; with outputs, a rule for every existing entry beside each output and its ancestor directories, plus every run record name in an
 *  output's directory whether or not it exists yet. A new non-record file the session creates beside an output is not denied here, as with fencedDenyRules. */
export function stateDenyRules(cwd: string, outputs: readonly string[] = []): string[] {
  const root = resolve(cwd, ".loki");
  if (outputs.length === 0) return [`Edit(/${root}/**)`];
  const keep = new Set(outputs), chain = new Set<string>([root]), rules = new Set<string>();
  for (const o of outputs) for (let d = dirname(o); d.startsWith(root + "/"); d = dirname(d)) chain.add(d);
  for (const dir of chain) {
    let names: string[] = []; try { names = readdirSync(dir); } catch { /* not created yet */ }
    for (const n of names) { const p = join(dir, n); if (!keep.has(p) && !chain.has(p)) { rules.add(`Edit(/${p})`); rules.add(`Edit(/${p}/**)`); } }
  }
  for (const d of new Set(outputs.map((o) => dirname(o)))) for (const n of RUN_RECORD_NAMES) { rules.add(`Edit(/${join(d, n)})`); rules.add(`Edit(/${join(d, n)}/**)`); }
  return [...rules];
}
const RUN_RECORD_NAMES = ["receipt.json", "receipt.md", "events.jsonl", "run.state.json", "state.json", "config_fence.jsonl", "ledger.csv", "checkpoints", "state"];

/** CLI route: one `Edit(//abs/path)` permission deny per existing fenced file the task does not name (the CLI applies Edit rules to Edit, Write and MultiEdit). A failed listing returns none (the restore after the session is the backstop and reports it). */
export function fencedDenyRules(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let allowed: string[] = [];
  try { const a = JSON.parse(env["LOKI_E10_FENCE_ALLOW"] ?? "[]") as unknown; if (Array.isArray(a)) allowed = a.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
  const allow = allowFor(env["LOKI_E10_FENCE_TASK"] ?? fenceTask(env), allowed);
  try { return scan(cwd).filter((rel) => isFencedPath(rel) && !allow(rel)).map((rel) => `Edit(/${resolve(cwd, rel)})`); } catch { return []; }
}
