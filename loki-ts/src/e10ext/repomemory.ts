// The repo card: what Loki remembers about one repository between runs. Verified facts only, captured by the harness, never a model's summary:
// the setup half of a proof script that Loki's own re-run got past (services, migrations, the product, the first record), the quirks that script
// marks, the environment it exports, and the check commands verify ran green. Every fact carries the commit and the lockfile hash it was verified on.
// Replaces the E-126 verified_command.json memory, which was read into every brief and written by nothing.
//   local copy   ~/.loki/repo-cards/<sha256 of the origin URL, else the path>/card.json   written after every issue run, private, no setup (~/.loki/repos holds run locks)
//   repo copy    .claude/rules/loki-repo-card.md   written only by `loki knowledge export`, for a team to commit; travels with every clone
// When both exist the fact verified on the newer commit wins. A fact verified on other lockfiles is shown "check before trusting", never silently
// trusted; a setup that breaks when a session uses it is dropped at the end of that run. LOKI_REPO_CARD=0 opts out (nothing read, nothing written).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readOriginUrl } from "../util/engine_origin.ts";
import { homeLokiDir } from "../util/paths.ts";
import { redactSecrets } from "../util/redact.ts"; // check commands only; see extractSetup for why a setup is refused, not redacted
import { safeGit } from "../util/safe_git.ts";

export type CardKind = "setup" | "quirk" | "env" | "command";
export interface CardFact { kind: CardKind; key: string; text: string; sha: string; lock: string; commit_time: number; run: string }
export interface RepoCard { v: 1; repo: string; facts: CardFact[] }
export const CARD_FILE = ".claude/rules/loki-repo-card.md", CARD_MIRROR = ".loki/memory/repo-card.md", SETUP_FILE = "loki-setup.sh";
const KIND_ORDER: CardKind[] = ["setup", "quirk", "env", "command"], MAX_SETUP = 12000, MAX_INLINE = 6000, MAX_FACTS = 40;

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
  const fs = sortFacts(card.facts), by = (k: CardKind): CardFact[] => fs.filter((f) => f.kind === k), on = (f: CardFact): string => `verified on ${f.sha.slice(0, 12)}, lockfiles ${f.lock.slice(0, 12) || "none"}`;
  const setup = by("setup")[0];
  const data = JSON.stringify({ v: 1, repo: card.repo, facts: fs.map((f) => (f.kind === "setup" ? { ...f, text: "(the bash block above)" } : f)) }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return [
    "# Repo card", "",
    `What Loki has verified about this repository (${card.repo}) by running it. Written by \`loki knowledge export\`; edit by re-running it, not by hand.`,
    "Each fact names the commit and lockfile hash it was verified on. A fact from other lockfiles is a hint to check, not a rule.", "",
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
    card.facts = card.facts.flatMap((f) => (f.kind !== "setup" ? [f] : code ? [{ ...f, text: code }] : []));
    return card;
  } catch { return null; }
}
export function readRepoCardFile(repoDir: string): RepoCard | null { try { return parseCardFile(readFileSync(join(repoDir, CARD_FILE), "utf8").slice(0, 200_000)); } catch { return null; } }
/** Local and committed copies as one card: per fact, the one verified on the newer commit wins (a tie keeps the local one). */
export function mergedCard(repoDir: string): { card: RepoCard; sources: { local: number; repo_file: number } } {
  const local = readLocalCard(repoDir), file = readRepoCardFile(repoDir), out = new Map<string, CardFact>();
  for (const f of file?.facts ?? []) out.set(`${f.kind}\0${f.key}`, f);
  for (const f of local?.facts ?? []) { const k = `${f.kind}\0${f.key}`, o = out.get(k); if (!o || f.commit_time >= o.commit_time) out.set(k, f); }
  return { card: { v: 1, repo: repoName(repoDir), facts: sortFacts([...out.values()]) }, sources: { local: local?.facts.length ?? 0, repo_file: file?.facts.length ?? 0 } };
}

