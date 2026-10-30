// v11.7.0 GROUP: the default GroupRunner for route.ts (D61 slices 10-13 glued together). Order: freeze per-unit acceptance
// (contract.ts), write the DAG, run units through autonomy/lib/backlog.py under the provider slot cap, merge passing unit
// branches and run the suite once (engine10/integrate.ts), then write group/manifest.json and seal one signed group receipt
// (seal_group.ts composeGroupReceipt) and re-verify it. Moat: exit 0 only when the group receipt verifies VERIFIED, every unit
// receipt is VERIFIED and the suite exited 0; otherwise NOT_PROVEN (4) or 1 on a failed unit. A launcher failure, an orphan
// criterion or an unreadable result is never VERIFIED. Resume: the same spec (spec_sha256 in dag.json) reuses its group id, DAG,
// base and contract, and skips units whose harvested receipt still verifies at the unit branch tip (LOKI_GROUP_RESUME=0 forces fresh).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { Dag, Unit } from "../decompose.ts";
import { assignCriteria, freezeGroupContract, groupContractPath, parseContract } from "../contract.ts";
import { integrate, type IntegrateOpts } from "../../engine10/integrate.ts";
import { loadSealedWall } from "../../util/check_result.ts";
import { unitSpecSha256 } from "./unit_mode.ts";
import { readSliceJournal, repoCacheDir, repoKey, sliceKey, writeSliceJournal } from "../../engine10/cache.ts";
import { integrateWithFixes, type FixUnit } from "./fix_units.ts";
import type { receiptSha256 as ReceiptSha256Fn } from "../../engine10/stages/seal.ts";
import type { verifyReceipt as VerifyReceiptFn } from "../../engine10/verify_cmd.ts";
import { composeGroupReceipt } from "./seal_group.ts";
import { safeGitSpawn } from "../../util/safe_git.ts";
import { atomicWriteJson } from "../../util/atomic.ts";
import { REPO_ROOT } from "../../util/paths.ts";
import { discoverCommands } from "../../runner/repo_profile.ts";
import { checkDecomposable } from "./decompose_check.ts";
import { buildRepoMap } from "../../engine10/repomap.ts";
import { createGroupFeed, createGroupRenderer } from "./group_output.ts";
import { providerSlots, type GroupCtx } from "./route.ts";

/** Seal and verify functions, injected by the caller outside features/ (D66 fence: features/ never value-imports seal or verify_cmd). */
export interface SealDeps { receiptSha256: typeof ReceiptSha256Fn; verifyReceipt: typeof VerifyReceiptFn }

/** Group integrated but not sealed: distinct non-zero so no caller reads it as VERIFIED. */
export const NOT_PROVEN = 4;

export interface BacklogRun { code: number; stdout: string }
/** argv is the full python3 argument list after the interpreter; env is already scoped. */
export type BacklogLauncher = (argv: string[], env: NodeJS.ProcessEnv, cwd: string, onOut?: (chunk: string) => void) => Promise<BacklogRun>;

const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_ALL|CI|SSH_AUTH_SOCK|GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|LOKI_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+)$/;
export function scopedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && ENV_KEEP.test(k)) out[k] = v;
  out["LOKI_NO_BROWSER"] = "1";
  return out;
}

