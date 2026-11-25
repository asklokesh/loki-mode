// `loki issues watch owner/repo`: the always-on form of mass pickup (deploy once, always running).
// One loop, nothing else: keep a service-owned checkout of the repository current, run `loki issues run owner/repo --label L --yes` in it (the same
// command a person runs: it lists the labelled open issues, skips any that already has a Loki pull request, and works the rest, one pull request each),
// sleep, repeat. After each pickup pass it runs `loki address <ref> --post` for every open Loki pull request whose state changed, each in a fresh clone
// (the follow-up pass; `--no-follow-up` turns it off). A container whose command is `issues watch owner/repo` is the whole deployment (docker/Dockerfile's entrypoint is `loki`).
// (New file: issues_run.ts owns one pickup pass; this owns the service lifecycle around it: the checkout, the interval, shutdown.)
// Safe by default: the checkout lives in a directory this command created and marked, and only a marked directory is ever reset; credentials come from
// the environment (GH_TOKEN, ANTHROPIC_API_KEY or a Claude sign-in) and are never placed in a command line; a failed pass is logged and the loop goes on.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SAFE_BUN_FLAGS } from "../runner/worker_proc.ts";
import { safeGit } from "../util/safe_git.ts";
import { lokiRunOfBranch } from "../util/pr_lessons.ts";

const USAGE = "usage: loki issues watch owner/repo [--label L] [--interval SECONDS] [--parallel K] [--limit N] [--dir DIR] [--draft] [--no-follow-up] [--once]\n";
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, MARK = ".loki-watch-owned";
export interface WatchArgs { slug: string; label: string; intervalS: number; parallel: number | null; limit: number | null; dir: string; draft: boolean; once: boolean; followUp: boolean }

/** Parsed arguments, or the reason they are refused. Defaults: label "loki", every 300 seconds, checkouts under LOKI_WATCH_DIR or ~/.loki/watch. */
export function parseWatchArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): WatchArgs | string {
  const a: WatchArgs = { slug: "", label: env["LOKI_WATCH_LABEL"] || "loki", intervalS: 300, parallel: null, limit: null, dir: env["LOKI_WATCH_DIR"] || join(homedir(), ".loki", "watch"), draft: false, once: false, followUp: true };
  const int = (v: string | undefined, min: number, max: number): number | null => { const n = Number(v); return v !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : null; };
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!, val = (): string | undefined => args[++i];
    if (t === "--once") a.once = true;
    else if (t === "--draft") a.draft = true;
    else if (t === "--label") { const v = val(); if (!v || v.startsWith("-") || v.length > 100) return "--label needs a label name"; a.label = v; }
    else if (t === "--dir") { const v = val(); if (!v || v.startsWith("-")) return "--dir needs a directory"; a.dir = resolve(v); }
    else if (t === "--interval") { const n = int(val(), 30, 86400); if (n === null) return "--interval is a whole number of seconds, 30 to 86400"; a.intervalS = n; }
    else if (t === "--parallel") { const n = int(val(), 1, 16); if (n === null) return "--parallel is a whole number, 1 to 16"; a.parallel = n; }
    else if (t === "--limit") { const n = int(val(), 1, 1000); if (n === null) return "--limit is a whole number, 1 to 1000"; a.limit = n; }
    else if (t === "--no-follow-up") a.followUp = false;
    else if (t.startsWith("-")) return `unknown option ${t}`;
    else if (!a.slug && SLUG_RE.test(t)) a.slug = t;
    else return `not an owner/repo: ${t}`;
  }
  return a.slug ? a : "an owner/repo is required";
}

type Sh = (cmd: string, argv: string[], cwd?: string) => { code: number; out: string };
const sh: Sh = (cmd, argv, cwd) => { const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] }); return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }; };

/** Makes the service's own checkout current: clones it once (marking the directory), then on every pass fetches and puts the default branch exactly at
 *  the remote's. A directory without this command's mark is never reset. Returns the checkout path, or the reason it could not be prepared. */
