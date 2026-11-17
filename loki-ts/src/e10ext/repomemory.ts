// The repo card: what Loki remembers about one repository between runs. Verified facts only, captured by the harness, never a model's summary:
// the setup half of a proof script that Loki's own re-run got past (services, migrations, the product, the first record), the quirks that script
// marks, the environment it exports, and the check commands verify ran green. Every fact carries the commit and the lockfile hash it was verified on.
// Replaces the E-126 verified_command.json memory, which was read into every brief and written by nothing.
//   local copy   ~/.loki/repo-cards/<sha256 of the origin URL, else the path>/card.json   written after every issue run, private, no setup (~/.loki/repos holds run locks)
//   repo copy    .github/loki-repo-card.md   written only by `loki knowledge export`, for a team to commit; travels with every clone
// When both exist the fact verified on the newer commit wins. A fact verified on other lockfiles is shown "check before trusting", never silently
// trusted; a setup that breaks when a session uses it is dropped at the end of that run. LOKI_REPO_CARD=0 opts out (nothing read, nothing written).
// SETUP CHECK: a setup is verified on the change of the run that wrote it, so it can need something that change carried and a clean checkout lacks. Before
// the next session starts, Loki runs the stored setup on the checkout itself. If it stops, Loki tries each small one-file edit of that earlier change alone
// (kept beside the setup as a `patch` fact, local only) and hands the session the one that gets the setup to its end, as a fact it ran both ways.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readOriginUrl } from "../util/engine_origin.ts";
import { homeLokiDir } from "../util/paths.ts";
import { redactSecrets } from "../util/redact.ts"; // check commands only; see extractSetup for why a setup is refused, not redacted
import { safeGit, safeGitSpawn } from "../util/safe_git.ts";

export type CardKind = "setup" | "quirk" | "env" | "command" | "patch";
export interface CardFact { kind: CardKind; key: string; text: string; sha: string; lock: string; commit_time: number; run: string }
export interface RepoCard { v: 1; repo: string; facts: CardFact[] }
export const CARD_FILE = ".github/loki-repo-card.md", CARD_MIRROR = ".loki/memory/repo-card.md", SETUP_FILE = "loki-setup.sh";
export const SETUP_FIX_FILE = "loki-setup-fix.patch";
const KIND_ORDER: CardKind[] = ["setup", "quirk", "env", "command", "patch"], MAX_SETUP = 12000, MAX_INLINE = 6000, MAX_FACTS = 40, MAX_PATCHES = 4, MAX_PATCH_CHARS = 2500, MAX_PATCH_LINES = 30;
/** A `patch` fact never leaves this machine: it is an earlier run's edit, tried by Loki before a session sees it, and never written to or read from the committed card. */
const shared = (f: CardFact): boolean => f.kind !== "patch";

export const repoCardOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_REPO_CARD"] ?? "").trim());
/** One name for a repository however it was cloned: host/owner/name, lower-case host, no scheme, user or .git. No origin: the absolute path. */
export function repoName(repoDir: string): string {
  const u = (readOriginUrl(repoDir) ?? "").trim();
  if (!u) return resolve(repoDir);
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i.exec(u);
  return m && !u.startsWith("/") ? `${m[1]!.toLowerCase()}/${m[2]}` : u.replace(/\/+$/, "");
}
export const cardDir = (repoDir: string): string => join(homeLokiDir(), "repo-cards", createHash("sha256").update(repoName(repoDir)).digest("hex"));

const LOCK_NAMES = /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|requirements[\w.-]*\.txt|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;
const MANIFEST_NAMES = /^(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?)$/;
/** sha256 over the tracked lockfiles as they are on disk (any directory, up to 40); a repository with none hashes its manifests instead. "" when git
 *  cannot list the tree. A changed dependency set changes it, which is what makes a stored setup worth re-checking. */