const REAL_TOKEN = /sk-ant-|github_pat_|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const CHECK_CALL = /(^|[\s;&|({])(loki_http|loki_cmd)\s/;
/** The setup half of a proof script: every line before its first check, with the repository's own path replaced by a variable. Null (with the reason)
 *  when there is nothing reusable: no check to cut at, too little or too much before it, a part bash cannot parse by itself, or a path of this machine. */
export function extractSetup(script: string, repoDir: string): { text: string } | { refused: string } {
  const lines = script.split("\n"), cut = lines.findIndex((l) => !/^\s*#/.test(l) && CHECK_CALL.test(l) && !/^\s*(function\s+)?\w+\s*\(\s*\)/.test(l));
  if (cut < 0) return { refused: "the script calls no check" };
  let head = lines.slice(0, cut); while (head.length && /^\s*(echo\b.*)?$/.test(head[head.length - 1]!)) head.pop(); // a trailing blank or section banner belongs to the checks
  if (head.filter((l) => l.trim() !== "" && !/^\s*#/.test(l)).length < 4) return { refused: "fewer than 4 lines before the first check" };
  let text = head.join("\n");
  const real = (() => { try { return realpathSync(repoDir); } catch { return resolve(repoDir); } })(), names = [...new Set([real, resolve(repoDir), real.replace(/^\/private\//, "/")])].filter((d) => d.length > 5).sort((a, b) => b.length - a.length);
  let swapped = false; for (const d of names) if (text.includes(d)) { text = text.split(d).join("${LOKI_REPO_ROOT}"); swapped = true; }
  if (swapped) { const i = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0; text = `${text.slice(0, i)}LOKI_REPO_ROOT="\${LOKI_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" # the repository root (Loki replaced the path the script was written with)\n${text.slice(i)}`; }
  // The generic redactor is not used here: it blanks the throwaway password and signing secret the script invents for its own empty database, and the recipe
  // then no longer runs. A setup that carries anything shaped like a real provider credential is not stored at all.
  if (REAL_TOKEN.test(text)) return { refused: "it carries something shaped like a real credential" };
  if (text.length > MAX_SETUP) return { refused: `more than ${MAX_SETUP} characters before the first check` };
  if (text.includes(homedir()) || /(^|[\s"'=:])\/(Users|home|private\/var|var\/folders)\//.test(text)) return { refused: "it names a path of this machine" };
  const syn = spawnSync("bash", ["-n"], { input: text, encoding: "utf8", timeout: 10000 });
  if (syn.status !== 0) return { refused: "bash cannot parse the part before the first check by itself" };
  return { text };
}
const coreLines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12 && !l.startsWith("#") && !l.startsWith("LOKI_REPO_ROOT="));
/** True when a proof script carries the stored setup: at least 7 in 10 of its real lines, in the script as written. */
export function usesSetup(script: string, setup: string): boolean {
  const have = new Set(script.split("\n").map((l) => l.trim())), core = coreLines(setup);
  return core.length > 0 && core.filter((l) => have.has(l)).length / core.length >= 0.7;
}

export interface CardUpdate { wrote: boolean; facts: number; setup: "stored" | "kept" | "dropped" | "none"; why?: string; dir: string }
/** After a run: what Loki's own final proof run and verify showed becomes the card. A setup is stored when that run got past it (one check or more
 *  printed a result, which only happens after the setup); it is dropped when the script carried the stored setup, exited non-zero and reached no check.
 *  Passing verify commands replace the stored ones; a stored command verify could not start this time is dropped. Never throws. */
export function updateRepoCard(a: { repoDir: string; runId: string; baseSha?: string; script: string | null; proof: { exit: number | null; proved: number; failed: number; refused?: string } | null; checks: { name: string; cmd: string; result: string }[]; needs: string[] }, env: NodeJS.ProcessEnv = process.env): CardUpdate | null {
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
        facts = [...facts.filter((f) => f.kind === "command"), { kind: "setup", key: "setup", text: ex.text, ...stamp }, ...quirks.map((q, i): CardFact => ({ kind: "quirk", key: `setup-${i + 1}`, text: q, ...stamp })), ...(envText ? [{ kind: "env" as const, key: "env", text: envText, ...stamp }] : [])];
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

/** The always-on sentence that makes a proof script's setup reusable (part of the issue brief only while the card is on). */
export const SETUP_FIRST_LINE = "Lay the proof script out so its setup can be reused: everything that builds the environment (services, migrations, starting the product, the first account or record) comes first, at the top level of the script, before the first loki_http or loki_cmd line. Loki keeps that part as this repository's setup recipe for later runs. Above any setup step that needed a workaround, write one comment line starting `# QUIRK:` that says what fails and what fixes it.";
export interface CardBrief { text: string; record: { facts: number; stale: number; bytes: number; setup_file: boolean; local: number; repo_file: number } }
/** The card for an issue run's brief, and the stored setup written into the session's scratch directory. Null when off or nothing is known. Fixed order,
 *  no timestamps or run ids, so the bytes change only when the card or the lockfiles do. Never throws. */
export function repoCardBrief(repoDir: string, scratchDir: string | null, env: NodeJS.ProcessEnv = process.env): CardBrief | null {
  if (!repoCardOn(env)) return null;
  try {
    const { card, sources } = mergedCard(repoDir); if (!card.facts.length) return null;
    const now = lockHash(repoDir), stale = (f: CardFact): boolean => f.lock !== now, tag = (f: CardFact): string => (stale(f) ? ` (last verified on ${f.sha.slice(0, 12) || "an unknown commit"} with other dependency files: check before trusting)` : ` (verified on ${f.sha.slice(0, 12) || "an earlier run"})`);
    const by = (k: CardKind): CardFact[] => card.facts.filter((f) => f.kind === k), setup = by("setup")[0];
    let setupFile = false;
    if (setup && scratchDir) { try { writeFileSync(join(scratchDir, SETUP_FILE), setup.text + "\n", { mode: 0o600 }); setupFile = true; } catch { setupFile = false; } }
    const text = [
      "What Loki already knows about this repository from earlier runs here (facts Loki verified by running them, not a guess; do not spend time rediscovering them):",
      ...(setup ? [`Setup${tag(setup)}: the setup half of a proof script that Loki's own run got past in this repository. It builds the environment from an empty directory.${setupFile ? ` It is saved at $LOKI_SCRATCH/${SETUP_FILE}.` : ""} Start your loki-proof.sh from it (copy it, then add this task's checks after it) instead of working the setup out again; by itself it stops what it started when it exits. If a step fails on this checkout, fix that step and carry on.${setup.text.length <= MAX_INLINE || !setupFile ? `\n<repo-setup>\n${setup.text}\n</repo-setup>` : ""}`] : []),
      ...(by("quirk").length ? [`Known quirks:\n${by("quirk").map((f) => `- ${f.text}${tag(f)}`).join("\n")}`] : []),
      ...by("env").map((f) => `Environment: ${f.text}${tag(f)}`),
      ...(by("command").length ? [`Check commands that passed in Loki's own verify:\n${by("command").map((f) => `- ${f.text}${tag(f)}`).join("\n")}`] : []),
    ].join("\n");
    return { text, record: { facts: card.facts.length, stale: card.facts.filter(stale).length, bytes: Buffer.byteLength(text), setup_file: setupFile, ...sources } };
  } catch { return null; }
}

/** `loki knowledge export`: writes the merged card to the one committed path. Says when git ignores that path. */
export function exportRepoCard(repoDir: string): { path: string; facts: number; ignored: boolean } | null {
  const { card } = mergedCard(repoDir); if (!card.facts.length) return null;
  const p = join(repoDir, CARD_FILE); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, renderCardFile(card));
  let ignored = false; try { safeGit(repoDir, ["check-ignore", "-q", CARD_FILE]); ignored = true; } catch { ignored = false; }
  return { path: CARD_FILE, facts: card.facts.length, ignored };
}
/** `loki knowledge`: the card as plain lines, each fact with the commit it was verified on and whether the lockfiles still match. */
export function renderCardText(repoDir: string): string {
  const { card, sources } = mergedCard(repoDir), now = lockHash(repoDir);
  if (!card.facts.length) return `Loki knows nothing about ${card.repo} yet. The card is written after an issue run (loki start owner/repo#N) whose proof Loki re-ran itself.\n`;
  const mark = (f: CardFact): string => `[${f.sha.slice(0, 12) || "no commit"}${f.lock === now ? "" : ", lockfiles changed since: check before trusting"}]`;
  const rows = card.facts.map((f) => (f.kind === "setup" ? `  setup    ${mark(f)} ${f.text.split("\n").length} lines; first steps:\n${f.text.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l)).slice(0, 12).map((l) => `             ${l.slice(0, 150)}`).join("\n")}` : `  ${f.kind.padEnd(8)} ${mark(f)} ${f.kind === "command" ? `${f.key}: ` : ""}${f.text.slice(0, 300)}`));
  return [`Repo card for ${card.repo} (${card.facts.length} fact${card.facts.length === 1 ? "" : "s"}; ${sources.local} local, ${sources.repo_file} in ${CARD_FILE})`, ...rows, `  local copy: ${join(cardDir(repoDir), "card.json")}`, `  share it with your team: loki knowledge export (writes ${CARD_FILE} for you to commit)`].join("\n") + "\n";
}
