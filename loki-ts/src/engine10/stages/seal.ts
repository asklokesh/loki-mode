// loki-ts/src/engine10/stages/seal.ts
//
// E-10: commit and Seal (docs/v10/ENGINE.md sections 4, 9). Writes receipt.json
// and receipt.md, computes receipt_sha256, and signs natively with node:crypto Ed25519
// (A-121; no python, no `cryptography`). The key is the A-120 local key, created on first
// use. An empty token means UNSIGNED, never presented as attested.
import { createHash, randomBytes, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RECEIPT_SIGNER_BASENAME } from "../../util/receipt_signer.ts";
import { run } from "../../util/shell.ts";
import { isTestFile } from "../testmap.ts";
import { STAGE_BUDGETS } from "../types.ts";
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
    // A-104/G2: stage all, unstage .loki/, Wall files (sealed under runDir/wall) and a NEW lockfile with no manifest change.
    if ((await git(ctx, ["add", "-A", "--", "."])).code !== 0) return { status: "failed", data: {}, reason: "git add failed" };
    const staged = (await git(ctx, ["diff", "--cached", "--name-status", "--no-renames", "-z"])).out.split("\0").reduce<{ st: string; f: string }[]>((a, t, i, all) => (i % 2 === 0 && t ? [...a, { st: t, f: all[i + 1]! }] : a), []);
    const drop = staged.filter(({ st, f }) => f.startsWith(".loki/") || /(^|\/)loki_wall_[^/]*$/.test(f) || (st === "A" && !staged.some(({ f: m }) => /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod)$/.test(m)) && /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/.test(f)));
    if (drop.length > 0) await git(ctx, ["reset", "-q", "--", ...drop.map(({ f }) => f)]);
    if ((await git(ctx, ["diff", "--cached", "--quiet"])).code === 0) {
      return { status: "completed", data: { committed: false } };
    }
    const title = (str(ctx.outputs().intake?.title) ?? `run ${ctx.runId}`).split("\n")[0]!.slice(0, 72);
    const c = await git(ctx, ["commit", "-q", "-m", `loki: ${title}`, "-m", `Loki-Run: ${ctx.runId}`]);
    if (c.code !== 0) return { status: "failed", data: {}, reason: "git commit failed" };
    return { status: "completed", data: { committed: true, head_sha: (await git(ctx, ["rev-parse", "HEAD"])).out.trim() } };
  },
};

// Stage outputs read by seal. Only keys in the ENGINE.md section 4 table (plus duration_s
// from section 5) are trusted; any other key seal reads puts a "not recorded" entry on
// NOT PROVEN when absent, so a producer cannot silently shape the receipt.
function verdictOf(o: Partial<Record<StageName, Obj>>, checks: ReceiptCheck[], emptyDiff: boolean, verifyNotProven: boolean, wallGreenOnBase: boolean): Verdict {
  const exit = o.implement?.exit;
  if (o.intake?.already_satisfied === true || wallGreenOnBase || exit === "already_done") return "ALREADY_SATISFIED";
  if (exit === "spec_conflict") return "SPEC_CONFLICT";
  // Section 2: an empty diff without the LOKI_ALREADY_DONE marker is FAILED, never VERIFIED.
  if (emptyDiff) return "FAILED";
  if (checks.some((c) => c.result === "fail")) return "FAILED";
  // E-98a B1: verify's own NOT PROVEN (e.g. a system interpreter) downgrades too -- never a silent VERIFIED.
  if (exit === "killed" || checks.length === 0 || checks.some((c) => c.result !== "pass") || verifyNotProven) return "PARTIAL";
  return "VERIFIED";
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
    "",
    "### Checks",
    ...(r.checks.length ? r.checks.map((c) => `- ${c.result}: ${c.name} (\`${c.cmd}\`, ${c.duration_s}s)`) : ["- none"]),
    "",
    ...(r.evidence.length ? ["### Evidence (already-satisfied)", ...r.evidence.map((e) => `- ${e}`), ""] : []),
    "### NOT PROVEN",
    ...r.not_proven.map((n) => `- ${n}`),
    "",
  ].join("\n");
}

export const sealStage: Stage = {
  name: "seal",
  ...STAGE_BUDGETS.seal,
  async run(ctx: RunContext): Promise<StageResult> {
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
    const verdict = verdictOf(o, checks.filter((c) => !(c.result === "fail" && preRedChecks.includes(c.name))), !diffOk || diff.stdout === "", verifyNotProven.length > 0, wallGreenOnBase);

    const notProven = new Set<string>(DEEP_NOT_PROVEN);
    if (wallNotRun > 0) notProven.add(`wall base run not_run: ${wallNotRun}`);
    if (!diffOk) notProven.add("diff not computed (git diff-tree failed)");
    // E-55: any status other than A means the path existed at base_sha (M, D, or T typechange, e.g. a symlink).
    const rawDiff = diffOk ? diff.stdout.split("\0").filter(Boolean) : [];
    for (let i = 0; i + 1 < rawDiff.length; i += 2) {
      if ((rawDiff[i]!.trim().split(" ").pop() ?? "") !== "A" && isTestFile(rawDiff[i + 1]!)) notProven.add(`weakened test: ${rawDiff[i + 1]}`);
    }
    for (const c of checks) if (c.result === "not_run") notProven.add(`not run: ${c.name}`);
    for (const f of strs(o.verify?.flaky)) notProven.add(`flaky test: ${f}`);
    for (const n of verifyNotProven) notProven.add(n);
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
    // ponytail: events.jsonl is supervisor-written and may lag the worker; the supervisor re-hashes at receipt.sealed if exactness matters
    const eventsPath = join(ctx.runDir, "events.jsonl");
    const wallFiles = Array.isArray(o.wall?.files) ? (o.wall.files as { path: string; sha256: string }[]) : [];
    const wallPassed = typeof o.verify?.wall_passed === "boolean" ? o.verify.wall_passed : null;
    if (wallFiles.length > 0 && wallPassed === null) notProven.add("wall result not recorded by verify");

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
      verdict,
      ...(str(o.implement?.spec_conflict_reason) !== null
        ? { spec_conflict_reason: sanitizeReason(str(o.implement?.spec_conflict_reason)!) }
        : {}),
      evidence: strs(o.intake?.evidence),
      cost: {
        usd: cost.usd, input_tokens: cost.inputTokens, output_tokens: cost.outputTokens,
        measured_sessions: cost.measuredCount ?? 0, total_sessions: cost.totalCount ?? 0, partial_usd: cost.partialUsd ?? 0,
      },
      time: { wall_s: Object.values(stages).reduce((a, b) => a + (b ?? 0), 0), stages },
      provider: ctx.provider,
      model: ctx.model,
      resumed: o.intake?.resumed === true,
      events_sha256: sha256(existsSync(eventsPath) ? readFileSync(eventsPath) : ""),
    };

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
    const data = { receipt_path: path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven };
    ctx.emit("receipt.sealed", "seal", { path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven });
    return { status: "completed", data: { ...data, summary: `${verdict} receipt ${hash.slice(0, 12)} ${signed ? `SIGNED kid ${sig.kid}` : "UNSIGNED"}` } };
  },
};
export const stage = sealStage;
