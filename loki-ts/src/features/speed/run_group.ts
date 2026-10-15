// v11.7.0 GROUP: the default GroupRunner for route.ts (D61 slices 10-13 glued together). Order: freeze per-unit acceptance
// (contract.ts), write the DAG, run units through autonomy/lib/backlog.py under the provider slot cap, merge passing unit
// branches and run the suite once (engine10/integrate.ts), then write group/manifest.json and seal one signed group receipt
// (seal_group.ts composeGroupReceipt) and re-verify it. Moat: exit 0 only when the group receipt verifies VERIFIED, every unit
// receipt is VERIFIED and the suite exited 0; otherwise NOT_PROVEN (4) or 1 on a failed unit. A launcher failure, an orphan
// criterion or an unreadable result is never VERIFIED. Resume: the same spec (spec_sha256 in dag.json) reuses its group id, DAG,
// base and contract, and skips units whose harvested receipt still verifies at the unit branch tip (LOKI_GROUP_RESUME=0 forces fresh).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Dag, Unit } from "../decompose.ts";
import { freezeGroupContract, groupContractPath, parseContract } from "../contract.ts";
import { integrate } from "../../engine10/integrate.ts";
import { receiptSha256 } from "../../engine10/stages/seal.ts";
import { verifyReceipt } from "../../engine10/verify_cmd.ts";
import { composeGroupReceipt } from "./seal_group.ts";
import { safeGitSpawn } from "../../util/safe_git.ts";
import { atomicWriteJson } from "../../util/atomic.ts";
import { REPO_ROOT } from "../../util/paths.ts";
import { discoverCommands } from "../../runner/repo_profile.ts";
import { providerSlots, type GroupCtx } from "./route.ts";

/** Group integrated but not sealed: distinct non-zero so no caller reads it as VERIFIED. */
export const NOT_PROVEN = 4;

export interface BacklogRun { code: number; stdout: string }
/** argv is the full python3 argument list after the interpreter; env is already scoped. */
export type BacklogLauncher = (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<BacklogRun>;

const ENV_KEEP = /^(PATH|HOME|TMPDIR|LANG|LC_ALL|CI|SSH_AUTH_SOCK|GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|LOKI_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+)$/;
export function scopedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && ENV_KEEP.test(k)) out[k] = v;
  out["LOKI_NO_BROWSER"] = "1";
  return out;
}

const defaultLauncher: BacklogLauncher = (argv, env, cwd) => new Promise((resolve) => {
  const child = spawn("python3", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); process.stderr.write(b); });
  child.stderr.on("data", (b: Buffer) => { process.stderr.write(b); });
  child.on("error", (e) => resolve({ code: 127, stdout: out + String(e) }));
  child.on("close", (c) => resolve({ code: c ?? 1, stdout: out }));
});