export function lockHash(repoDir: string): string {
  let files: string[]; try { files = safeGit(repoDir, ["ls-files"]).split("\n").filter(Boolean); } catch { return ""; }
  const base = (f: string): string => f.slice(f.lastIndexOf("/") + 1), pick = (re: RegExp): string[] => files.filter((f) => re.test(base(f)) && !/(^|\/)(node_modules|vendor)\//.test(f)).sort().slice(0, 40);
  const chosen = pick(LOCK_NAMES).length ? pick(LOCK_NAMES) : pick(MANIFEST_NAMES);
  if (!chosen.length) return "";
  const h = createHash("sha256");
  for (const f of chosen) { let c = ""; try { c = readFileSync(join(repoDir, f), "utf8"); } catch { /* deleted in the working tree: its absence is part of the hash */ } h.update(`${f}\0${c}\0`); }
  return h.digest("hex");
}
const commitTime = (repoDir: string, sha: string): number => { try { return Number(safeGit(repoDir, ["show", "-s", "--format=%ct", sha]).trim()) || 0; } catch { return 0; } };

const isFact = (f: unknown): f is CardFact => { const x = f as CardFact | null; return typeof x === "object" && x !== null && KIND_ORDER.includes(x.kind) && typeof x.key === "string" && typeof x.text === "string" && x.text !== "" && typeof x.sha === "string" && typeof x.lock === "string" && typeof x.commit_time === "number" && typeof x.run === "string"; };
const asCard = (v: unknown): RepoCard | null => { const c = v as RepoCard | null; return typeof c === "object" && c !== null && c.v === 1 && Array.isArray(c.facts) ? { v: 1, repo: typeof c.repo === "string" ? c.repo : "", facts: c.facts.filter(isFact).slice(0, MAX_FACTS) } : null; };
const sortFacts = (fs: CardFact[]): CardFact[] => [...fs].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
/** The local copy. Missing or corrupt reads as null, never a throw. */
export function readLocalCard(repoDir: string): RepoCard | null { try { return asCard(JSON.parse(readFileSync(join(cardDir(repoDir), "card.json"), "utf8"))); } catch { return null; } }
function writeLocalCard(repoDir: string, card: RepoCard): void {
  const dir = cardDir(repoDir), p = join(dir, "card.json"), tmp = `${p}.${process.pid}.tmp`;
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  writeFileSync(tmp, JSON.stringify(card, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, p);
}

/** The card as a page a person can read; the last line carries the same facts for Loki to read back (the setup is taken from its code block). */
export function renderCardFile(card: RepoCard): string {
  const fs = sortFacts(card.facts.filter(shared)), by = (k: CardKind): CardFact[] => fs.filter((f) => f.kind === k), on = (f: CardFact): string => `verified on a change based on ${f.sha.slice(0, 12)}, lockfiles ${f.lock.slice(0, 12) || "none"}`;
  const setup = by("setup")[0];
  const data = JSON.stringify({ v: 1, repo: card.repo, facts: fs.map((f) => (f.kind === "setup" ? { ...f, text: "(the bash block above)" } : f)) }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return [
    "# Repo card", "",
    `What Loki has verified about this repository (${card.repo}) by running it. Written by \`loki knowledge export\`; edit by re-running it, not by hand.`,
    "Each fact names the commit its run started from and the lockfile hash it was verified on. A fact from other lockfiles is a hint to check, not a rule.", "",
    ...(setup ? ["## Setup from an empty directory", "", `The setup half of a proof script that Loki's own run got past (${on(setup)}). It takes one argument, an empty directory, and expects Loki's helper file \`loki-check.sh\` (throwaway PostgreSQL and Redis on free ports).`, "", "```bash", setup.text.replace(/```/g, "` ` `"), "```", ""] : []),
    ...(by("quirk").length ? ["## Known quirks", "", ...by("quirk").map((f) => `- ${f.text} (${on(f)})`), ""] : []),
    ...(by("env").length ? ["## Environment", "", ...by("env").map((f) => `- ${f.text} (${on(f)})`), ""] : []),
    ...(by("command").length ? ["## Check commands that passed", "", ...by("command").map((f) => `- ${f.key}: \`${f.text.replace(/`/g, "'")}\` (${on(f)})`), ""] : []),
    `<!-- loki-repo-card ${data} -->`, "",
  ].join("\n");
}
export function parseCardFile(text: string): RepoCard | null {
  try {
    const m = /<!-- loki-repo-card (\{.*\}) -->/.exec(text); if (!m) return null;
    const card = asCard(JSON.parse(m[1]!)); if (!card) return null;
    const code = /```bash\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "";
    card.facts = card.facts.filter(shared).flatMap((f) => (f.kind !== "setup" ? [{ ...f, text: f.text.slice(0, 400) }] : code && setupRefusal(code) === null ? [{ ...f, text: code }] : [])); // a committed setup passes the same test as a captured one, or is not read
    return card;
  } catch { return null; }
}
export function readRepoCardFile(repoDir: string): RepoCard | null { try { return parseCardFile(readFileSync(join(repoDir, CARD_FILE), "utf8").slice(0, 200_000)); } catch { return null; } }
/** Local and committed copies as one card: per fact, the one verified on the newer commit wins (a tie keeps the local one). */
export function mergedCard(repoDir: string): { card: RepoCard; sources: { local: number; repo_file: number }; fromFile: Set<CardFact> } {
  const local = readLocalCard(repoDir), file = readRepoCardFile(repoDir), out = new Map<string, CardFact>();
  for (const f of file?.facts ?? []) out.set(`${f.kind}\0${f.key}`, f);
  for (const f of local?.facts ?? []) { const k = `${f.kind}\0${f.key}`, o = out.get(k); if (!o || f.commit_time >= o.commit_time) out.set(k, f); }
  const facts = sortFacts([...out.values()]), fileFacts = new Set(file?.facts ?? []);
  return { card: { v: 1, repo: repoName(repoDir), facts }, sources: { local: local?.facts.length ?? 0, repo_file: file?.facts.length ?? 0 }, fromFile: new Set(facts.filter((f) => fileFacts.has(f))) };
}

const REAL_TOKEN = /sk-ant-|github_pat_|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const CHECK_CALL = /(^|[\s;&|({])(loki_http|loki_cmd)\s/;
/** The setup half of a proof script: every line before its first check, with the repository's own path replaced by a variable. Null (with the reason)
 *  when there is nothing reusable: no check to cut at, too little or too much before it, a part bash cannot parse by itself, or a path of this machine. */
export function extractSetup(script: string, repoDir: string): { text: string } | { refused: string } {
  // A script often wraps the check functions in one-line helpers of its own (`chk_http() { loki_http "$@" || FAIL=1; }`) and calls only those: a call of such
  // a helper is a check too. Without this, two of the eight proof scripts sealed in the setup-check measurement had "no check" and left no setup (both FireLater #15).
  const lines = script.split("\n"), DEF = /^\s*(?:function\s+)?(\w+)\s*\(\s*\)/, wraps = lines.flatMap((l) => { const m = DEF.exec(l); return m && !/^(loki_http|loki_cmd)$/.test(m[1]!) && /\b(loki_http|loki_cmd)\b/.test(l.slice(m[0].length)) ? [m[1]!] : []; });
  const call = wraps.length ? new RegExp(`(^|[\\s;&|({])(loki_http|loki_cmd|${wraps.join("|")})\\s`) : CHECK_CALL, cut = lines.findIndex((l) => !/^\s*#/.test(l) && call.test(l) && !DEF.test(l));
  if (cut < 0) return { refused: "the script calls no check" };
  let head = lines.slice(0, cut); while (head.length && /^\s*(echo\b.*)?$/.test(head[head.length - 1]!)) head.pop(); // a trailing blank or section banner belongs to the checks
  if (head.filter((l) => l.trim() !== "" && !/^\s*#/.test(l)).length < 4) return { refused: "fewer than 4 lines before the first check" };
  let text = head.join("\n");
  const real = (() => { try { return realpathSync(repoDir); } catch { return resolve(repoDir); } })(), names = [...new Set([real, resolve(repoDir), real.replace(/^\/private\//, "/")])].filter((d) => d.length > 5).sort((a, b) => b.length - a.length);
  let swapped = false; for (const d of names) if (text.includes(d)) { text = text.split(d).join("${LOKI_REPO_ROOT}"); swapped = true; }
  if (swapped) { const i = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0; text = `${text.slice(0, i)}LOKI_REPO_ROOT="\${LOKI_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" # the repository root (Loki replaced the path the script was written with)\n${text.slice(i)}`; }
  const why = setupRefusal(text);
  return why ? { refused: why } : { text };
}
/** Why a setup text is not kept or not read back, or null. The same test guards what Loki captures and what it reads from a committed card, which a
 *  person or another machine wrote. The generic redactor is not used: it blanks the throwaway password and signing secret a script invents for its own
 *  empty database, and the recipe then no longer runs; a setup that carries anything shaped like a real provider credential is refused whole. */
export function setupRefusal(text: string): string | null {
  if (REAL_TOKEN.test(text)) return "it carries something shaped like a real credential";
  if (text.length > MAX_SETUP) return `more than ${MAX_SETUP} characters before the first check`;
  if (text.includes(homedir()) || /(^|[\s"'=:])\/(Users|home|private\/var|var\/folders)\//.test(text)) return "it names a path of this machine";
  const syn = spawnSync("bash", ["-n"], { input: text, encoding: "utf8", timeout: 10000 });
  return syn.status !== 0 ? "bash cannot parse the part before the first check by itself" : null;
}
const coreLines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12 && !l.startsWith("#") && !l.startsWith("LOKI_REPO_ROOT="));
/** True when a proof script carries the stored setup: at least 7 in 10 of its real lines, in the script as written. */
export function usesSetup(script: string, setup: string): boolean {
  const have = new Set(script.split("\n").map((l) => l.trim())), core = coreLines(setup);
  return core.length > 0 && core.filter((l) => have.has(l)).length / core.length >= 0.7;
}

const NOT_A_FIX = /(^|\/)(__tests__|tests?|spec|e2e|__mocks__|fixtures?|docs?)\/|\.(test|spec)\.[a-z]+$|\.(md|mdx|txt|rst|lock|snap)$|(^|\/)CHANGELOG[^/]*$|^\.loki\//i;
/** The small one-file edits a change made to files that existed before it, smallest first: what a setup verified on that change may rely on. Each is
 *  kept whole as `git diff` printed it, so `git apply` takes it. Tests, documents, lockfiles, a large edit and anything shaped like a credential are left out. */
export function smallEdits(repoDir: string, base: string, head: string): { file: string; diff: string }[] {
  if (!base || !head) return [];
  try {
    const files = safeGit(repoDir, ["diff", "--name-only", "--diff-filter=M", "--no-renames", base, head, "--", "."]).split("\n").filter((f) => f && !NOT_A_FIX.test(f) && !LOCK_NAMES.test(f.slice(f.lastIndexOf("/") + 1))).slice(0, 60);
    const out: { file: string; diff: string; changed: number }[] = [];
    for (const file of files) {
      const d = safeGit(repoDir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--", file]), changed = d.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;
      if (changed > 0 && changed <= MAX_PATCH_LINES && d.length <= MAX_PATCH_CHARS && !REAL_TOKEN.test(d)) out.push({ file, diff: d.endsWith("\n") ? d : `${d}\n`, changed });
    }
    return out.sort((a, b) => a.changed - b.changed || (a.file < b.file ? -1 : 1)).slice(0, MAX_PATCHES).map(({ file, diff }) => ({ file, diff }));
  } catch { return []; }
}

export interface CardUpdate { wrote: boolean; facts: number; setup: "stored" | "kept" | "dropped" | "none"; why?: string; dir: string }
/** After a run: what Loki's own final proof run and verify showed becomes the card. A setup is stored when that run got past it (one check or more
 *  printed a result, which only happens after the setup); it is dropped when the script carried the stored setup, exited non-zero and reached no check.
 *  Passing verify commands replace the stored ones; a stored command verify could not start this time is dropped. Never throws. */
export function updateRepoCard(a: { repoDir: string; runId: string; baseSha?: string; headSha?: string; script: string | null; proof: { exit: number | null; proved: number; failed: number; refused?: string } | null; checks: { name: string; cmd: string; result: string }[]; needs: string[] }, env: NodeJS.ProcessEnv = process.env): CardUpdate | null {
  if (!repoCardOn(env)) return null;
  try {
    const old = readLocalCard(a.repoDir), sha = a.baseSha ?? "", stamp = { sha, lock: lockHash(a.repoDir), commit_time: sha ? commitTime(a.repoDir, sha) : 0, run: a.runId };
    let facts = old?.facts ?? [], setup: CardUpdate["setup"] = facts.some((f) => f.kind === "setup") ? "kept" : "none", why: string | undefined;
    const stored = facts.find((f) => f.kind === "setup");
    if (a.script && a.proof && !a.proof.refused && a.proof.proved > 0) {
      const ex = extractSetup(a.script, a.repoDir);
      if ("text" in ex) {
        const quirks = [...new Set(ex.text.split("\n").flatMap((l) => { const m = /^\s*#\s*QUIRK:\s*(.+)$/.exec(l); return m ? [m[1]!.trim().slice(0, 300)] : []; }))].slice(0, 6);
        const exported = [...new Set([...ex.text.matchAll(/\bexport\s+([A-Z_][A-Z0-9_]*)=/g)].map((m) => m[1]!))].filter((n) => !/^(LOKI_|PG|REDIS_|DATABASE_URL$|PATH$|LANG$|LC_)/.test(n)).slice(0, 20);
        const envText = [a.needs.length ? `Needs: ${a.needs.join(", ")}.` : "", exported.length ? `The setup exports: ${exported.join(", ")}.` : ""].filter(Boolean).join(" ");
        const edits = sha && a.headSha ? smallEdits(a.repoDir, sha, a.headSha) : []; // SETUP CHECK: what this setup may rely on that a clean checkout lacks; tried one at a time before a later session, never shown untried
        facts = [...facts.filter((f) => f.kind === "command"), { kind: "setup", key: "setup", text: ex.text, ...stamp }, ...quirks.map((q, i): CardFact => ({ kind: "quirk", key: `setup-${i + 1}`, text: q, ...stamp })), ...(envText ? [{ kind: "env" as const, key: "env", text: envText, ...stamp }] : []), ...edits.map((e): CardFact => ({ kind: "patch", key: e.file, text: e.diff, ...stamp }))];
        setup = "stored";
      } else why = ex.refused;
    } else if (stored && a.script && a.proof && a.proof.exit !== 0 && a.proof.proved + a.proof.failed === 0 && usesSetup(a.script, stored.text)) {
      facts = facts.filter((f) => f.kind === "command"); setup = "dropped"; why = "a proof script that carried it exited non-zero before any check ran";
    }
    const pass = a.checks.filter((c) => c.result === "pass" && c.cmd && c.cmd.length <= 400).slice(0, 8), notRun = new Set(a.checks.filter((c) => c.result === "not_run").map((c) => c.name));
    if (pass.length || notRun.size) facts = [...facts.filter((f) => f.kind !== "command" || (!notRun.has(f.key) && !pass.some((c) => c.name === f.key))), ...pass.map((c): CardFact => ({ kind: "command", key: c.name.slice(0, 120), text: redactSecrets(c.cmd), ...stamp }))];
    const cmds = facts.filter((f) => f.kind === "command"); if (cmds.length > 8) facts = [...facts.filter((f) => f.kind !== "command"), ...cmds.sort((x, y) => y.commit_time - x.commit_time).slice(0, 8)];
    const card: RepoCard = { v: 1, repo: repoName(a.repoDir), facts: sortFacts(facts) }, dir = cardDir(a.repoDir);
    if (!card.facts.length && !old) return { wrote: false, facts: 0, setup, ...(why ? { why } : {}), dir };
    writeLocalCard(a.repoDir, card);
    try { const m = join(a.repoDir, CARD_MIRROR); mkdirSync(dirname(m), { recursive: true }); writeFileSync(m, renderCardFile(card)); } catch { /* the mirror only feeds the dashboard's Knowledge tab */ }
    return { wrote: true, facts: card.facts.length, setup, ...(why ? { why } : {}), dir };
  } catch { return null; }
}

/** One run of a setup by Loki itself (engine10/proof_rerun.ts runSetupScript): `reached` is true only when the line Loki appended after the setup printed. */
export interface SetupRun { reached: boolean; exit: number | null; seconds: number; tail: string }
/** What Loki found by running the stored setup on this checkout: it ran to its end; it stopped, and one stored one-file edit alone gets it through; or it stopped. */
export interface SetupCheck { result: "pass" | "patch" | "stopped"; seconds: number; trials: number; tail?: string; file?: string; patch?: string }
const TRIAL_BUDGET_S = 120;
const pendingCheck = new Map<string, { setup: string; first: Promise<SetupRun | null> }>(); // runDir -> the plain run of the stored setup, started beside the plan session
const cleanTree = (repoDir: string): boolean => { try { return safeGit(repoDir, ["status", "--porcelain", "--untracked-files=no"]).trim() === ""; } catch { return false; } };
const gitApply = (repoDir: string, patch: string, flags: string[]): boolean => safeGitSpawn(repoDir, ["apply", "--whitespace=nowarn", ...flags], { input: patch, encoding: "utf8", timeout: 20000 }).status === 0;
/** Starts Loki's own run of the stored setup on this checkout and returns at once (the plan stage calls it, so the run costs no wall time). It only reads the
 *  tree. Nothing starts when the card is off, holds no setup, or the checkout already carries uncommitted edits (then it is not the clean checkout the question is about). */
export function startSetupCheck(repoDir: string, runDir: string, run: (setup: string) => Promise<SetupRun>, env: NodeJS.ProcessEnv = process.env): void {
  if (!repoCardOn(env) || pendingCheck.has(runDir)) return;
  try {
    const setup = mergedCard(repoDir).card.facts.find((f) => f.kind === "setup");
    if (setup && cleanTree(repoDir)) pendingCheck.set(runDir, { setup: setup.text, first: run(setup.text).catch(() => null) });
  } catch { /* no check: the brief then says what it said before */ }
}
/** Waits for that run (starting it now when no plan stage did). When the setup stopped with a non-zero exit, tries each stored one-file edit by itself: apply
 *  it, run the setup, take it out again, so the tree is as it was whatever happens. The first edit that gets the setup to its end is the answer; several
 *  edits are never tried together, which keeps an earlier issue's feature code out. Null when nothing was learned (no setup, the run did not finish, or the
 *  script ended itself with exit 0 before the appended line). Never throws. Call it only after the plan and already-done sessions have ended. */
export async function settleSetupCheck(repoDir: string, runDir: string, run: (setup: string) => Promise<SetupRun>, env: NodeJS.ProcessEnv = process.env): Promise<SetupCheck | null> {
  startSetupCheck(repoDir, runDir, run, env);
  const p = pendingCheck.get(runDir); if (!p) return null;
  pendingCheck.delete(runDir);
  try {
    const first = await p.first; if (!first) return null;
    if (first.reached) return { result: "pass", seconds: first.seconds, trials: 0 };
    if (first.exit === null || first.exit === 0) return null;
    let seconds = first.seconds, trials = 0;
    for (const f of (readLocalCard(repoDir)?.facts ?? []).filter((x) => x.kind === "patch").sort((x, y) => x.text.length - y.text.length).slice(0, MAX_PATCHES)) { // smallest edit first
      if (seconds > TRIAL_BUDGET_S || !cleanTree(repoDir)) break;
      if (REAL_TOKEN.test(f.text) || !gitApply(repoDir, f.text, ["--check"])) continue; // the edit no longer applies here (the file moved on, or the checkout already has it)
      const undo = (): void => { if (!gitApply(repoDir, f.text, ["-R"])) safeGitSpawn(repoDir, ["checkout", "--", f.key], { timeout: 20000 }); };
      let r: SetupRun | null = null;
      process.once("exit", undo); // an exit in the middle of a trial still leaves the tree as it was
      try { if (gitApply(repoDir, f.text, [])) { trials++; r = await run(p.setup).catch(() => null); } } finally { undo(); process.off("exit", undo); }
      seconds += r?.seconds ?? 0;
      if (r?.reached && cleanTree(repoDir)) return { result: "patch", seconds, trials, tail: first.tail, file: f.key, patch: f.text };
    }
    return { result: "stopped", seconds, trials, tail: first.tail };
  } catch { return null; }
}

/** A command fact is keyed by its check name, "<runner>:<test path>". False only when that path is named and is not in this checkout. */
const commandFileExists = (repoDir: string, key: string): boolean => { const i = key.indexOf(":"), rel = i > 0 ? key.slice(i + 1) : ""; return !rel || rel.startsWith("/") || rel.split("/").includes("..") || existsSync(join(repoDir, rel)); };
/** The always-on sentence that makes a proof script's setup reusable (part of the issue brief only while the card is on). */
export const SETUP_FIRST_LINE = "Lay the proof script out so its setup can be reused: everything that builds the environment (services, migrations, starting the product, the first account or record) comes first, at the top level of the script, before the first loki_http or loki_cmd line. Loki keeps that part as this repository's setup recipe for later runs. Above any setup step that needed a workaround, write one comment line starting `# QUIRK:` that says what fails and what fixes it.";
export interface CardBrief { text: string; record: { facts: number; stale: number; bytes: number; setup_file: boolean; local: number; repo_file: number; check?: SetupCheck["result"] } }
/** The card for an issue run's brief, and the stored setup written into the session's scratch directory. Null when off or nothing is known. Fixed order,
 *  no timestamps or run ids, so the bytes change only when the card or the lockfiles do. Never throws. */
export function repoCardBrief(repoDir: string, scratchDir: string | null, env: NodeJS.ProcessEnv = process.env, check: SetupCheck | null = null): CardBrief | null {
  if (!repoCardOn(env)) return null;
  try {
    const { card, sources, fromFile } = mergedCard(repoDir);
    card.facts = card.facts.filter((f) => shared(f) && (f.kind !== "command" || commandFileExists(repoDir, f.key))); // a check of a test file this checkout does not have (the earlier run added it and it is not merged) is not shown
    if (!card.facts.length) return null;
    const now = lockHash(repoDir), stale = (f: CardFact): boolean => f.lock !== now, src = (f: CardFact): string => (fromFile.has(f) ? "; from the card committed in this repository, not run on this machine" : ""), tag = (f: CardFact): string => (stale(f) ? ` (last verified on a change based on ${f.sha.slice(0, 12) || "an unknown commit"}, with other dependency files: check before trusting${src(f)})` : ` (verified on a change based on ${f.sha.slice(0, 12) || "an unknown commit"}${src(f)})`);
    const by = (k: CardKind): CardFact[] => card.facts.filter((f) => f.kind === k), setup = by("setup")[0];
    let setupFile = false;
    if (setup && scratchDir) { try { writeFileSync(join(scratchDir, SETUP_FILE), setup.text + "\n", { mode: 0o600 }); setupFile = true; } catch { setupFile = false; } }
    // SETUP CHECK: what Loki's own run of this setup on this checkout showed, in place of "check before trusting". Loki adds no seconds, run ids or directory names of its own to it.
    const tail = check?.tail ? `\n<setup-stopped>\n${redactSecrets(check.tail)}\n</setup-stopped>` : "";
    let fixFile = false; if (setup && check?.result === "patch" && check.patch && scratchDir) { try { writeFileSync(join(scratchDir, SETUP_FIX_FILE), check.patch, { mode: 0o600 }); fixFile = true; } catch { fixFile = false; } }
    const checked = !setup || !check ? [] : check.result === "pass" ? ["Setup check: Loki ran that setup on this checkout before you started and it ran to its end. Use it as it is."]
      : check.result === "patch" && check.patch && check.file ? [`Setup check: Loki ran that setup on this checkout before you started. It stops here without one change and runs to its end with it (Loki ran it both ways, then took the change out again). Without the change it stopped with:${tail}\nThe change is to one file, ${check.file}, as an earlier run in this repository made it.${fixFile ? ` It is saved at $LOKI_SCRATCH/${SETUP_FIX_FILE}: apply it before anything else (git apply "$LOKI_SCRATCH/${SETUP_FIX_FILE}"), or make a better fix for the same failure.` : " Make it before anything else, or make a better fix for the same failure."} Either way it is part of your change, so name it in your report as changed beyond the issue.\n<setup-fix>\n${check.patch.trimEnd()}\n</setup-fix>`]
      : [`Setup check: Loki ran that setup on this checkout before you started and it stopped before its end. It was verified on an earlier run's change, so this checkout lacks something that change had${check.trials ? `; no single small edit of that change got it through (${check.trials} tried)` : ""}. Find what is missing and fix it before you write the rest of the proof. Its last output:${tail}`];
    const text = [
      "What Loki already knows about this repository from earlier runs here (facts Loki verified by running them, not a guess; do not spend time rediscovering them). Each was verified on an earlier run's change, built on the commit it names, so a step can rely on something that change added and this checkout does not have:",
      ...(setup ? [`Setup${tag(setup)}: the setup half of a proof script that Loki's own run got past in this repository. It builds the environment from an empty directory.${setupFile ? ` It is saved at $LOKI_SCRATCH/${SETUP_FILE}.` : ""} Start your loki-proof.sh from it (copy it, then add this task's checks after it) instead of working the setup out again; by itself it stops what it started when it exits. If a step fails on this checkout, fix that step and carry on.${setup.text.length <= MAX_INLINE || !setupFile ? `\n<repo-setup>\n${setup.text}\n</repo-setup>` : ""}`] : []),
      ...checked,
      ...(by("quirk").length ? [`Known quirks:\n${by("quirk").map((f) => `- ${f.text}${tag(f)}`).join("\n")}`] : []),
      ...by("env").map((f) => `Environment: ${f.text}${tag(f)}`),
      ...(by("command").length ? [`Check commands that passed in Loki's own verify:\n${by("command").map((f) => `- ${f.key}: ${f.text}${tag(f)}`).join("\n")}`] : []),
    ].join("\n");
    return { text, record: { facts: card.facts.length, stale: card.facts.filter(stale).length, bytes: Buffer.byteLength(text), setup_file: setupFile, ...sources, ...(checked.length && check ? { check: check.result } : {}) } };
  } catch { return null; }
}

/** `loki knowledge export`: writes the merged card to the one committed path. Says when git ignores that path. */
export function exportRepoCard(repoDir: string): { path: string; facts: number; ignored: boolean } | null {
  const { card } = mergedCard(repoDir); card.facts = card.facts.filter(shared); if (!card.facts.length) return null;
  const p = join(repoDir, CARD_FILE); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, renderCardFile(card));
  let ignored = false; try { safeGit(repoDir, ["check-ignore", "-q", CARD_FILE]); ignored = true; } catch { ignored = false; }
  return { path: CARD_FILE, facts: card.facts.length, ignored };
}
/** `loki knowledge`: the card as plain lines, each fact with the commit it was verified on and whether the lockfiles still match. */
export function renderCardText(repoDir: string): string {
  const { card, sources } = mergedCard(repoDir), now = lockHash(repoDir);
  if (!card.facts.length) return `Loki knows nothing about ${card.repo} yet. The card is written after an issue run (loki start owner/repo#N) whose proof Loki re-ran itself.\n`;
  const mark = (f: CardFact): string => `[${f.sha.slice(0, 12) || "no commit"}${f.lock === now ? "" : ", lockfiles changed since: check before trusting"}]`;
  const rows = card.facts.map((f) => (f.kind === "patch" ? `  patch    ${mark(f)} ${f.key}: ${f.text.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length} changed lines of the run that verified the setup; Loki tries it alone when the setup stops on a clean checkout (never shared)` : f.kind === "setup" ? `  setup    ${mark(f)} ${f.text.split("\n").length} lines; first steps:\n${f.text.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l)).slice(0, 12).map((l) => `             ${l.slice(0, 150)}`).join("\n")}` : `  ${f.kind.padEnd(8)} ${mark(f)} ${f.kind === "command" ? `${f.key}: ` : ""}${f.text.slice(0, 300)}`));
  return [`Repo card for ${card.repo}, each fact with the commit its run was based on (${card.facts.length} fact${card.facts.length === 1 ? "" : "s"}; ${sources.local} local, ${sources.repo_file} in ${CARD_FILE})`, ...rows, `  local copy: ${join(cardDir(repoDir), "card.json")}`, `  share it with your team: loki knowledge export (writes ${CARD_FILE} for you to commit)`].join("\n") + "\n";
}
