// loki-ts/src/engine10/stages/seal.ts
//
// E-10: commit and Seal (docs/v10/ENGINE.md sections 4, 9). Writes receipt.json
// and receipt.md, computes receipt_sha256, and signs natively with node:crypto Ed25519
// (A-121; no python, no `cryptography`). The key is the A-120 local key, created on first
// use. An empty token means UNSIGNED, never presented as attested.
import { createHash, randomBytes, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, readdirSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertDeltaNotes } from "../../e10ext/assert_delta.ts"; import { discardIfSatisfied } from "../../e10ext/discard.ts"; import { dropSet, parseStaged } from "../../e10ext/commit_filter.ts"; import { flagOutsideScope } from "../../e10ext/scope.ts"; import { RECEIPT_SIGNER_BASENAME } from "../../util/receipt_signer.ts";
import { run } from "../../util/shell.ts"; import { sealEvidence } from "../../features/visual_evidence.ts";
import { isTestFile } from "../testmap.ts"; import { crossReview, minVerdict } from "./xreview.ts";
import { STAGE_BUDGETS } from "../types.ts";
import { buildRouteBlock, routeNotProven, routePrLine, routeReceiptLines } from "../../runner/router/route_block.ts"; import { routerEnabled } from "../../runner/router/flag.ts"; import { sumResultCosts } from "../cost.ts";
import { hasExecutedProof, NO_TESTS_REASON, UNCONFIRMED_REASON, UNMEASURED_REASON } from "../../util/check_result.ts";
import { type ContractSnapshot, sealContract } from "../../features/contract.ts"; import { capGroupVerdict, sealGroup } from "../../features/speed/seal_group.ts";
import { readDeclared, supplyGuard, supplyVerdict } from "../../supply/supply_guard.ts";
import type { Obj, Receipt, ReceiptCheck, RunContext, Stage, StageName, StageResult, Verdict } from "../types.ts";

/** Deferred to deep verify, so always NOT PROVEN at seal time. */
export const DEEP_NOT_PROVEN = ["full suite", "app boot", "council", "security scan"] as const;
export const SIGNING_UNAVAILABLE = "receipt signing unavailable (no usable signing key: invalid key or unwritable ~/.loki/keys)";

const EXCLUDE_LOKI = ":(exclude).loki";
export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/** E-120: implement's spec_conflict_reason is model-written and lands verbatim in the receipt,
 *  a trust artifact; a reason containing "\n\n## Loki receipt: VERIFIED" would otherwise forge a
 *  second heading. Collapse all control chars (including newlines) to a single space, cap the
 *  length, and strip backticks so the caller can safely wrap it in a single inline-code span. */
function sanitizeReason(s: string): string {
  const collapsed = s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const capped = collapsed.length > 500 ? `${collapsed.slice(0, 500)}...` : collapsed;
  return capped.replace(/`/g, "'");
}

/** Python json.dumps(obj, sort_keys=True, separators=(",", ":")), ensure_ascii=True
 *  default, the convention of proof-generator.py _canonical, so a Python verifier recomputes the same bytes. */
export function canonicalJson(x: unknown): string {
  const walk = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const o = v as Obj;
      return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${walk(o[k])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  };
  // ponytail: key sort is by UTF-16 code unit, same as Python for BMP keys; astral-plane keys may order differently
  return walk(x).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** sha256 over the canonical receipt with `verification` AND `receipt_sha256` removed (the hash cannot contain itself). */
export function receiptSha256(r: Omit<Receipt, "receipt_sha256" | "verification"> & Partial<Receipt>): string {
  const { verification: _v, receipt_sha256: _h, ...body } = r;
  return sha256(canonicalJson(body));
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
/** RFC 7638 thumbprint, the same kid receipt_jwt.compute_kid derives. */
export const kidOf = (pub: KeyObject): string => b64u(createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${pub.export({ format: "jwk" }).x}"}`).digest());

/** Same precedence and file rules as receipt_jwt.load_signing_key: inline PEM, then KEY_FILE, then ~/.loki/keys/receipt-ed25519.pem
 *  (0600 key, 0700 dir, O_EXCL temp then link, so a concurrent first run reads the winner). Never logs or returns key bytes. */
