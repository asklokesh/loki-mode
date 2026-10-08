// VPR-2: `loki verify-pr <url|owner/repo#N>`. Verdict is VERIFIED only if a check derived from the linked issue went
// red on the PR base and green on the PR head AND the touched packages' suites passed. All PR code runs through the
// VPR-1 sandbox (scripts/verify-pr-sandbox.sh); the host only fetches with safe_git and reads files. No model call.
// Exit codes align with `loki verify`: 0 VERIFIED, 2 NOT PROVEN because the sandbox was blocked/usage, 4 NOT PROVEN.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseContract } from "../features/contract.ts";
import { fetchIssue } from "../engine10/fetch_issue.ts";
import { extractChecks, judgeF2p, referencedFiles, type SandboxResult } from "../engine10/verify_pr_f2p.ts";
import { REPO_ROOT } from "../util/paths.ts";
import { safeGit, tokenFreeEnv } from "../util/safe_git.ts";

export interface PrRef { repo: string; number: number }
export interface PrMeta { baseSha: string; headSha: string; cloneUrl: string; issueRefs: string[] }
export interface Checkout { baseDir: string; headDir: string; changed: string[] }
export interface IssueInfo { body: string; repo?: string; author?: string; authorAssociation?: string; updatedAt?: string }
export interface PackageSuites { suites: string[]; removed: string[] }
export interface VerifyPrDeps {
  prMeta: (ref: PrRef) => PrMeta;
  issue: (ref: string) => IssueInfo;
  checkout: (ref: PrRef, meta: PrMeta, workDir: string) => Checkout;
  sandbox: (dir: string, cmd: string) => SandboxResult;
  packageSuites: (baseDir: string, headDir: string, changed: readonly string[]) => PackageSuites;
  outDir: string;
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
}
export interface VerifyPrResult {
  verdict: "VERIFIED" | "NOT PROVEN";
  reasons: string[];
  pr: PrRef;
  base: string | null;
  head: string | null;
  checks: string[];
  criteria: number;
  blocked: boolean;
  /** Every linked issue considered: author, association, last edit, and whether it was trusted as a check source. */
  issues: { ref: string; author: string | null; association: string | null; updatedAt: string | null; trusted: boolean }[];
  notes: string[];
}

export const verifyPrEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_VERIFY_PR"] === "1";