const git = (dir: string, args: string[]): string => {
  const r = safeGitSpawn(dir, args, { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim() : "";
};
const SLUG_RE = /[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/;

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
type StoredUnit = Unit & { spec?: string; done?: boolean };

/** Newest .loki/groups/<gid>/dag.json whose spec_sha256 equals specSha, or null. */
function findResumable(repoDir: string, specSha: string): { gid: string; stored: Record<string, unknown> } | null {
  const root = join(repoDir, ".loki", "groups");
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return null; }
  let best: { gid: string; stored: Record<string, unknown>; at: number } | null = null;
  for (const gid of names) {
    if (!GID_RE.test(gid)) continue;
    const p = join(root, gid, "dag.json"), d = readJson(p);
    if (!d || d["spec_sha256"] !== specSha || typeof d["base_ref"] !== "string" || !Array.isArray(d["units"])) continue;
    let at = 0; try { at = statSync(p).mtimeMs; } catch { continue; }
    if (!best || at > best.at || (at === best.at && gid > best.gid)) best = { gid, stored: d, at };
  }
  return best ? { gid: best.gid, stored: best.stored } : null;
}

/** A harvested unit counts as done only if its receipt verifies (signed), reads VERIFIED, and its head is the unit branch tip. */
async function unitDone(repoDir: string, gid: string, n: number, id: string): Promise<boolean> {
  if (!UNIT_ID_RE.test(id)) return false;
  const rp = join(repoDir, ".loki", "groups", gid, "group", "units", id, "receipt.json");
  const rec = readJson(rp);
  if (!rec || rec["verdict"] !== "VERIFIED") return false;
  if ((await verifyReceipt(rp)).verdict !== "VERIFIED") return false;
  const tip = git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/loki/unit-${gid}-${n}`]);
  return tip !== "" && rec["head_sha"] === tip;
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
  const run = launcher ?? defaultLauncher;
  const specSha = sha256(ctx.spec);
  const resumable = env.LOKI_GROUP_RESUME === "0" ? null : findResumable(repoDir, specSha);
  const groupId = resumable?.gid ?? `g${Date.now().toString(36)}`;
  const groupDir = join(repoDir, ".loki", "groups", groupId);
  const receiptPath = join(groupDir, "receipt.json");
  const slugOf = (): string | undefined => SLUG_RE.exec(git(repoDir, ["remote", "get-url", "origin"]))?.[1];

  let baseRef: string;
  let startBranch = "";
  let units: StoredUnit[];
  let full: Dag;
  if (resumable) {
    // Same spec: reuse the gid, the stored DAG, its base and the frozen contract (never refreeze, never re-decompose).
    baseRef = String(resumable.stored["base_ref"]);
    startBranch = String(resumable.stored["start_branch"] ?? "");
    full = { units: resumable.stored["units"] as Unit[], sharedFiles: (resumable.stored["sharedFiles"] as string[] | undefined) ?? [], edges: (resumable.stored["edges"] as Dag["edges"] | undefined) ?? [] };
    units = full.units as StoredUnit[];
    if (!existsSync(groupContractPath(repoDir, groupId))) {
      const f = freezeGroupContract(repoDir, groupId, units, parseContract(ctx.spec, ctx.specPath ?? ""));
      if (!f.ok) { say(`loki: ${f.reason}\n`); return 1; }
    }
    // A VERIFIED group receipt whose head is still the group branch re-verifies and finishes without launching anything.
    const rec = readJson(receiptPath);
    const tip = git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/loki/group-${groupId}`]);
    if (rec && rec["verdict"] === "VERIFIED" && tip !== "" && rec["head_sha"] === tip && allUnitsVerified(unitVerdictsOf(rec)) && (await verifyReceipt(receiptPath)).verdict === "VERIFIED") {
      say(`loki: resuming group ${groupId}: group receipt already VERIFIED on ${`loki/group-${groupId}`}; nothing to run\n`);
      return 0;
    }
    // integrate refuses an existing group branch; a leftover one is this group's own earlier integration, so drop it (leaving it first if HEAD is on it).
    const gb = `loki/group-${groupId}`;
    if (git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${gb}`]) !== "") {
      if (git(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]) === gb) {
        const co = safeGitSpawn(repoDir, startBranch ? ["checkout", "-q", startBranch] : ["checkout", "-q", "--detach", baseRef], { encoding: "utf8" });
        if (co.status !== 0) { say(`loki: FAILED: cannot leave ${gb} to resume group ${groupId}: ${String(co.stderr).trim()}\n`); return 1; }
      }
      if (safeGitSpawn(repoDir, ["branch", "-D", gb], { encoding: "utf8" }).status !== 0) { say(`loki: FAILED: cannot remove stale ${gb} to resume group ${groupId}\n`); return 1; }
    }
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
    atomicWriteJson(spec, { id: u.id, writeSet: u.writeSet, pack: u.writeSet, tokenBudget: 1e9, acceptance: accOf.get(u.id) ?? [] });
    u.spec = spec;
  }
  // Resume bookkeeping: a unit is done only on a verified, head-matching harvest; anything else drops its stale harvest and reruns.
  let doneCount = 0;
  for (const [i, u] of units.entries()) {
    u.done = resumable ? await unitDone(repoDir, groupId, i + 1, u.id) : false;
    if (u.done) doneCount++;
    else if (resumable && UNIT_ID_RE.test(u.id)) rmSync(join(groupDir, "group", "units", u.id), { recursive: true, force: true });
  }
  if (resumable) say(`loki: resuming group ${groupId}: ${doneCount} of ${units.length} units already VERIFIED\n`);
  const dagPath = join(groupDir, "dag.json");
  atomicWriteJson(dagPath, { group: groupId, spec_sha256: specSha, base_ref: baseRef, start_branch: startBranch, ...full, units });

  const { provider, slots } = providerSlots(env, ctx.provider);
  const pending = units.length - doneCount;
  const status = new Map<string, string>();
  let launchCode = 0;
  if (pending > 0) {
    const slug = slugOf();
    if (!slug) { say("loki: NOT PROVEN: group run needs an origin remote of the form owner/repo; no unit was started\n"); return 1; }
    const n = Math.min(slots, pending);
    say(`loki: group ${groupId}: ${units.length} units, ${n} parallel slot(s) (provider ${provider})\n`);
    const backlog = join(REPO_ROOT, "autonomy", "lib", "backlog.py");
    const res = await run([backlog, slug, "--dag", dagPath, "--group", groupId, "--slots", String(n), "--provider", provider], scopedEnv({ ...env, LOKI_PROVIDER: provider }), repoDir);
    launchCode = res.code;
    // backlog prints `backlog: unit-<group>-<n> <status>`; a unit passed only when its status is VERIFIED or a PR url. Anything else is a fail.
    for (const m of res.stdout.matchAll(/^backlog: (unit-\S+) (VERIFIED|PR \S+|FAILED.*|BLOCKED.*|BUDGET_STOP.*|SKIPPED.*)$/gm)) status.set(m[1]!, m[2]!);
  }
  const branches: Record<string, string> = {};
  const failedUnits: string[] = [];
  units.forEach((u, i) => {
    const key = `unit-${groupId}-${i + 1}`, st = status.get(key) ?? "";
    if (u.done || /^(VERIFIED|PR )/.test(st)) branches[u.id] = `loki/${key}`; else failedUnits.push(u.id);
  });
  if (launchCode !== 0) say(`loki: unit launcher exit ${launchCode}; ${failedUnits.length} unit(s) did not pass\n`);
  if (Object.keys(branches).length === 0) { say("loki: FAILED: no unit passed; nothing to integrate\n"); return 1; }

  const r = integrate({ repoDir, groupId, baseRef, dag: full, branches, failedUnits, testCmd: testCommand(repoDir, env) });
  for (const [id, o] of Object.entries(r.perUnit)) say(`loki: unit ${id} ${o}\n`);
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