export function loadSigningKey(generate = true): KeyObject | null {
  try {
    const inline = process.env["LOKI_RECEIPT_SIGNING_KEY"]?.trim();
    let pem: string | Buffer = inline ?? "";
    if (!inline) {
      const given = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]?.trim();
      const file = given || join(process.env["HOME"] || homedir(), ".loki", "keys", RECEIPT_SIGNER_BASENAME);
      try {
        pem = readFileSync(file);
        if (!given) for (const [f, m] of [[file, 0o600], [dirname(file), 0o700]] as const) if (statSync(f).mode & 0o077) chmodSync(f, m);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !generate) return null;
        mkdirSync(dirname(dirname(file)), { recursive: true, mode: 0o700 });
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`; // random, so a stale temp never blocks creation
        writeFileSync(tmp, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
        try { linkSync(tmp, file); } catch (l) { if ((l as NodeJS.ErrnoException).code !== "EEXIST") throw l; } finally { unlinkSync(tmp); }
        pem = readFileSync(file);
      }
    }
    const k = createPrivateKey(pem);
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch {
    return null;
  }
}

/** Signs a compact EdDSA JWT with node:crypto, byte-compatible with receipt_jwt.sign_attestation. Null jwt means UNSIGNED. */
export function signReceipt(runId: string, hash: string): { jwt: string | null; kid: string | null } {
  const key = loadSigningKey();
  if (!key) return { jwt: null, kid: null };
  const kid = kidOf(createPublicKey(key));
  const input = `${b64u(canonicalJson({ alg: "EdDSA", typ: "JWT", kid }))}.${b64u(canonicalJson({ job_id: runId, run_id: runId, receipt_sha256: hash, iat: Math.floor(Date.now() / 1000) }))}`;
  return { jwt: `${input}.${b64u(sign(null, Buffer.from(input), key))}`, kid };
}

async function git(ctx: RunContext, args: string[]): Promise<{ out: string; code: number }> {
  const r = await run(["git", ...args], { cwd: ctx.repoDir, timeoutMs: 20000 });
  return { out: r.stdout, code: r.exitCode };
}

/** Section 4 Commit: `git add -A` minus .loki/, Wall files and stray lockfiles, commit `loki: <title>` with a Loki-Run trailer. An empty diff commits nothing (head stays at base). */
export const commitStage: Stage = {
  name: "commit",
  ...STAGE_BUDGETS.commit,
  async run(ctx: RunContext): Promise<StageResult> {
    // A-104/G2: stage all, unstage .loki/, Wall files (sealed under runDir/wall) and a NEW lockfile with no manifest change in its own directory (judged against baseSha).
    if (!ctx.baseSha || (await git(ctx, ["rev-parse", "--verify", "-q", `${ctx.baseSha}^{commit}`])).code !== 0) return { status: "failed", data: {}, reason: "base commit not resolvable" }; // A-104b r2: fail closed, every later reset and diff is judged against the base
    if ((await git(ctx, ["add", "-A", "--", "."])).code !== 0) return { status: "failed", data: {}, reason: "git add failed" };
    const sd = await git(ctx, ["diff", "--cached", "--name-status", "--no-renames", "-z", ctx.baseSha]); if (sd.code !== 0) return { status: "failed", data: {}, reason: "git diff against base failed" };
    const staged = parseStaged(sd.out);
    const drop = dropSet(ctx.repoDir, staged, ctx.outputs().intake?.preexisting_dirty);
    const sat = await discardIfSatisfied((a) => git(ctx, a), ctx.baseSha, ctx.outputs(), staged, new Set(drop.filter(({ st }) => st === "L").map(({ f }) => f)), ctx.repoDir); if (sat) return sat; // D50-F1
    if (drop.length > 0 && (await git(ctx, ["--literal-pathspecs", "reset", "-q", ctx.baseSha, "--", ...drop.map(({ f }) => f)])).code !== 0) return { status: "failed", data: {}, reason: "git reset failed" }; // A-104b: reset to the run base (not HEAD) so a path committed in implement leaves the diff too; literal, so ":(top)x" is a filename
    const dropped = new Set(drop.map(({ f }) => f)), notes = flagOutsideScope(ctx.outputs(), staged.filter(({ f }) => !dropped.has(f))); // D76: advisory, nothing is reverted
    if ((await git(ctx, ["diff", "--cached", "--quiet"])).code === 0) return { status: "completed", data: { committed: false, scope_notes: notes } };
    const title = (str(ctx.outputs().intake?.title) ?? `run ${ctx.runId}`).split("\n")[0]!.slice(0, 72);
    const c = await git(ctx, ["commit", "-q", "-m", `loki: ${title}`, "-m", `Loki-Run: ${ctx.runId}`]);
    if (c.code !== 0) return { status: "failed", data: {}, reason: "git commit failed" };
    return { status: "completed", data: { committed: true, head_sha: (await git(ctx, ["rev-parse", "HEAD"])).out.trim(), scope_notes: notes } };
  },
};

// Stage outputs read by seal. Only keys in the ENGINE.md section 4 table (plus duration_s
// from section 5) are trusted; any other key seal reads puts a "not recorded" entry on
// NOT PROVEN when absent, so a producer cannot silently shape the receipt.
export function verdictOf(o: Partial<Record<StageName, Obj>>, checks: ReceiptCheck[], emptyDiff: boolean, verifyNotProven: boolean, wallGreenOnBase: boolean, proof: boolean, targetProof = false, uncovered: string[] = []): Verdict {
  const exit = o.implement?.exit;
  // FC-16: no success verdict without a Loki-executed check with n>0 and a pass; otherwise PARTIAL (NOT PROVEN, "no tests executed").
  if (o.commit?.failed !== true && strs(o.commit?.not_proven).length === 0 && (o.intake?.already_satisfied === true || wallGreenOnBase || exit === "already_done")) return proof ? "ALREADY_SATISFIED" : "PARTIAL";
  if (exit === "spec_conflict") return "SPEC_CONFLICT"; if (o.commit?.failed === true || strs(o.commit?.not_proven).length > 0) return "FAILED"; // r3: an unrestored user file is never a clean verdict; A-104b r2: a failed commit never seals VERIFIED
  // Section 2: an empty diff without the LOKI_ALREADY_DONE marker is FAILED, never VERIFIED.
  if (emptyDiff) return "FAILED";
  // FC-21b (1): a limit-killed implement is VERIFIED only when the harness itself ran every check green, a Wall or task-named test passed with n>0 (targetProof), and the limit was recorded.
  if (exit === "killed") return typeof o.implement?.limit_s === "number" && targetProof && uncovered.length === 0 && proof && !verifyNotProven && checks.length > 0 && checks.every((c) => c.result === "pass") ? "VERIFIED" : "PARTIAL";
  if (typeof o.implement?.limit_s === "number") return "PARTIAL"; // A1: a limit that did not kill the session (an error or a throw) is never a clean verdict
  if (checks.some((c) => c.result === "fail")) return "FAILED";
  // E-98a B1: verify's own NOT PROVEN (e.g. a system interpreter) downgrades too -- never a silent VERIFIED.
  if (exit === "killed" || checks.length === 0 || checks.some((c) => c.result !== "pass") || verifyNotProven || !proof) return "PARTIAL";
  return "VERIFIED";
}

/** FC-21b: verify's target_checks (Wall and task-named relevant tests) names a test that ran n>0 and passed; read from verify's raw checks, never from prose. */
export function targetProofOf(v: Obj | undefined): boolean {
  const names = new Set(strs(v?.target_checks)), raw = Array.isArray(v?.checks) ? (v.checks as Obj[]) : [];
  return raw.some((c) => names.has(String(c.name)) && hasExecutedProof([c]));
}

function checksOf(v: unknown): ReceiptCheck[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is Obj => !!c && typeof c === "object").map((c) => ({
    name: String(c.name ?? ""),
    cmd: String(c.cmd ?? ""),
    result: c.result === "pass" || c.result === "fail" ? c.result : "not_run",
    duration_s: typeof c.duration_s === "number" ? c.duration_s : 0,
  }));
}

export function renderReceiptMd(r: Receipt): string {
  const sig = r.verification.jwt ? `SIGNED (kid ${r.verification.kid})` : "UNSIGNED";
  // E-69: never $0.00 for an unpriced run; "partial" when some but not all sessions were priced.
  const usd = r.cost.usd !== null
    ? `$${r.cost.usd.toFixed(4)}`
    : r.cost.measured_sessions > 0
      ? `partial: $${r.cost.partial_usd.toFixed(4)} for ${r.cost.measured_sessions} of ${r.cost.total_sessions} sessions`
      : "not measured";
  return [
    `## Loki receipt: ${r.verdict}`,
    "",
    ...(r.verdict === "SPEC_CONFLICT" && r.spec_conflict_reason ? [`- Reason: \`${r.spec_conflict_reason}\``] : []),
    `- Run: ${r.run_id}`,
    `- Base: ${r.base_sha}  Head: ${r.head_sha}`,
    `- receipt_sha256: ${r.receipt_sha256}`,
    `- Signature: ${sig}`,
    `- Provider: ${r.provider} (${r.model})  Cost: ${usd}  Wall: ${r.time.wall_s}s`,
    ...(r.route ? routeReceiptLines(r.route) : []), // R1-15: only when the router is on
    "",
    "### Checks",
    ...(r.checks.length ? r.checks.map((c) => `- ${c.result}: ${c.name} (\`${c.cmd}\`, ${c.duration_s}s)`) : ["- none"]),
    "",
    ...(r.evidence.length ? ["### Evidence (already-satisfied)", ...r.evidence.map((e) => `- ${e}`), ""] : []),
    "### NOT PROVEN",
    ...r.not_proven.map((n) => `- ${sanitizeReason(n)}`),
    "",
  ].join("\n");
}