/** `https://github.com/o/r/pull/N` or `o/r#N`; anything else is refused. */
export function parsePrRef(s: string): PrRef | null {
  const u = /^https:\/\/github\.com\/([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)\/pull\/(\d+)(?:[/?#].*)?$/.exec(s) ?? /^([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)$/.exec(s);
  if (!u || u[1]!.split("/").some((x) => x.includes(".."))) return null;
  return { repo: u[1]!, number: Number(u[2]) };
}

const sh = (args: string[], env: NodeJS.ProcessEnv): string => execFileSync("gh", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });

/** Issue body plus who wrote it and their association with the repo (the trust signal). */
export function defaultIssue(ref: string, env: NodeJS.ProcessEnv = process.env): IssueInfo {
  const body = fetchIssue(ref).body ?? "";
  const m = /^([^#]+)#(\d+)$/.exec(ref);
  if (!m) return { body };
  try {
    const j = JSON.parse(sh(["issue", "view", m[2]!, "--repo", m[1]!, "--json", "author,authorAssociation,updatedAt"], env)) as { author?: { login?: string }; authorAssociation?: string; updatedAt?: string };
    return { body, repo: m[1]!, author: j.author?.login, authorAssociation: j.authorAssociation, updatedAt: j.updatedAt };
  } catch { return { body, repo: m[1]! }; }
}

export function defaultPrMeta(ref: PrRef, env: NodeJS.ProcessEnv = process.env): PrMeta {
  const j = JSON.parse(sh(["pr", "view", String(ref.number), "--repo", ref.repo, "--json", "baseRefOid,headRefOid,closingIssuesReferences"], env)) as {
    baseRefOid: string; headRefOid: string; closingIssuesReferences?: { number: number; repository?: { name?: string; owner?: { login?: string } } }[];
  };
  const issueRefs = (j.closingIssuesReferences ?? []).map((i) => `${i.repository?.owner?.login ?? ref.repo.split("/")[0]}/${i.repository?.name ?? ref.repo.split("/")[1]}#${i.number}`);
  return { baseSha: j.baseRefOid, headSha: j.headRefOid, cloneUrl: `https://github.com/${ref.repo}.git`, issueRefs };
}

/** Fetch with safe_git into workDir (hooks, fsmonitor, ext:: off, token stripped), then export each tree with `git archive`: no checkout, so no hooks or filters run. */
export function defaultCheckout(ref: PrRef, meta: PrMeta, workDir: string): Checkout {
  const repo = join(workDir, "git");
  mkdirSync(repo, { recursive: true });
  safeGit(repo, ["init", "-q"]);
  safeGit(repo, ["fetch", "-q", "--no-tags", meta.cloneUrl, "+refs/heads/*:refs/remotes/o/*", `+refs/pull/${ref.number}/head:refs/loki/pr`], { stdio: ["ignore", "pipe", "pipe"] });
  const dirs = { baseDir: join(workDir, "base"), headDir: join(workDir, "head") };
  for (const [sha, dir] of [[meta.baseSha, dirs.baseDir], [meta.headSha, dirs.headDir]] as const) {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`bad sha: ${sha}`);
    mkdirSync(dir, { recursive: true });
    const tar = join(workDir, `${sha}.tar`);
    safeGit(repo, ["archive", "--format=tar", "-o", tar, sha]);
    execFileSync("tar", ["-xf", tar, "-C", dir], { stdio: "ignore" });
    rmSync(tar, { force: true });
  }
  const changed = safeGit(repo, ["diff", "--name-only", "-z", meta.baseSha, meta.headSha]).split("\0").filter(Boolean);
  return { ...dirs, changed };
}

/** Real sandbox: scripts/verify-pr-sandbox.sh with a token-free env; its result.json is the only thing read back. Image comes from LOKI_VPR_IMAGE. */
export function defaultSandbox(dir: string, cmd: string, env: NodeJS.ProcessEnv = process.env): SandboxResult {
  const image = env["LOKI_VPR_IMAGE"];
  if (!image) return { status: "BLOCKED", exit_code: null, detail: "LOKI_VPR_IMAGE is not set" };
  const out = mkdtempSync(join(tmpdir(), "loki-vpr-out-"));
  try {
    const r = spawnSync("bash", [join(REPO_ROOT, "scripts/verify-pr-sandbox.sh"), "--repo", dir, "--out", out, "--cmd", cmd, "--image", image], { env: tokenFreeEnv(env), encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    const res = join(out, "result.json");
    if (!existsSync(res)) return { status: r.status === 3 ? "BLOCKED" : "ERROR", exit_code: null, detail: (r.stderr ?? "").trim().slice(0, 200) || `runner rc ${r.status}` };
    const j = JSON.parse(readFileSync(res, "utf8")) as { status?: string; exit_code?: number | null; detail?: string };
    const st = j.status === "COMPLETED" || j.status === "TIMEOUT" || j.status === "BLOCKED" ? j.status : "ERROR";
    return { status: st, exit_code: typeof j.exit_code === "number" ? j.exit_code : null, detail: j.detail };
  } catch (e) {
    return { status: "ERROR", exit_code: null, detail: String(e).slice(0, 200) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const shq = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;

/** Nearest package.json above `file` in `root`: its directory and whether it has a test script. Read as data, never executed on the host. */
function nearestPkg(root: string, file: string): { dir: string; test: boolean } | null {
  let d = dirname(file);
  for (;;) {
    const pj = join(root, d, "package.json");
    if (existsSync(pj)) {
      try { return { dir: d, test: !!(JSON.parse(readFileSync(pj, "utf8")) as { scripts?: Record<string, string> }).scripts?.["test"] }; } catch { return { dir: d, test: false }; }
    }
    if (d === "." || d === "/") return null;
    d = dirname(d);
  }
}

/** Suites come from BOTH trees: a test script present on base but gone on head is reported in `removed`, never silently skipped. */
export function defaultPackageSuites(baseDir: string, headDir: string, changed: readonly string[]): PackageSuites {
  const suites = new Set<string>();
  const removed = new Set<string>();
  for (const f of changed) {
    const b = nearestPkg(baseDir, f);
    const h = nearestPkg(headDir, f);
    if (b?.test && !(h && h.dir === b.dir && h.test)) removed.add(b.dir);
    if (h?.test) suites.add(h.dir === "." ? "npm test --silent" : `cd ${shq(h.dir)} && npm test --silent`);
  }
  return { suites: [...suites], removed: [...removed] };
}

export function judgePr(ref: PrRef, deps: VerifyPrDeps, workDir: string): VerifyPrResult {
  const res: VerifyPrResult = { verdict: "NOT PROVEN", reasons: [], pr: ref, base: null, head: null, checks: [], criteria: 0, blocked: false, issues: [], notes: [] };
  const np = (r: string): VerifyPrResult => ({ ...res, reasons: [...res.reasons, r] });
  const meta = deps.prMeta(ref);
  res.base = meta.baseSha; res.head = meta.headSha;
  if (meta.issueRefs.length === 0) return np("no linked issue: nothing to derive a check from");
  const baseRepo = ref.repo.toLowerCase();
  const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
  const bodies: string[] = [];
  for (const r of meta.issueRefs) {
    const i = deps.issue(r);
    const trusted = (i.repo ?? "").toLowerCase() === baseRepo && TRUSTED.has(i.authorAssociation ?? "");
    res.issues.push({ ref: r, author: i.author ?? null, association: i.authorAssociation ?? null, updatedAt: i.updatedAt ?? null, trusted });
    if (trusted) bodies.push(i.body ?? "");
  }
  if (bodies.length === 0) return np("check from an untrusted issue: the linked issue is not in the PR's repo or its author is not OWNER, MEMBER or COLLABORATOR");
  res.criteria = bodies.reduce((n, b) => n + parseContract(b).criteria.length, 0);
  res.checks = [...new Set(bodies.flatMap(extractChecks))];
  if (res.checks.length === 0) return np("the linked issue defines no runnable check (Check: `cmd` or a loki-check fence)");
  const co = deps.checkout(ref, meta, workDir);
  for (const c of res.checks) {
    const gone = referencedFiles(c, co.baseDir).filter((p) => !existsSync(join(co.headDir, p)));
    if (gone.length > 0) return np(`test removed by the PR: ${gone.join(", ")}`);
  }
  for (const c of res.checks) {
    const o = judgeF2p(c, deps.sandbox(co.baseDir, c), deps.sandbox(co.headDir, c));
    if (!o.ok) return { ...np(o.reason), blocked: o.blocked };
  }
  const ps = deps.packageSuites(co.baseDir, co.headDir, co.changed);
  if (ps.removed.length > 0) return np(`package test script removed by the PR: ${ps.removed.join(", ")}`);
  if (ps.suites.length === 0) res.notes.push("no package suites found");
  for (const s of ps.suites) {
    const r = deps.sandbox(co.headDir, s);
    if (r.status === "BLOCKED") return { ...np(`sandbox blocked on package suite: ${s}`), blocked: true };
    if (r.status !== "COMPLETED" || r.exit_code !== 0) return np(`package suite did not pass (${r.status} ${r.exit_code}): ${s}`);
  }
  return { ...res, verdict: "VERIFIED" };
}

const USAGE = "Usage: loki verify-pr <https://github.com/o/r/pull/N | o/r#N> [--out DIR]\nDerives a check from the PR's linked issue; VERIFIED only if it fails on base, passes on head, and package suites pass.\nPR code runs only in the VPR-1 container sandbox (set LOKI_VPR_IMAGE). Requires LOKI_VERIFY_PR=1.\nExit: 0 verified, 2 usage or sandbox blocked, 4 not proven.\n";

export async function runVerifyPr(args: readonly string[], inject: Partial<VerifyPrDeps> = {}): Promise<number> {
  const env = inject.env ?? process.env;
  const out = inject.out ?? ((s: string) => void process.stdout.write(s));
  const err = inject.err ?? ((s: string) => void process.stderr.write(s));
  if (args.includes("--help") || args.includes("-h")) return (out(USAGE), 0);
  if (!verifyPrEnabled(env)) return (err("loki verify-pr: experimental, set LOKI_VERIFY_PR=1\n"), 2);
  const rest = [...args];
  let outDir = join(process.cwd(), ".loki", "verify-pr");
  const oi = rest.indexOf("--out");
  if (oi >= 0) { outDir = rest[oi + 1] ?? ""; rest.splice(oi, 2); }
  if (rest.length !== 1 || outDir === "") return (err(USAGE), 2);
  const ref = parsePrRef(rest[0]!);
  if (!ref) return (err(`loki verify-pr: not a PR url or owner/repo#N: ${rest[0]}\n`), 2);
  const deps: VerifyPrDeps = {
    prMeta: (r) => defaultPrMeta(r, env), issue: (r) => defaultIssue(r, env), checkout: defaultCheckout,
    sandbox: (d, c) => defaultSandbox(d, c, env), packageSuites: defaultPackageSuites, outDir, env, out, err, ...inject,
  };
  const work = mkdtempSync(join(tmpdir(), "loki-vpr-work-"));
  let result: VerifyPrResult;
  try {
    result = judgePr(ref, deps, work);
  } catch (e) {
    result = { verdict: "NOT PROVEN", reasons: [`could not evaluate the PR: ${String(e).slice(0, 200)}`], pr: ref, base: null, head: null, checks: [], criteria: 0, blocked: false, issues: [], notes: [] };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  mkdirSync(deps.outDir, { recursive: true });
  writeFileSync(join(deps.outDir, "verify-pr-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  out(`pr: ${ref.repo}#${ref.number}\nverdict: ${result.verdict}\n`);
  for (const r of result.reasons) out(`  ${r}\n`);
  for (const n of result.notes) out(`  note: ${n}\n`);
  return result.verdict === "VERIFIED" ? 0 : result.blocked ? 2 : 4;
}