export function prepareCheckout(a: Pick<WatchArgs, "slug" | "dir">, run: Sh = sh): { ok: true; dir: string } | { ok: false; error: string } {
  const dir = join(a.dir, a.slug.replace("/", "__"));
  if (!existsSync(dir)) {
    mkdirSync(a.dir, { recursive: true, mode: 0o700 });
    const c = run("gh", ["repo", "clone", a.slug, dir]); if (c.code !== 0) return { ok: false, error: `could not clone ${a.slug}: ${c.out.slice(-300)}` };
    writeFileSync(join(dir, ".git", MARK), `${a.slug}\n`, { mode: 0o600 });
  }
  let owner = ""; try { owner = readFileSync(join(dir, ".git", MARK), "utf8").trim(); } catch { /* not ours */ }
  if (owner !== a.slug) return { ok: false, error: `${dir} was not created by loki issues watch for ${a.slug}; it is left alone. Pass --dir with an empty directory` };
  const f = run("git", ["-C", dir, "fetch", "--prune", "origin"]); if (f.code !== 0) return { ok: false, error: `git fetch failed: ${f.out.slice(-300)}` };
  const head = run("git", ["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]), branch = head.code === 0 && head.out.startsWith("origin/") ? head.out.slice("origin/".length) : "main";
  const co = run("git", ["-C", dir, "checkout", "-q", "-B", branch, `origin/${branch}`]); if (co.code !== 0) return { ok: false, error: `could not check out ${branch}: ${co.out.slice(-300)}` };
  run("git", ["-C", dir, "reset", "-q", "--hard", `origin/${branch}`]);
  return { ok: true, dir };
}

/** How many passes may try one issue before it is held back (LOKI_WATCH_ATTEMPTS, default 2). An issue with a Loki pull request is skipped by the pass
 *  itself; this stops the other case, an issue whose runs end with no pull request, from being rerun every interval. */
export const maxAttempts = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env["LOKI_WATCH_ATTEMPTS"]); return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 2; };
const ledgerFile = (a: Pick<WatchArgs, "slug" | "dir">): string => join(a.dir, `${a.slug.replace("/", "__")}.attempts.json`);
export function readAttempts(a: Pick<WatchArgs, "slug" | "dir">): Record<string, number> {
  try { const j = JSON.parse(readFileSync(ledgerFile(a), "utf8")) as unknown; return j && typeof j === "object" ? Object.fromEntries(Object.entries(j as Record<string, unknown>).filter(([k, v]) => /^\d+$/.test(k) && Number.isInteger(v)).map(([k, v]) => [k, v as number])) : {}; } catch { return {}; }
}
/** The open issues carrying the label right now (numbers only), or null when gh could not list them. */
export function labelled(a: Pick<WatchArgs, "slug" | "label">, run: Sh = sh): number[] | null {
  const r = run("gh", ["issue", "list", "--repo", a.slug, "--label", a.label, "--state", "open", "--json", "number", "--limit", "200"]); if (r.code !== 0) return null;
  try { const j = JSON.parse(r.out) as unknown; return Array.isArray(j) ? j.map((x) => (x as { number?: unknown }).number).filter((n): n is number => Number.isInteger(n)) : null; } catch { return null; }
}
/** The pass command: the same `loki issues run` a person types, non-interactive. */
export function passArgv(a: WatchArgs): string[] {
  return ["issues", "run", a.slug, "--label", a.label, "--yes", ...(a.parallel !== null ? ["--parallel", String(a.parallel)] : []), ...(a.limit !== null ? ["--limit", String(a.limit)] : []), ...(a.draft ? ["--draft"] : [])];
}

/** FOLLOW-UP: the label PR Steward puts on a pull request it watches. Loki steps aside there: two agents never push to one branch. */
export const STEWARD_LABEL = "claude-pr-steward-watching";
export interface FollowPr { number: number; head: string; oid: string; print: string }
/** The open Loki pull requests of the repository (head branch loki/<run id>, not from a fork), split into the ones to answer and the ones PR Steward
 *  watches. `print` changes when the head, the conversation, the mergeable state or any check changes. Null when gh could not list them. */