/** Cost of one backlog.py launch, summed from its per-unit summary rows (`<label> $0.17 <status>`). usd is null when no unit reported a dollar figure: unknown is never $0. */
export interface GroupCost { usd: number | null; measured: number; unmeasured: number }
export function parseGroupCost(stdout: string): GroupCost {
  const at = stdout.lastIndexOf("\nSummary:");
  if (at < 0) return { usd: null, measured: 0, unmeasured: 0 }; // launcher died before its table: streamed lines are not unit rows
  const tail = stdout.slice(at + 1);
  let usd = 0, measured = 0, unmeasured = 0;
  for (const m of tail.matchAll(/^(?!ITEM\b)\S+[ \t]+(\$[0-9]+(?:\.[0-9]+)?|unmeasured)[ \t]+\S/gm)) {
    if (m[1] === "unmeasured") unmeasured++; else { usd += Number(m[1]!.slice(1)); measured++; }
  }
  return { usd: measured > 0 ? usd : null, measured, unmeasured };
}
/** One cost line for the group run, in the run-summary wording (`Cost:     $0.11` / `not measured`); partial when some units reported no figure, never $0.00 for an unknown. */
export function groupCostLine(costs: GroupCost[], provider = "claude"): string {
  const measured = costs.reduce((a, c) => a + c.measured, 0), unmeasured = costs.reduce((a, c) => a + c.unmeasured, 0);
  if (measured === 0) return "Cost:     not measured\n";
  const usd = costs.reduce((a, c) => a + (c.usd ?? 0), 0);
  return unmeasured > 0 ? `Cost:     $${usd.toFixed(2)} partial (${provider}, ${measured} of ${measured + unmeasured} unit sessions measured)\n` : `Cost:     $${usd.toFixed(2)} (${provider}, ${measured} unit session${measured === 1 ? "" : "s"})\n`;
}
/** Roll group unit cost into the parent run's efficiency records (.loki/metrics/efficiency/iteration-*.json) so collect_efficiency, the receipt and the bench read it. One record per priced launch (cost_usd = its summed unit figures) and one per unmeasured unit (no cost_usd key), because collect_efficiency derives cost_partial from records lacking cost_usd and ignores a record's own cost_partial flag. Phase is "implement": the group units do implementation work and collect_efficiency has no group phase. */
export function writeGroupCostRecord(repoDir: string, name: string, costs: GroupCost[], provider: string): void {
  const dir = join(repoDir, ".loki", "metrics", "efficiency");
  const timestamp = new Date().toISOString();
  try {
    const base = { phase: "implement", provider, status: "group", kind: "group_cost", timestamp }; // kind: the kpis reader excludes these from iteration_count
    const recs: Record<string, unknown>[] = [];
    for (const c of costs) {
      if (c.measured > 0 && c.usd !== null) recs.push({ ...base, cost_usd: Number(c.usd.toFixed(6)), units_measured: c.measured });
      for (let j = 0; j < c.unmeasured; j++) recs.push({ ...base, cost_unmeasured_reason: "unit reported no dollar figure" });
    }
    if (recs.length === 0) return;
    mkdirSync(dir, { recursive: true });
    recs.forEach((r, k) => atomicWriteJson(join(dir, `iteration-group-${name}-${String(k).padStart(3, "0")}.json`), r));
  } catch { /* cost reporting never fails the run */ }
}

const defaultLauncher: BacklogLauncher = (argv, env, cwd, onOut) => new Promise((resolve) => {
  const child = spawn("python3", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); onOut?.(b.toString()); process.stderr.write(b); });
  child.stderr.on("data", (b: Buffer) => { process.stderr.write(b); });
  child.on("error", (e) => resolve({ code: 127, stdout: out + String(e) }));
  child.on("close", (c) => resolve({ code: c ?? 1, stdout: out }));
});

