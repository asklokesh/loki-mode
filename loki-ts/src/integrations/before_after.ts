// T8: Before / After proof. Boot the app on the base tree (a temp git worktree) and on the changed tree, screenshot the changed
// route(s) with the existing visual-evidence capture, and render a "Before / After" PR section. The dev command comes from the
// Project Model (or the package.json dev/preview/start script the capture already resolves); the harness executes it, no repo-shape regex.
// Never throws and never fails a run: every failure is recorded as "before/after: NOT CAPTURED (<reason>)". LOKI_BEFORE_AFTER=0 renders nothing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { isMultiRoot, loadProjectApi } from "../project_model/resolve.ts";
import { captureVisualEvidence, isPageFile, pickScript, routeFor, visualEvidenceEnabled, type CaptureOpts, type EvidenceResult, type EvidenceScreen } from "../features/visual_evidence.ts";

export const beforeAfterEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_BEFORE_AFTER"] !== "0";
export interface BeforeAfterResult { before: EvidenceScreen[]; after: EvidenceScreen[]; reason: string | null; routes: string[] }
export interface BeforeAfterDeps {
  capture: (tree: string, runDir: string, changed: string[], o: CaptureOpts) => Promise<EvidenceResult>;
  worktreeAdd: (repoDir: string, path: string, ref: string) => void;
  worktreeRemove: (repoDir: string, path: string) => void;
}
const git = (cwd: string, args: string[]): void => { execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "ignore", timeout: 60_000 }); };
export const realDeps: BeforeAfterDeps = {
  capture: captureVisualEvidence,
  worktreeAdd: (repo, path, ref) => git(repo, ["worktree", "add", "--detach", path, ref]),
  worktreeRemove: (repo, path) => git(repo, ["worktree", "remove", "--force", path]),
};
const alive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const DEFAULT_BOOT_MS = 30_000;

/** The Project Model's UI boot command or the package.json script, whichever the existing capture would run. */
function hasDevCommand(repoDir: string): boolean {
  try {
    const api = loadProjectApi(repoDir);
    if (isMultiRoot(api) && api.uiBoot()) return true;
    const pkg = join(repoDir, "package.json");
    return existsSync(pkg) && pickScript(JSON.parse(readFileSync(pkg, "utf8"))) !== null;
  } catch { return false; }
}

export async function captureBeforeAfter(repoDir: string, runDir: string, changed: string[], baseRef: string, o: { env?: NodeJS.ProcessEnv; deps?: BeforeAfterDeps; bootMs?: number; signal?: AbortSignal } = {}): Promise<BeforeAfterResult> {
  const env = { ...(o.env ?? process.env), LOKI_NO_BROWSER: "1", BROWSER: "none" };
  const deps = o.deps ?? realDeps;
  const none = (reason: string, routes: string[] = []): BeforeAfterResult => ({ before: [], after: [], reason, routes });
  if (!visualEvidenceEnabled(env)) return none("LOKI_VISUAL_EVIDENCE is 0");
  const routes = [...new Set(changed.filter(isPageFile).map(routeFor))];
  if (routes.length === 0) return none("no changed UI route identified");
  if (!hasDevCommand(repoDir)) return none("no dev or start command in the Project Model", routes);
  const pgids: number[] = [];
  const bootMs = o.bootMs ?? DEFAULT_BOOT_MS;
  const base = join(runDir, "before_after");
  const wt = join(base, "base-tree");
  let added = false;
  const cap = (tree: string, side: "before" | "after"): Promise<EvidenceResult> => {
    const sub = join(base, side);
    mkdirSync(sub, { recursive: true });
    return deps.capture(tree, sub, changed, { env, budgetMs: bootMs, signal: o.signal, onServer: (p) => { pgids.push(p); } });
  };
  const rel = (side: string, s: EvidenceScreen[]): EvidenceScreen[] => s.filter((x) => /\.png$/.test(x.path)).map((x) => ({ path: join("before_after", side, x.path), sha256: x.sha256 }));
  try {
    mkdirSync(base, { recursive: true });
    try { deps.worktreeAdd(repoDir, wt, baseRef); added = true; } catch (e) { return none(`base worktree failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`, routes); }
    try { const nm = join(repoDir, "node_modules"); if (existsSync(nm) && !existsSync(join(wt, "node_modules"))) symlinkSync(nm, join(wt, "node_modules")); } catch { /* best effort */ }
    const b = await cap(wt, "before");
    const bs = rel("before", b.screens);
    if (bs.length === 0) return none(`base tree: ${b.skipped ?? "no screenshot produced"}`, routes);
    const a = await cap(repoDir, "after");
    const as = rel("after", a.screens);
    if (as.length === 0) return none(`changed tree: ${a.skipped ?? "no screenshot produced"}`, routes);
    return { before: bs, after: as, reason: null, routes };
  } catch (e) {
    return none(`capture failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`, routes);
  } finally {
    for (const p of pgids) { if (alive(p)) { try { process.kill(-p, "SIGKILL"); } catch { /* gone */ } } } // only the recorded groups
    if (added) { try { deps.worktreeRemove(repoDir, wt); } catch { /* already gone */ } }
  }
}

/** PR section. "" when opted out; otherwise a Before / After table or a single NOT CAPTURED line. */
export function beforeAfterSection(r: BeforeAfterResult | null): string {
  if (r === null || r.routes.length === 0) return ""; // no UI route changed: nothing to show, body stays byte-identical
  if (r.reason !== null || r.before.length === 0) return `\n## Before / After\nbefore/after: NOT CAPTURED (${r.reason ?? "no screenshot produced"})\n`;
  const name = (p: string): string => p.split("/").pop() ?? p;
  const byName = new Map(r.after.map((s) => [name(s.path), s]));
  const rows = r.before.map((b) => { const a = byName.get(name(b.path)); return `| ${name(b.path).replace(/\.png$/, "")} | ${b.path} (sha256:${b.sha256}) | ${a ? `${a.path} (sha256:${a.sha256})` : "not captured"} |`; });
  return `\n## Before / After\n| Route | Before | After |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
}
/** PR hook: "" when opted out (byte-identical body), never throws. */
export async function beforeAfterBlock(repoDir: string, runDir: string, changed: string[], baseRef: string, o: Parameters<typeof captureBeforeAfter>[4] = {}): Promise<string> {
  if (!beforeAfterEnabled(o.env ?? process.env)) return "";
  try { return beforeAfterSection(await captureBeforeAfter(repoDir, runDir, changed, baseRef, o)); } catch (e) { return beforeAfterSection({ before: [], after: [], reason: `capture failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`, routes: [] }); }
}