export function followUpTargets(a: Pick<WatchArgs, "slug">, run: Sh = sh): { work: FollowPr[]; steward: number[] } | null {
  const r = run("gh", ["pr", "list", "--repo", a.slug, "--state", "open", "--limit", "100", "--json", "number,headRefName,headRefOid,labels,isCrossRepository,updatedAt,mergeable,statusCheckRollup"]);
  if (r.code !== 0) return null;
  let rows: unknown; try { rows = JSON.parse(r.out); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const work: FollowPr[] = [], steward: number[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const n = x["number"], head = String(x["headRefName"] ?? ""), oid = String(x["headRefOid"] ?? "");
    if (!Number.isInteger(n) || x["isCrossRepository"] === true || lokiRunOfBranch(head) === null || !/^[0-9a-f]{40}$/.test(oid)) continue;
    const labels = Array.isArray(x["labels"]) ? (x["labels"] as { name?: unknown }[]).map((l) => String(l?.name ?? "")) : [];
    if (labels.includes(STEWARD_LABEL)) { steward.push(n as number); continue; }
    const checks = Array.isArray(x["statusCheckRollup"]) ? (x["statusCheckRollup"] as Record<string, unknown>[]).map((c) => `${String(c["name"] ?? c["context"] ?? "")}=${String(c["conclusion"] ?? c["state"] ?? c["status"] ?? "")}`).sort().join(";") : "";
    work.push({ number: n as number, head, oid, print: createHash("sha256").update(`${oid}|${String(x["updatedAt"] ?? "")}|${String(x["mergeable"] ?? "")}|${checks}`).digest("hex") });
  }
  return { work, steward };
}
/** The address command for one pull request: the same `loki address` a person types, posting, with the list of comments already judged to ask for
 *  nothing kept outside the clone. */
export function addressArgv(a: Pick<WatchArgs, "slug">, n: number, seenFile: string): string[] { return ["address", `${a.slug}#${n}`, "--post", "--seen", seenFile]; }
/** The exit code `loki address` gives when nothing failed but a comment could not be judged this time (commands/verify_pr.ts runAddress). */
export const ADDRESS_AGAIN = 75;
/** Keep first, delete after: the address replies, every run directory and a bundle of every run branch with commits past the pull request head are
 *  copied beside the clones before a clone goes. True only when every piece was kept. Nothing is ever overwritten (the clone name is random). */
export function keepAddressRecord(clone: string, startOid: string, side: string): boolean {
  let ok = true;
  try {
    mkdirSync(side, { recursive: true, mode: 0o700 });
    if (existsSync(join(clone, ".loki", "address"))) cpSync(join(clone, ".loki", "address"), join(side, "address"), { recursive: true, errorOnExist: true, force: false });
    const runs = join(clone, ".loki", "runs");
    for (const d of existsSync(runs) ? readdirSync(runs, { withFileTypes: true }) : []) {
      if (!d.isDirectory() || !/^e10-[A-Za-z0-9-]+$/.test(d.name)) continue;
      cpSync(join(runs, d.name), join(side, "runs", d.name), { recursive: true, errorOnExist: true, force: false });
      try { if (safeGit(clone, ["rev-list", "--count", `${startOid}..refs/heads/loki/${d.name}`]).trim() !== "0") safeGit(clone, ["bundle", "create", join(side, "runs", d.name, "branch.bundle"), `${startOid}..refs/heads/loki/${d.name}`]); } catch { /* no such branch, or nothing past the head: nothing to bundle */ }
    }
  } catch { ok = false; }
  return ok;
}

export async function runIssuesWatch(args: readonly string[]): Promise<number> {
  const a = parseWatchArgs(args);
  if (typeof a === "string") { process.stderr.write(`loki issues watch: ${a}\n${USAGE}`); return 2; }
  const say = (s: string): void => void process.stdout.write(`loki watch ${new Date().toISOString().slice(0, 19)}Z ${a.slug}: ${s}\n`);
  let stopping = false, child: ReturnType<typeof spawn> | null = null, wake: (() => void) | null = null;
  const stop = (sig: NodeJS.Signals): void => { if (stopping) return; stopping = true; say(`${sig} received, finishing`); child?.kill("SIGINT"); wake?.(); };
  process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
  // In a container the only credential is GH_TOKEN: LOKI_WATCH_SETUP_GIT=1 (set by the deploy manifests, never by default, since it writes the user's
  // git configuration) makes git use gh for https pushes, so the pull request branch can be pushed.
  if (process.env["LOKI_WATCH_SETUP_GIT"] === "1") { const g = sh("gh", ["auth", "setup-git"]); if (g.code !== 0) say(`gh auth setup-git failed: ${g.out.slice(-200)}`); }
  say(`watching for open issues labelled "${a.label}" every ${a.intervalS}s (checkouts under ${a.dir})`);
  say(`board: waiting https://github.com/${a.slug}/issues?q=${encodeURIComponent(`is:issue is:open label:"${a.label}"`)} | safe to merge https://github.com/${a.slug}/pulls?q=${encodeURIComponent('is:pr is:open label:"loki: safe to merge"')} | needs you https://github.com/${a.slug}/pulls?q=${encodeURIComponent('is:pr is:open label:"loki: needs you"')}`);
  const lastPrint = new Map<number, string>(), tries = new Map<number, number>(); // FOLLOW-UP: the state each pull request had when it was last answered, and how often its address failed since; in memory only, so a restart looks at each once more
  for (let pass = 1; !stopping; pass++) {
    const co = prepareCheckout(a);
    if (!co.ok) say(`pass ${pass} skipped: ${co.error}`);
    else {
      const tries = readAttempts(a), cap = maxAttempts(), heldNow = Object.keys(tries).filter((k) => tries[k]! >= cap), open = labelled(a) ?? [];
      const trying = open.filter((n) => !heldNow.includes(String(n)));
      if (heldNow.length) say(`holding back ${heldNow.map((n) => `#${n}`).join(", ")} (tried ${cap} time${cap === 1 ? "" : "s"}; delete ${ledgerFile(a)} to try again)`);
      const code = await new Promise<number>((done) => {
        child = spawn(process.argv[0]!, [...SAFE_BUN_FLAGS, process.argv[1]!, ...passArgv(a)], { cwd: co.dir, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, LOKI_NONINTERACTIVE: "1", LOKI_ISSUES_SKIP: heldNow.join(",") } });
        child.on("error", () => done(1)); child.on("exit", (c) => done(c ?? 1));
      });
      child = null; say(`pass ${pass} ended with exit ${code}`);
      if (trying.length) { for (const n of trying) tries[String(n)] = (tries[String(n)] ?? 0) + 1; try { writeFileSync(ledgerFile(a), JSON.stringify(tries) + "\n", { mode: 0o600 }); } catch { /* the next pass counts again */ } }
    }
    if (a.followUp && !stopping) { // FOLLOW-UP: one `loki address --post` per open Loki pull request whose state changed, each in a fresh clone at the pull request head
      const t = followUpTargets(a);
      if (t === null) say("follow-up skipped: gh could not list the open pull requests");
      else {
        if (t.steward.length) say(`follow-up: ${t.steward.map((n) => `#${n}`).join(", ")} carry the label ${STEWARD_LABEL}; PR Steward owns the fixes there, Loki steps aside`);
        const root = join(a.dir, `${a.slug.replace("/", "__")}.address`);
        for (const p of t.work) {
          if (stopping) break;
          if (lastPrint.get(p.number) === p.print) continue; // nothing changed since Loki last looked
          mkdirSync(root, { recursive: true, mode: 0o700 });
          for (const d of readdirSync(root)) if (new RegExp(`^pr-${p.number}-[0-9a-f]{8}$`).test(d)) rmSync(join(root, d), { recursive: true, force: true }); // at most one clone per pull request: an earlier kept one goes (its record is under kept/) before a new one is made
          const clone = join(root, `pr-${p.number}-${randomBytes(4).toString("hex")}`);
          const c = sh("gh", ["repo", "clone", a.slug, clone, "--", "--quiet", "--depth", "50", "--single-branch", "--branch", p.head]);
          let at = ""; try { at = c.code === 0 ? safeGit(clone, ["rev-parse", "HEAD"]).trim() : ""; } catch { at = ""; }
          if (at !== p.oid) { say(`follow-up #${p.number} skipped: ${c.code !== 0 ? `could not clone ${p.head}: ${c.out.slice(-200)}` : "the pull request head moved"}`); rmSync(clone, { recursive: true, force: true }); continue; }
          const code = await new Promise<number>((done) => {
            child = spawn(process.argv[0]!, [...SAFE_BUN_FLAGS, process.argv[1]!, ...addressArgv(a, p.number, join(root, `pr-${p.number}.seen.json`))], { cwd: clone, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, LOKI_NONINTERACTIVE: "1" } });
            child.on("error", () => done(1)); child.on("exit", (x) => done(x ?? 1));
          });
          child = null;
          let dirty = true; try { dirty = safeGit(clone, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).loki"]).trim() !== ""; } catch { dirty = true; }
          const kept = keepAddressRecord(clone, p.oid, join(root, "kept", basename(clone)));
          const again = code === ADDRESS_AGAIN, failed = code !== 0 && !again, n = (failed || again ? (tries.get(p.number) ?? 0) + 1 : 0);
          if (kept && !failed && !dirty) rmSync(clone, { recursive: true, force: true });
          else say(`follow-up #${p.number}: clone kept at ${clone} (exit ${code}${dirty ? ", uncommitted work" : ""}): its run branches and receipts are there`);
          if (n === 0 || n >= maxAttempts()) { lastPrint.set(p.number, p.print); tries.delete(p.number); } // answered, or tried as often as an issue is: not looked at again until its state changes
          else tries.set(p.number, n);
          say(`follow-up #${p.number} ended with exit ${code}${again ? " (a comment could not be judged; it is looked at again next pass)" : ""}`);
        }
      }
    }
    if (a.once || stopping) break;
    await new Promise<void>((res) => { const t = setTimeout(res, a.intervalS * 1000); wake = () => { clearTimeout(t); res(); }; });
    wake = null;
  }
  say("stopped");
  return 0;
}