const git = (dir: string, args: string[]): string => {
  const r = safeGitSpawn(dir, args, { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim() : "";
};
// Mirrors origin_slug in autonomy/lib/backlog.py: only a github.com owner/repo origin is accepted.
const SLUG_RE = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/;
/** The owner/repo slug of a github.com origin remote, or undefined. The unit launcher (backlog.py) needs it and the route calls this same test, so a group run is never started that the launcher would refuse. */
export const originSlug = (repoDir: string): string | undefined => SLUG_RE.exec(git(repoDir, ["remote", "get-url", "origin"]))?.[1];

/** Repo test command argv: LOKI_GROUP_TEST_CMD (whitespace split) wins; else the repo profile's first test command (runner/repo_profile.ts); else empty (the suite then did not run). */
export function testCommand(repoDir: string, env: NodeJS.ProcessEnv): string[] {
  const o = (env.LOKI_GROUP_TEST_CMD ?? "").trim();
  if (o) return o.split(/\s+/);
  const found = discoverCommands(repoDir).find((c) => c.kind === "test"); // the repo profile owns manifest and runner detection
  if (found) return found.cmd.split(/\s+/);
  return [];
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GID_RE = /^g[a-z0-9]{1,30}$/;
const readJson = (p: string): Record<string, unknown> | null => { try { const v = JSON.parse(readFileSync(p, "utf8")) as unknown; return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; } };
/** A unit as stored in dag.json: the decomposer's fields plus `spec` (abs path of its frozen unit spec) and `done` (backlog.py skips it). */
type StoredUnit = Unit & { spec?: string; done?: boolean; base?: string };

/** Hash of one unit's contract slice (criterion texts only: ids shift when criteria are inserted). */
const sliceSha = (criteria: { text: string }[]): string => sha256(JSON.stringify(criteria.map((c) => c.text)));

/** Newest .loki/groups/<gid>/dag.json whose spec_sha256 equals specSha (or, with unitIds, whose non-fix unit ids equal unitIds: a revised spec), or null. */
function findResumable(repoDir: string, specSha: string, unitIds?: string[]): { gid: string; stored: Record<string, unknown> } | null {
  const root = join(repoDir, ".loki", "groups");
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return null; }
  let best: { gid: string; stored: Record<string, unknown>; at: number } | null = null;
  for (const gid of names) {
    if (!GID_RE.test(gid)) continue;
    const p = join(root, gid, "dag.json"), d = readJson(p);
    if (!d || (unitIds ? JSON.stringify((Array.isArray(d["units"]) ? (d["units"] as Partial<FixUnit>[]) : []).filter((u) => !u.fixKind).map((u) => u.id)) !== JSON.stringify(unitIds) : d["spec_sha256"] !== specSha) || typeof d["base_ref"] !== "string" || !Array.isArray(d["units"])) continue;
    let at = 0; try { at = statSync(p).mtimeMs; } catch { continue; }
    if (!best || at > best.at || (at === best.at && gid > best.gid)) best = { gid, stored: d, at };
  }
  return best ? { gid: best.gid, stored: best.stored } : null;
}

/** GAME10-06a: each integrated unit's sealed Wall, read from the harvested unit run dir. The unit worktree (where the receipt's Wall paths point) is named by the receipt itself, falling back to the backlog worktree for the branch. */
export function unitWalls(repoDir: string, gid: string, branches: Record<string, string>): NonNullable<IntegrateOpts["walls"]> {
  const out: NonNullable<IntegrateOpts["walls"]> = {};
  for (const [id, br] of Object.entries(branches)) {
    const runDir = join(repoDir, ".loki", "groups", gid, "group", "units", id);
    let root = `${repoDir}-backlog/${br.replace(/^loki\//, "")}`;
    try {
      const f = ((JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")) as { wall?: { files?: { path?: unknown }[] } }).wall?.files ?? [])[0]?.path;
      const m = typeof f === "string" ? /^(.*-backlog\/unit-[^/]+-\d+)\//.exec(f) : null;
      if (m) root = m[1]!;
    } catch { /* unreadable receipt: loadSealedWall reports it */ }
    out[id] = loadSealedWall(runDir, root);
  }
  return out;
}

/** A harvested unit counts as done only if its receipt verifies (signed), reads VERIFIED, and its head is the unit branch tip. */
async function unitDone(verifyReceipt: SealDeps["verifyReceipt"], repoDir: string, gid: string, n: number, id: string): Promise<boolean> {
  if (!UNIT_ID_RE.test(id)) return false;
  const rp = join(repoDir, ".loki", "groups", gid, "group", "units", id, "receipt.json");
  const rec = readJson(rp);
  if (!rec || rec["verdict"] !== "VERIFIED") return false;
  if ((await verifyReceipt(rp)).verdict !== "VERIFIED") return false;
  const tip = git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/loki/unit-${gid}-${n}`]);
  return tip !== "" && rec["head_sha"] === tip;
}

/** #283: a unit of an earlier group with the same card and base sha, whose receipt still verifies at its branch tip, is adopted into this group (receipt copied, branch ref pointed at the same tip) instead of dispatched. */
async function adoptJournaled(verifyReceipt: SealDeps["verifyReceipt"], repoDir: string, dir: string, key: string, gid: string, n: number, id: string, task: string, specSha: string, say: (s: string) => void): Promise<boolean> {
  const e = readSliceJournal(dir, key);
  if (!e || e.id !== id || !GID_RE.test(e.gid) || e.gid === gid || !UNIT_ID_RE.test(id)) return false;
  if (!(await unitDone(verifyReceipt, repoDir, e.gid, e.n, id))) return false;
  const signed = readJson(join(repoDir, ".loki", "groups", e.gid, "group", "units", id, "receipt.json"));
  const signedTask = ((signed?.["task"] as { sha256?: unknown } | undefined) ?? {}).sha256;
  const signedSpec = ((signed?.["unit_spec"] as { sha256?: unknown } | undefined) ?? {}).sha256;
  if (typeof signedSpec !== "string" || signedSpec === "" || signedSpec !== specSha) return false; // #317b: task.sha256 covers items only; the signed unit spec hash also binds acceptance, writeSet and base
  if (typeof signedTask !== "string" || signedTask === "" || signedTask !== sha256(task)) return false; // the journal is unsigned: the signed receipt must name this unit's task text (intake always records it, so absent is foreign or forged)
  const tip = git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/loki/unit-${e.gid}-${e.n}`]);
  if (tip === "" || tip !== e.head) return false;
  const dst = join(repoDir, ".loki", "groups", gid, "group", "units", id);
  rmSync(dst, { recursive: true, force: true });
  cpSync(join(repoDir, ".loki", "groups", e.gid, "group", "units", id), dst, { recursive: true });
  if (safeGitSpawn(repoDir, ["update-ref", `refs/heads/loki/unit-${gid}-${n}`, tip], { encoding: "utf8" }).status !== 0) return false;
  if (!(await unitDone(verifyReceipt, repoDir, gid, n, id))) return false;
  say(`loki: unit ${id} reused from the slice journal (group ${e.gid}, same card and base)\n`);
  return true;
}

/** The card's exit-0 rule for unit receipts: every unit VERIFIED (ALREADY_SATISFIED does not pass). Shared by the fresh path and the resume short-circuit. */
function allUnitsVerified(unitVerdicts: string[]): boolean {
  return unitVerdicts.every((x) => x === "VERIFIED");
}

function unitVerdictsOf(rec: Record<string, unknown>): string[] {
  const us = (rec["group"] as { units?: { verdict?: unknown }[] } | undefined)?.units;
  return Array.isArray(us) && us.length > 0 ? us.map((u) => String(u.verdict)) : ["MISSING"];
}

export async function runGroup(launcher: BacklogLauncher | undefined, dag: Dag, ctx: GroupCtx): Promise<number> {
  const say = ctx.say ?? ((s: string): void => { process.stderr.write(s); });
  const { repoDir, env } = ctx;
  if (!ctx.seal) { say("loki: NOT PROVEN: no seal or verify implementation was supplied; no unit was started\n"); return NOT_PROVEN; }
  const { receiptSha256, verifyReceipt } = ctx.seal;
  const run = launcher ?? defaultLauncher;
  const specSha = sha256(ctx.spec);
  const resumeOn = env.LOKI_GROUP_RESUME !== "0";
  const exact = resumeOn ? findResumable(repoDir, specSha) : null;
  const resumable = exact ?? (resumeOn ? findResumable(repoDir, specSha, dag.units.map((u) => u.id)) : null); // revised spec: same decomposition, different spec
  const revised = resumable !== null && exact === null;
  const changed = new Set<string>(); // revised spec: units whose contract slice hash changed (these rerun; the rest are skipped-unchanged)
  const groupId = resumable?.gid ?? `g${Date.now().toString(36)}`;
  const groupDir = join(repoDir, ".loki", "groups", groupId);
  const receiptPath = join(groupDir, "receipt.json");
  const slugOf = (): string | undefined => originSlug(repoDir);

  let baseRef: string;
  let startBranch = "";
  let units: StoredUnit[];
  let full: Dag;
  /** Leaves loki/group-<id> (when HEAD is on it) and deletes it; returns an error text, or null. */
  const dropGroupBranch = (): string | null => {
    const gb = `loki/group-${groupId}`;
    if (git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${gb}`]) === "") return null;
    if (git(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]) === gb) {
      const co = safeGitSpawn(repoDir, startBranch ? ["checkout", "-q", startBranch] : ["checkout", "-q", "--detach", baseRef], { encoding: "utf8" });
      if (co.status !== 0) return `cannot leave ${gb}: ${String(co.stderr).trim()}`;
    }
    return safeGitSpawn(repoDir, ["branch", "-D", gb], { encoding: "utf8" }).status !== 0 ? `cannot remove stale ${gb}` : null;
  };
  if (resumable) {
    // Same spec: reuse the gid, the stored DAG, its base and the frozen contract (never refreeze, never re-decompose).
    baseRef = String(resumable.stored["base_ref"]);
    startBranch = String(resumable.stored["start_branch"] ?? "");
    full = { units: resumable.stored["units"] as Unit[], sharedFiles: (resumable.stored["sharedFiles"] as string[] | undefined) ?? [], edges: (resumable.stored["edges"] as Dag["edges"] | undefined) ?? [] };
    units = full.units as StoredUnit[];
    if (revised) {
      const next = assignCriteria(units, parseContract(ctx.spec, ctx.specPath ?? "").criteria).units;
      const oldUnits = readJson(groupContractPath(repoDir, groupId))?.["units"];
      const old = new Map<string, string>();
      for (const cu of Array.isArray(oldUnits) ? (oldUnits as { id: string; criteria: { text: string }[] }[]) : []) old.set(cu.id, sliceSha(cu.criteria));
      for (const nu of next) if (old.get(nu.id) !== sliceSha(nu.criteria)) changed.add(nu.id);
      const f = freezeGroupContract(repoDir, groupId, units, parseContract(ctx.spec, ctx.specPath ?? ""));
      if (!f.ok) { say(`loki: ${f.reason}\n`); return 1; }
      for (const u of units) if (changed.has(u.id)) { const nd = dag.units.find((x) => x.id === u.id); if (nd) { u.items = nd.items; u.writeSet = nd.writeSet; } }
    } else if (!existsSync(groupContractPath(repoDir, groupId))) {
      const f = freezeGroupContract(repoDir, groupId, units, parseContract(ctx.spec, ctx.specPath ?? ""));
      if (!f.ok) { say(`loki: ${f.reason}\n`); return 1; }
    }
    // A VERIFIED group receipt whose head is still the group branch re-verifies and finishes without launching anything.
    const rec = readJson(receiptPath);
    const tip = git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/loki/group-${groupId}`]);
    if (changed.size === 0 && rec && rec["verdict"] === "VERIFIED" && tip !== "" && rec["head_sha"] === tip && allUnitsVerified(unitVerdictsOf(rec)) && (await verifyReceipt(receiptPath)).verdict === "VERIFIED") {
      say(`loki: resuming group ${groupId}: group receipt already VERIFIED on ${`loki/group-${groupId}`}; nothing to run\n`);
      return 0;
    }
    // integrate refuses an existing group branch; a leftover one is this group's own earlier integration, so drop it.
    const dropErr = dropGroupBranch();
    if (dropErr) { say(`loki: FAILED: ${dropErr} (resuming group ${groupId})\n`); return 1; }
  } else {
    const frozen = freezeGroupContract(repoDir, groupId, dag.units, parseContract(ctx.spec, ctx.specPath ?? ""));
    if (!frozen.ok) { say(`loki: ${frozen.reason}\n`); return 1; }
    if (!slugOf()) { say("loki: NOT PROVEN: group run needs an origin remote of the form owner/repo; no unit was started\n"); return 1; }
    baseRef = git(repoDir, ["rev-parse", "HEAD"]);
    if (!baseRef) { say("loki: NOT PROVEN: cannot resolve HEAD; no unit was started\n"); return 1; }
    startBranch = git(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]);
    full = dag;
    units = dag.units.map((u) => ({ ...u }));
  }

  // Per-unit frozen acceptance, written outside every unit worktree (unit_mode.ts contract) before backlog launches.
  const gc = readJson(groupContractPath(repoDir, groupId));
  const accOf = new Map<string, string[]>();
  for (const cu of Array.isArray(gc?.["units"]) ? (gc!["units"] as { id: string; criteria: { text: string }[] }[]) : []) accOf.set(cu.id, cu.criteria.map((c) => c.text));
  const specDir = join(groupDir, "unit_specs");
  mkdirSync(specDir, { recursive: true });
  for (const u of units) {
    const spec = join(specDir, `${u.id}.json`);
    const isFix = !!(u as Partial<FixUnit>).fixKind;
    if (!isFix) u.base = baseRef;
    atomicWriteJson(spec, { id: u.id, writeSet: u.writeSet, pack: u.writeSet, tokenBudget: 1e9, acceptance: (u as Partial<FixUnit>).acceptance ?? accOf.get(u.id) ?? [], items: u.items ?? [], base: u.base ?? "" }); // items and base are part of the signed unit_spec identity (#317b)
    u.spec = spec; // #317: the base the slice journal keys on is the base the unit starts at (backlog.py would otherwise start it at origin/HEAD)
  }
  const jdir = repoCacheDir(repoKey(git(repoDir, ["remote", "get-url", "origin"]) || null, repoDir), env.LOKI_CACHE_ROOT ? resolve(env.LOKI_CACHE_ROOT) : undefined);
  const keyOf = (u: StoredUnit): string => sliceKey(JSON.stringify({ id: u.id, items: u.items, writeSet: u.writeSet, acceptance: accOf.get(u.id) ?? [] }), baseRef);
  // Resume bookkeeping: a unit is done only on a verified, head-matching harvest; anything else drops its stale harvest and reruns.
  let doneCount = 0;
  for (const [i, u] of units.entries()) {
    u.done = resumable && !changed.has(u.id) ? await unitDone(verifyReceipt, repoDir, groupId, i + 1, u.id) : false;
    if (!u.done && !changed.has(u.id) && !(u as Partial<FixUnit>).fixKind) { try { u.done = await adoptJournaled(verifyReceipt, repoDir, jdir, keyOf(u), groupId, i + 1, u.id, (u.items ?? []).join("\n"), unitSpecSha256({ id: u.id, items: u.items, acceptance: accOf.get(u.id) ?? [], writeSet: u.writeSet, base: baseRef }), say); } catch { u.done = false; } }
    if (u.done) { doneCount++; if (revised) say(`loki: unit ${u.id} skipped-unchanged\n`); }
    else if (resumable && UNIT_ID_RE.test(u.id)) rmSync(join(groupDir, "group", "units", u.id), { recursive: true, force: true });
  }
  // An unfinished fix unit (and every later one) is dropped: its base integration no longer exists; the fix loop re-derives it.
  const cut = units.findIndex((u) => (u as Partial<FixUnit>).fixKind && !u.done);
  if (cut >= 0) for (const u of units.splice(cut)) { if (u.done) doneCount--; rmSync(join(groupDir, "group", "units", u.id), { recursive: true, force: true }); }
  if (resumable) say(`loki: resuming group ${groupId}: ${doneCount} of ${units.length} units already VERIFIED\n`);
  const dagPath = join(groupDir, "dag.json");
  atomicWriteJson(dagPath, { group: groupId, spec_sha256: specSha, base_ref: baseRef, start_branch: startBranch, ...full, units });
  // D61-09: report a heavily coupled backlog. Advisory only: it never changes the DAG, the slots or the exit code.
  try {
    const chk = await checkDecomposable(full, { map: (() => { try { return buildRepoMap(repoDir); } catch { return null; } })() });
    if (chk.mode === "sequential") say(`loki: warning: backlog is not decomposable into parallel units (${chk.reason}); units still run, but coupled work may conflict at integration\n`);
  } catch { /* advisory check failed: run unchanged */ }

  const { provider, slots } = providerSlots(env, ctx.provider);
  const pending = units.length - doneCount;
  const status = new Map<string, string>();
  const costs: GroupCost[] = [];
  let launchCode = 0;
  const costName = `${groupId}-${Date.now().toString(36)}`; // one record per invocation: a resumed group adds to earlier launches
  if (pending > 0) {
    const slug = slugOf();
    if (!slug) { say("loki: NOT PROVEN: group run needs an origin remote of the form owner/repo; no unit was started\n"); return 1; }
    const n = Math.min(slots, pending);
    say(`loki: group ${groupId}: ${units.length} units, ${n} parallel slot(s) (provider ${provider})\n`);
    const backlog = join(REPO_ROOT, "autonomy", "lib", "backlog.py");
    const feed = createGroupFeed(groupId, units, createGroupRenderer({ write: say, isTTY: false })); // plain per-unit lines; a TTY repaint needs a raw stderr writer
    const res = await run([backlog, slug, "--dag", dagPath, "--group", groupId, "--slots", String(n), "--provider", provider], scopedEnv({ ...env, LOKI_PROVIDER: provider }), repoDir, (c) => feed.feed(c));
    launchCode = res.code;
    costs.push(parseGroupCost(res.stdout));
    // backlog prints `backlog: unit-<group>-<n> <status>`; a unit passed only when its status is VERIFIED or a PR url. Anything else is a fail.
    for (const m of res.stdout.matchAll(/^backlog: (unit-\S+) (VERIFIED|PR \S+|FAILED.*|BLOCKED.*|BUDGET_STOP.*|SKIPPED.*)$/gm)) status.set(m[1]!, m[2]!);
  }
  for (const [i, u] of units.entries()) { // journal every VERIFIED, head-matching unit so a later group with the same card and base skips it
    if ((u as Partial<FixUnit>).fixKind || !(u.done || /^(VERIFIED|PR )/.test(status.get(`unit-${groupId}-${i + 1}`) ?? ""))) continue;
    try { if (await unitDone(verifyReceipt, repoDir, groupId, i + 1, u.id)) writeSliceJournal(jdir, keyOf(u), { gid: groupId, n: i + 1, id: u.id, head: git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/loki/unit-${groupId}-${i + 1}`]) }); } catch { /* an unwritable journal only costs a rerun */ }
  }
  const branches: Record<string, string> = {};
  const failedUnits: string[] = [];
  units.forEach((u, i) => {
    const key = `unit-${groupId}-${i + 1}`, st = status.get(key) ?? "";
    if (u.done || /^(VERIFIED|PR )/.test(st)) branches[u.id] = `loki/${key}`; else failedUnits.push(u.id);
  });
  if (launchCode !== 0) say(`loki: unit launcher exit ${launchCode}; ${failedUnits.length} unit(s) did not pass\n`);
  if (costs.length > 0) { say(groupCostLine(costs, provider)); writeGroupCostRecord(repoDir, costName, costs, provider); }
  if (Object.keys(branches).length === 0) { say("loki: FAILED: no unit passed; nothing to integrate\n"); return 1; }

  const testCmd = testCommand(repoDir, env), fixes = units.filter((u) => (u as Partial<FixUnit>).fixKind) as FixUnit[];
  const putDag = (us: StoredUnit[]): void => atomicWriteJson(dagPath, { group: groupId, spec_sha256: specSha, base_ref: baseRef, start_branch: startBranch, ...full, units: us });
  const launchFix = async (fix: FixUnit): Promise<string | null> => {
    const key = `unit-${groupId}-${units.length + 1}`, spec = join(specDir, `${fix.id}.json`), slug = slugOf();
    if (!slug) return null;
    atomicWriteJson(spec, { id: fix.id, writeSet: fix.writeSet, pack: fix.writeSet, tokenBudget: 1e9, acceptance: fix.acceptance });
    fix.spec = spec; fix.done = false; fix.base = git(repoDir, ["rev-parse", "HEAD"]); units.push(fix); // backlog.py starts the worktree at the group tip, not origin/HEAD
    putDag(units.map((u) => (u === fix ? u : { ...u, done: true })));
    const res = await run([join(REPO_ROOT, "autonomy", "lib", "backlog.py"), slug, "--dag", dagPath, "--group", groupId, "--slots", "1", "--provider", provider], scopedEnv({ ...env, LOKI_PROVIDER: provider }), repoDir);
    costs.push(parseGroupCost(res.stdout));
    if (res.code !== 0 || !new RegExp(`^backlog: ${key} (VERIFIED|PR \\S+)$`, "m").test(res.stdout)) { units.pop(); return null; }
    fix.done = true;
    return `loki/${key}`;
  };
  const r = await integrateWithFixes({ repoDir, env, dag: { ...full, units: units.filter((u) => !(u as Partial<FixUnit>).fixKind) }, fixes, branches, failed: failedUnits, testCmd,
    io: { integrate: (dag, br, failed) => integrate({ repoDir, groupId, baseRef, dag, branches: br, failedUnits: failed, testCmd, walls: unitWalls(repoDir, groupId, br) }), launch: launchFix, leave: dropGroupBranch, say } });
  if (fixes.length > 0) putDag(units);
  if (costs.length > 1) { say(groupCostLine(costs, provider)); writeGroupCostRecord(repoDir, costName, costs, provider); } // fix units ran after the first line: restate the running total
  for (const [id, o] of Object.entries(r.perUnit)) say(`loki: unit ${id} ${o}\n`);
  for (const [id, w] of Object.entries(r.wallResults ?? {})) say(`loki: unit ${id} sealed Wall on the merged tree: ${w.status}${w.reason ? ` (${w.reason})` : ""}\n`);
  if (!r.ok || launchCode !== 0) {
    say(`loki: FAILED: group not verified (${r.reason ?? "launcher reported a failed unit"})\n`);
    return 1;
  }

  // Group Seal: manifest (DAG order) -> composeGroupReceipt over the harvested unit receipts -> verifyReceipt. Exit 0 only when all three agree.
  const order = units.map((u) => ({ unit_id: u.id, goal: u.items.join("; "), files: u.writeSet }));
  atomicWriteJson(join(groupDir, "group", "manifest.json"), { group_id: groupId, units: order });
  const head = git(repoDir, ["rev-parse", "--verify", `refs/heads/${r.branch}`]);
  let verdict = "", unitVerdicts: string[] = [], why = "";
  try {
    const { receipt } = composeGroupReceipt(groupDir, receiptSha256 as never, { baseRef, head });
    verdict = String(receipt["verdict"]);
    unitVerdicts = ((receipt["group"] as { units: { verdict: string }[] }).units).map((u) => u.verdict);
    const v = await verifyReceipt(receiptPath);
    if (v.verdict !== "VERIFIED") why = `group receipt verify ${v.verdict}${v.reasons.length ? `: ${v.reasons.join("; ")}` : ""}`;
  } catch (e) { why = `group receipt not written: ${(e as Error).message}`; }
  if (!why && verdict !== "VERIFIED") why = `group verdict ${verdict}`;
  if (!why && !allUnitsVerified(unitVerdicts)) why = "a unit receipt is not VERIFIED";
  if (!why && r.suiteExit !== 0) why = `suite exit ${String(r.suiteExit)}`;
  if (why) {
    say(`loki: group ${groupId} integrated on ${r.branch}, suite exit ${String(r.suiteExit)}. NOT PROVEN: ${why}; exit ${NOT_PROVEN}\n`);
    return NOT_PROVEN;
  }
  say(`loki: group ${groupId} VERIFIED on ${r.branch}, suite exit ${r.suiteExit}; receipt ${receiptPath}\n`);
  return 0;
}
