// GROUP-FIX-UNITS: one bounded repair when group integration stops on a merge conflict or failing suite, run through the same unit
// launcher, then integration restarts. Max 1 per conflict, 2 per group; LOKI_GROUP_FIX_UNITS=0 restores stop-and-name. No check is relaxed.
import { spawnSync } from "node:child_process";
import type { Dag, Unit } from "../decompose.ts";
import type { IntegrateResult } from "../../engine10/integrate.ts";
import { safeGitSpawn } from "../../util/safe_git.ts";

export const MAX_FIX_UNITS = 2;
/** `fixFor` is the conflicting unit id or "suite"; `acceptance` goes to its frozen unit spec. */
export type FixUnit = Unit & { fixFor: string; fixKind: "conflict" | "suite"; acceptance: string[]; done?: boolean; spec?: string; base?: string };
export const fixEnabled = (env: NodeJS.ProcessEnv): boolean => (env["LOKI_GROUP_FIX_UNITS"] ?? "1") !== "0";

/** Integration view of the DAG: a conflict fix takes its unit's place (its branch holds the resolved merge); a suite fix goes last. */
export function effectiveDag(dag: Dag, fixes: readonly FixUnit[]): Dag {
  let units = dag.units.slice(), edges = dag.edges.slice();
  for (const f of fixes) {
    if (f.fixKind === "conflict") {
      units = units.map((u) => (u.id === f.fixFor ? f : u));
      edges = edges.map((e) => ({ ...e, from: e.from === f.fixFor ? f.id : e.from, to: e.to === f.fixFor ? f.id : e.to }));
    } else {
      edges = [...edges, ...units.map((u) => ({ from: u.id, to: f.id, via: "suite-fix" }))];
      units = [...units, f];
    }
  }
  return { ...dag, units, edges };
}
/** Conflicted files and their marker hunks for merging unitBranch into groupBranch (read-only: git merge-tree). */
function conflictInfo(repoDir: string, groupBranch: string, unitBranch: string): { files: string[]; hunks: string } {
  const r = safeGitSpawn(repoDir, ["merge-tree", "--write-tree", "--name-only", groupBranch, unitBranch], { encoding: "utf8" });
  const [head = "", ...rest] = String(r.stdout).split("\n");
  const files = rest.slice(0, rest.indexOf("") < 0 ? rest.length : rest.indexOf("")).filter(Boolean).slice(0, 5);
  let hunks = "";
  for (const f of files) {
    const blob = String(safeGitSpawn(repoDir, ["show", `${head}:${f}`], { encoding: "utf8" }).stdout);
    hunks += `--- ${f}\n${(blob.match(/^<<<<<<<[\s\S]*?^>>>>>>>.*$/gm) ?? []).join("\n").slice(0, 1500)}\n`;
  }
  return { files, hunks: hunks.slice(0, 4000) };
}
/** Brief from the failing-suite output integrate already captured; only re-runs the suite when no output was captured. */
function suiteTail(repoDir: string, cmd: readonly string[], captured?: string): string {
  if (captured !== undefined) return tailBrief(captured);
  const s = spawnSync(cmd[0]!, cmd.slice(1), { cwd: repoDir, encoding: "utf8", timeout: 600_000, env: { PATH: process.env["PATH"], HOME: process.env["HOME"], USER: process.env["USER"], LOGNAME: process.env["LOGNAME"], SHELL: process.env["SHELL"], CI: "1", LOKI_NO_BROWSER: "1" } });
  return tailBrief(`${String(s.stdout)}\n${String(s.stderr)}`);
}
function tailBrief(text: string): string {
  const out = text.split("\n");
  const names = out.filter((l) => /\b(fail|FAIL|not ok|Error)\b/.test(l)).slice(0, 20);
  return `Failing tests:\n${names.join("\n")}\nOutput tail:\n${out.slice(-40).join("\n")}`.slice(-4000);
}
export interface FixIo {
  integrate: (dag: Dag, branches: Record<string, string>, failed: string[]) => IntegrateResult | Promise<IntegrateResult>;
  launch: (fix: FixUnit) => Promise<string | null>; // branch only when the fix passed; starts at fix.base (the group tip), forwarded by dag.json to backlog.py
  leave: () => string | null;
  say: (s: string) => void;
}
/** integrate, and on a conflict or failing suite try at most MAX_FIX_UNITS repair units (one per conflict), re-integrating after each.
 *  `fixes` holds the group's earlier fix units (resume) and receives new ones. A failed fix returns the result that stopped integration. */
export async function integrateWithFixes(o: { repoDir: string; env: NodeJS.ProcessEnv; dag: Dag; fixes: FixUnit[]; branches: Record<string, string>; failed: string[]; testCmd: readonly string[]; io: FixIo }): Promise<IntegrateResult> {
  const { io } = o;
  const again = async (): Promise<IntegrateResult> => io.integrate(effectiveDag(o.dag, o.fixes), o.branches, o.failed);
  let r = await again();
  while (!r.ok && o.failed.length === 0 && fixEnabled(o.env) && o.fixes.length < MAX_FIX_UNITS) {
    const target = r.conflictUnit ?? (r.suiteExit !== null && r.suiteExit !== 0 ? "suite" : "");
    if (!target || o.fixes.some((f) => f.fixFor === target || f.id === target)) break;
    const id = `fixu-${o.fixes.length + 1}`, cmd = o.testCmd.join(" ");
    const base = { id, modules: [], serialized: [] as string[], fixFor: target }, all = [...new Set(o.dag.units.flatMap((u) => u.writeSet))];
    const ub = o.branches[target] ?? "", c = target === "suite" ? null : conflictInfo(o.repoDir, r.branch, ub);
    const fix: FixUnit = c === null
      ? { ...base, fixKind: "suite", writeSet: all.length ? all : ["src/"], acceptance: [`${cmd} exits 0`],
        items: [`Fix the failing test suite on the integrated group tree. Make the smallest change that makes \`${cmd}\` exit 0; do not weaken or delete tests.\n${suiteTail(o.repoDir, o.testCmd, r.suiteOutput)}`] }
      : { ...base, fixKind: "conflict", writeSet: c.files.length ? c.files : o.dag.units.find((u) => u.id === target)?.writeSet ?? ["src/"], acceptance: [`merge of ${ub} is committed with no conflict markers left`],
        items: [`Resolve a merge conflict. Merge branch ${ub} (unit ${target}) into the current tree, keep the intent of both sides, remove every conflict marker, commit the merge.\nConflicted files: ${c.files.join(", ") || "unknown"}\n${c.hunks}`] };
    io.say(`loki: integration stopped on ${target}; running fix unit ${id} (${o.fixes.length + 1} of ${MAX_FIX_UNITS})\n`);
    const branch = await io.launch(fix);
    const merged = !branch || fix.fixKind !== "conflict" || safeGitSpawn(o.repoDir, ["merge-base", "--is-ancestor", ub, branch]).status === 0;
    if (!branch || !merged) { io.say(`loki: fix unit ${id} did not pass; stopping at ${target}\n`); return r; }
    o.fixes.push(fix); o.branches[id] = branch;
    const err = io.leave();
    if (err) { io.say(`loki: ${err}\n`); return r; }
    r = await again();
  }
  return r;
}