export const sealStage: Stage = {
  name: "seal",
  ...STAGE_BUDGETS.seal,
  async run(ctx: RunContext, signal?: AbortSignal): Promise<StageResult> {
    const o = ctx.outputs();
    const head = (await git(ctx, ["rev-parse", "HEAD"])).out.trim();
    const tree = (await git(ctx, ["rev-parse", "HEAD^{tree}"])).out.trim();
    // Plumbing, so repo/global config (diff.noprefix, color, textconv, ext diff, quotepath) cannot
    // change the hash. A verifier recomputes it with exactly: git diff-tree -r -z --raw --no-renames
    // --no-abbrev -O/dev/null <base> <head> -- . ':(exclude).loki'
    const diff = await run(["git", "diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "-O/dev/null", ctx.baseSha, head, "--", ".", EXCLUDE_LOKI], { cwd: ctx.repoDir, timeoutMs: 20000 });
    const diffOk = diff.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(head);
    const checks = checksOf(o.verify?.checks);
    const verifyNotProven = strs(o.verify?.not_proven); // E-98a B1: a section 4 key, trusted like checks/flaky below
    // D42 (3)/B1 (r2): not_run must never seal ALREADY_SATISFIED, same weight as a real base-tree failure.
    const base = (o.wall?.base_run ?? {}) as Obj;
    const wallNotRun = typeof base.not_run === "number" ? base.not_run : 0;
    const wallGreenOnBase = typeof base.pass === "number" && base.pass > 0 && base.fail === 0 && wallNotRun === 0;
    // An uncomputable diff is treated like an empty one: nothing is proven changed.
    const preRedChecks = strs(o.verify?.pre_red_checks); // A-112: recorded as fail, skipped by the verdict
    // A-119: any edit, delete or rename (--no-renames shows D plus A) of a pre-existing test file is NOT VERIFIED, same as verify's own notes.
    const rawDiff = diffOk ? diff.stdout.split("\0").filter(Boolean) : [];
    const weakTests: string[] = [];
    for (let i = 0; i + 1 < rawDiff.length; i += 2) if ((rawDiff[i]!.trim().split(" ").pop() ?? "") !== "A" && isTestFile(rawDiff[i + 1]!)) weakTests.push(rawDiff[i + 1]!);
    const grp = sealGroup(ctx.runDir, receiptSha256 as never); // D61-13: inert without group/manifest.json
    const proof = wallGreenOnBase || hasExecutedProof(Array.isArray(o.verify?.checks) ? (o.verify.checks as Obj[]) : []); // FC-16: executed n>0 pass, from verify's raw checks or the Wall base run
    const uncoveredAfterLimit = o.implement?.exit === "killed" ? strs(o.verify?.uncovered_changed) : []; // FC-21b: changed code no passing impacted check covered; limit path only
    const verdict0 = capGroupVerdict(verdictOf(o, checks.filter((c) => !(c.result === "fail" && preRedChecks.includes(c.name))), !diffOk || diff.stdout === "", verifyNotProven.length > 0 || weakTests.length > 0, wallGreenOnBase, proof, targetProofOf(o.verify), uncoveredAfterLimit), grp);

    // T10: supply-chain guard. A nonexistent new dependency blocks VERIFIED (a too-new one only warns unless LOKI_SUPPLY_MIN_AGE_DAYS is set); an unreachable registry only records NOT PROVEN.
    const supply = await supplyGuard(ctx.repoDir, rawDiff.filter((_, i) => i % 2 === 1), readDeclared(ctx.repoDir), process.env);
    const verdict1: Verdict = supplyVerdict(verdict0, supply);
    const xr = await crossReview(ctx, verdict1, head), verdict = minVerdict(verdict1, xr); // B4: opt-in second-provider review, downgrade only
    const notProven = new Set<string>([...DEEP_NOT_PROVEN, ...supply.notProven, ...grp.notProven, ...(xr?.notes ?? [])]);
    if (!proof && (verdict === "PARTIAL" || verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED")) { const vc = Array.isArray(o.verify?.checks) ? (o.verify.checks as Obj[]) : []; notProven.add(vc.length > 0 && vc.every((c) => c.n !== 0 && String(c.reason ?? "").startsWith(UNMEASURED_REASON)) ? UNMEASURED_REASON : vc.length > 0 && vc.every((c) => c.n !== 0 && String(c.reason ?? "").startsWith(UNCONFIRMED_REASON)) ? UNCONFIRMED_REASON : NO_TESTS_REASON); } // an unparsed count is never reported as "no tests executed"
    if (wallNotRun > 0) notProven.add(`wall base run not_run: ${wallNotRun}`);
    for (const d of Array.isArray(o.wall?.discarded) ? (o.wall!.discarded as Obj[]) : []) notProven.add(`wall test discarded: ${String(d.file)} (${String(d.reason)})`); // FC-23
    if (wallNotRun > 0) { // A-103b: wall.ts keeps each sealed copy under runDir/wall; a copy absent from wall.files was discarded (class not_run: no real base result)
      try { const kept = new Set((Array.isArray(o.wall?.files) ? (o.wall!.files as Obj[]) : []).map((f) => basename(String(f.path)))); for (const n of readdirSync(join(ctx.runDir, "wall")).sort()) if (!kept.has(n)) notProven.add(`wall test discarded: ${n} (not_run)`); } catch { /* no sealed wall dir: count line only */ }
    }
    if (!diffOk) notProven.add("diff not computed (git diff-tree failed)");
    // E-55: any status other than A means the path existed at base_sha (M, D, or T typechange, e.g. a symlink).
    // D50-F2r3: re-run the classifier on the COMMITTED blob (clean filters run at commit) with verify's counts; any mismatch drops verify's labels, "weakened test" stays.
    const dropped = new Set<string>(); const tcs = (o.verify as Obj | undefined)?.["test_counts"] as Obj | undefined;
    const cnt = (x: unknown): { run: number; skipped: number } | undefined => { const c = x as Obj | undefined; return c && typeof c.run === "number" && typeof c.skipped === "number" ? { run: c.run, skipped: c.skipped } : undefined; };
    for (const t of weakTests) {
      notProven.add(`weakened test: ${t}`);
      const vl = verifyNotProven.filter((v) => v.startsWith(`assertion value changed (not shown to be required by the task): ${t}:`)); if (!vl.length) continue;
      const tc = tcs?.[t] as Obj | undefined; const mine = assertDeltaNotes(ctx.repoDir, ctx.baseSha, head, t, str(o.intake?.task) ?? "", cnt(tc?.b), cnt(tc?.h));
      if (!mine || mine.length !== vl.length || mine.some((n) => !vl.includes(n))) for (const v of vl) dropped.add(v);
    }
    if (verdict !== "VERIFIED") for (const f of uncoveredAfterLimit) notProven.add(`changed, untested after limit: ${f}`);
    for (const c of checks) if (c.result === "not_run") notProven.add(`not run: ${c.name}`);
    for (const f of strs(o.verify?.flaky)) notProven.add(`flaky test: ${f}`);
    for (const n of verifyNotProven) if (!dropped.has(n)) notProven.add(n);
    for (const n of [...strs(o.commit?.not_proven), ...strs(o.commit?.scope_notes)]) notProven.add(n); // D58: scope_notes = edits flagged outside stated scope (never reverted) or scope undetermined; separate key so they never force FAILED
    for (const id of strs(o.verify?.pre_red)) notProven.add(`pre red: ${id}`); // A-112: listed, never downgrades (not via verifyNotProven)
    for (const t of strs(o.implement?.tests_reverted)) notProven.add(`reverted test edit: ${t}`);
    if (ctx.provider !== "claude") notProven.add("kill blocking not enforced");
    // Section 7: model_override_applied lives on run.started, which outputs() never carries.
    if (process.env["LOKI_MODEL_OVERRIDE"]?.trim() && ctx.provider !== "claude") notProven.add("model override not applied");
    const source = o.intake?.source;
    if (source !== "text" && source !== "issue") notProven.add("task source not recorded by intake");
    // Keys below are outside the section 4 table: absent means NOT PROVEN, never a default claim.
    const repo = str(o.intake?.repo);
    if (repo === null) notProven.add("repo not recorded by intake");
    if (typeof o.intake?.resumed !== "boolean") notProven.add("resume state not recorded by intake");

    const stages: Partial<Record<StageName, number>> = {};
    for (const [s, d] of Object.entries(o)) if (typeof d?.duration_s === "number") stages[s as StageName] = d.duration_s;
    const iterIds = Object.values(o).flatMap((d) => [...strs(d?.iteration_ids), ...strs([d?.iteration_id])]);
    if (iterIds.length === 0) notProven.add("cost not measured (no iteration ids recorded)");
    const cost = ctx.cost.read(ctx.repoDir, iterIds);
    if (cost.unmetered) notProven.add("cost unmetered (CLI invoker; recorded as 0)");
    // ponytail: events.jsonl is supervisor-written and may lag the worker; the supervisor re-hashes at receipt.sealed if exactness matters
    const eventsPath = join(ctx.runDir, "events.jsonl");
    const wallFiles = Array.isArray(o.wall?.files) ? (o.wall.files as { path: string; sha256: string }[]) : [];
    const wallPassed = typeof o.verify?.wall_passed === "boolean" ? o.verify.wall_passed : null;
    if (wallFiles.length > 0 && wallPassed === null) notProven.add("wall result not recorded by verify");

    // R1-15: router route block. Null (key omitted, hash stable) unless LOKI_ROUTER is on. Route facts come from the implement
    // output when R1-11 records them; token telemetry from the R1-08 result-cost fields (the cost reader's own `router`, else the files).
    const routeBlock = buildRouteBlock(process.env, ctx.provider, o.implement?.route as Record<string, unknown> | undefined,
      (cost as { router?: Record<string, number> }).router ?? (routerEnabled(process.env) ? sumResultCosts(join(ctx.repoDir, ".loki"), iterIds).router : undefined));
    if (routeBlock) for (const l of routeNotProven(routeBlock)) notProven.add(l);

    const body: Omit<Receipt, "receipt_sha256" | "verification"> = {
      schema: "loki.v10.receipt/1",
      run_id: ctx.runId,
      task: { source: source === "issue" ? "issue" : "text", sha256: str(o.intake?.task_sha256) ?? "" },
      repo: repo ?? "",
      base_sha: ctx.baseSha,
      head_sha: head,
      tree,
      diff_sha256: sha256(diffOk ? diff.stdout : ""),
      wall: { files: wallFiles.map((f) => ({ path: String(f.path), sha256: String(f.sha256) })), passed: wallPassed },
      checks,
      not_proven: [],
      verdict, ...(typeof o.implement?.limit_s === "number" ? { implement_limit: { limit_s: o.implement.limit_s, elapsed_s: typeof o.implement.elapsed_s === "number" ? o.implement.elapsed_s : 0 } } : {}), ...(grp.section ? { group: grp.section } : {}),
      ...(str(o.implement?.spec_conflict_reason) !== null
        ? { spec_conflict_reason: sanitizeReason(str(o.implement?.spec_conflict_reason)!) }
        : {}),
      evidence: strs(o.intake?.evidence), ...(o.intake?.preexisting_dirty ? { pre_existing_dirty: Object.keys(o.intake.preexisting_dirty as object) } : {}),
      cost: {
        usd: cost.usd, input_tokens: cost.inputTokens, output_tokens: cost.outputTokens,
        measured_sessions: cost.measuredCount ?? 0, total_sessions: cost.totalCount ?? 0, partial_usd: cost.partialUsd ?? 0,
        ...(cost.unmetered ? { source: "cli-invoker-unmetered" } : {}),
        ...(Array.isArray(o.fix?.fix_rounds) ? { fix_rounds: o.fix.fix_rounds } : {}), // MW-2: engine-recorded per-round fix_resume + cache_read_tokens, never read from a transcript
      },
      time: { wall_s: Object.values(stages).reduce((a, b) => a + (b ?? 0), 0), stages },
      provider: ctx.provider,
      model: ctx.model,
      resumed: o.intake?.resumed === true,
      events_sha256: sha256(existsSync(eventsPath) ? readFileSync(eventsPath) : ""),
      ...(await sealEvidence(ctx.repoDir, ctx.runDir, o, notProven, signal, ctx.emit)),
      log_seal: true,
      ...(routeBlock ? { route: routeBlock } : {}),
      ...(supply.block ? { supply: supply.block } : {}),
    };

    for (const l of sealContract(ctx.repoDir, body, rawDiff, checks, process.env, o.intake?.contract_snapshot as ContractSnapshot | undefined)) notProven.add(l); // D65-SPEC: additive receipt.contract, LOKI_CONTRACT=1 only
    // Sign first so a failed key lands in NOT PROVEN before hashing.
    body.not_proven = [...notProven];
    let hash = receiptSha256(body);
    const sig = signReceipt(ctx.runId, hash);
    if (!sig.jwt) {
      body.not_proven = [...notProven, SIGNING_UNAVAILABLE];
      hash = receiptSha256(body);
    }
    const receipt: Receipt = { ...body, receipt_sha256: hash, verification: { jwt: sig.jwt, kid: sig.kid } };

    mkdirSync(ctx.runDir, { recursive: true });
    const path = join(ctx.runDir, "receipt.json");
    writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n");
    writeFileSync(join(ctx.runDir, "receipt.md"), renderReceiptMd(receipt));

    const signed = sig.jwt !== null;
    const data = { receipt_path: path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven, ...(routeBlock ? { route_line: routePrLine(routeBlock) } : {}) };
    ctx.emit("receipt.sealed", "seal", { path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven, ...(routeBlock ? { route_line: routePrLine(routeBlock) } : {}) });
    return { status: "completed", data: { ...data, summary: `${verdict} receipt ${hash.slice(0, 12)} ${signed ? `SIGNED kid ${sig.kid}` : "UNSIGNED"}` } };
  },
};
export const stage = sealStage;
