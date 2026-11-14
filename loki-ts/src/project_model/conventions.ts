// FC-23 (L0): a package's module system, read with a parser from the JSON its own directory declares (JSONC comments and trailing commas,
// relative "extends"), by key and never by file name. null when the package declares nothing.
import { isOff } from "../council/role_agents.ts";
import { safeGitSpawn } from "../util/safe_git.ts";
import { isTestFile } from "../util/test_file_text.ts";
import { symbolSpans } from "../util/context_pack.ts";
import { loadProjectApi, siteFor } from "./resolve.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { escapeRegex } from "../util/regex_escape.ts";
import { isGeneratedSource } from "../util/check_result.ts";
import { isVendoredOrGenerated } from "./linguist.ts";

export interface PackageConventions {
  moduleSystem: "commonjs" | "esm";
  packageType: string | null; // the manifest "type" key, as written
  tsModule: string | null; // tsconfig compilerOptions.module, lowercased, following relative extends
  runner: string | null; // the Project Model's label for the package's test runner
}

/** JSONC to JSON: string-aware removal of // and block comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i]!, n = text[i + 1];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; }
    else if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
const readJson = (p: string): Record<string, unknown> | null => {
  try { const v = parseJsonc(readFileSync(p, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
};

function moduleOf(file: string, depth = 0): string | null {
  const j = readJson(file);
  if (!j || depth > 4) return null;
  const m = (j.compilerOptions as Record<string, unknown> | undefined)?.module;
  if (typeof m === "string") return m.toLowerCase();
  const ext = typeof j.extends === "string" ? j.extends : null;
  if (!ext || !ext.startsWith(".")) return null;
  const next = join(dirname(file), ext.endsWith(".json") ? ext : `${ext}.json`);
  return existsSync(next) ? moduleOf(next, depth + 1) : null;
}

/** Reads what the package's own JSON files declare, by key and never by file name: a "type" key on a manifest-shaped file (it also has "name"),
 *  and compilerOptions.module on the shortest-named file that declares one. No declaration, no convention (null): the Wall is never told a guess. */
export function readPackageConventions(pkgDir: string, runner: string | null = null): PackageConventions | null {
  let names: string[] = [];
  try { names = readdirSync(pkgDir).filter((f) => f.endsWith(".json")).sort((x, y) => x.length - y.length || x.localeCompare(y)); } catch { return null; }
  let packageType: string | null = null, tsModule: string | null = null;
  for (const n of names) {
    const j = readJson(join(pkgDir, n));
    if (!j) continue;
    if (packageType === null && typeof j.type === "string" && typeof j.name === "string") packageType = j.type;
    if (tsModule === null && j.compilerOptions !== undefined) tsModule = moduleOf(join(pkgDir, n));
  }
  if (packageType === null && tsModule === null) return null;
  const esmType = packageType === "module";
  // node16/nodenext follow the manifest type; commonjs, amd, umd and system emit CommonJS-style output, where import.meta is TS1470.
  const moduleSystem = tsModule === null || tsModule === "node16" || tsModule === "nodenext" ? (esmType ? "esm" : "commonjs") : /^(commonjs|amd|umd|system)$/.test(tsModule) ? "commonjs" : "esm";
  return { moduleSystem, packageType, tsModule, runner };
}

/** The Wall brief paragraph for a package; empty when nothing is declared. */
export function conventionsBrief(c: PackageConventions | null): string {
  if (!c) return "";
  const decl = `manifest type: ${c.packageType ?? "(unset)"}, compiler module: ${c.tsModule ?? "(unset)"}${c.runner ? `, test runner: ${c.runner}` : ""}`;
  return c.moduleSystem === "commonjs"
    ? `Package conventions (${decl}): this package compiles as CommonJS. Never use import.meta or top-level await (TS1470, the package's own tsc rejects them); use __dirname and __filename for paths. In files the package's own compiler processes write import statements (they compile to CommonJS) and never require(): a package lint config commonly forbids require() and runs over your file; use require() only in plain .js or .cjs files.`
    : `Package conventions (${decl}): this package is ES modules. Use import syntax; use import.meta.url for file locations; never use require(), __dirname or __filename.`;
}

export interface ReleaseNoteConvention { kind: string; dir: string; example: string | null; heading?: string }
const newestIn = (abs: string, rel: string, pat: RegExp): string | null => {
  try {
    const f = readdirSync(abs).filter((n) => pat.test(n) && !/^readme/i.test(n)).map((n) => ({ n, t: statSync(join(abs, n)).mtimeMs })).sort((a, b) => b.t - a.t || b.n.localeCompare(a.n))[0];
    return f ? `${rel}/${f.n}` : null;
  } catch { return null; }
};
/** L3: the release-note fragment convention a repo declares, by its own marker and never by guess: changesets (.changeset/config.json), towncrier ([tool.towncrier] or towncrier.toml, its directory key, default newsfragments), scriv-style changelog.d/, newsfragments/, changie (.changes/unreleased), else (CL) a changelog file the contribution guide asks entries for. null when none. */
export function releaseNoteConvention(repoDir: string, env: NodeJS.ProcessEnv = process.env): ReleaseNoteConvention | null {
  const has = (p: string): boolean => existsSync(join(repoDir, p));
  if (has(".changeset/config.json")) return { kind: "changeset", dir: ".changeset", example: newestIn(join(repoDir, ".changeset"), ".changeset", /\.md$/i) };
  for (const cfg of ["towncrier.toml", ".towncrier.toml", "pyproject.toml"]) {
    let t = "";
    try { t = readFileSync(join(repoDir, cfg), "utf8"); } catch { continue; }
    const sec = cfg === "pyproject.toml" ? /\[tool\.towncrier\]([\s\S]*?)(?=\n\[|$)/.exec(t)?.[1] : t.replace(/\n\[[\s\S]*$/, "");
    if (sec === undefined) continue;
    const dir = (/^\s*directory\s*=\s*["']([^"']+)["']/m.exec(sec)?.[1] ?? "newsfragments").replace(/^\.?\/|\/$/g, "");
    return { kind: "towncrier", dir, example: newestIn(join(repoDir, dir), dir, /^[^.].*\.[A-Za-z]+(\.md|\.rst)?$/) };
  }
  for (const [dir, kind] of [[".changes/unreleased", "changie"], ["changelog.d", "changelog.d"], ["newsfragments", "towncrier"]] as const)
    if (has(dir)) return { kind, dir, example: newestIn(join(repoDir, dir), dir, /^[^.]/) };
  return changelogConventionOn(env) ? changelogFileConvention(repoDir) : null;
}

/** CL LOKI_E10_CHANGELOG_CONVENTION (default on, =0 opts out): a single changelog file is a release-note convention when the repo's contribution guide or PR
 *  template asks contributors for an entry and the file has an unreleased section to add it to. The failure: on fresh repos whose CONTRIBUTING or PR checklist
 *  requires "an entry in CHANGELOG.md", the brief named no convention, its fixed rule says to write no documentation, and a reviewer failed the diff for the missing
 *  entry. Nothing fires when the guide says not to touch the changelog, only suggests or leaves it to maintainers, or the file has no unreleased section (a frozen log). */
export const changelogConventionOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_CHANGELOG_CONVENTION);
const GUIDE_DIRS = [".", ".github", "docs", ".github/PULL_REQUEST_TEMPLATE"];
const GUIDE_NAME = /^(?:contributing|pull_request_template)(?:\.(?:md|rst|txt|markdown))?$/i;
const LOG_NAME = /^(?:change_?log|changes|history|news|release[-_]?notes)(?:\.(?:md|rst|txt|markdown))?$/i;
const LOG_WORD = /change\s?-?log|\b(?:changes|history|news)\.(?:md|rst|txt)\b/i; // a file the contributor edits; "release notes" alone is usually a PR-body section
const LOG_FORBID = /\b(?:don'?t|do\s+not|never|must\s+not|should\s+not|shouldn'?t)\b[^.]{0,40}\b(?:update|add|edit|modify|touch|change|write)\b/i;
const LOG_SOFT = /\b(?:optional(?:ly)?|not\s+(?:necessary|needed|required)|no\s+need|suggest(?:ed|s)?|consider|maintainers?|copied|generated|automatic(?:ally)?)\b/i;
const LOG_FROZEN_LOOSE = /no\s+longer\s+(?:being\s+)?(?:actively\s+)?(?:maintained|updated)|\bdeprecated\b|\bnot\s+(?:being\s+)?(?:maintained|updated)\b|releases?\s+page/i; // FS=0: the first CL rule
/** FS LOKI_E10_CHANGELOG_FROZEN_STRICT (default on, =0 opts out): a changelog is frozen only when its head says so in words (no longer maintained or updated, this file
 *  has been or is deprecated, not maintained) or it has no unreleased section (unreleasedSection). The failure: the loose rule matched a bare "Deprecated", so a Keep a
 *  Changelog file with a "### Deprecated" subsection under Unreleased read as frozen and the brief named no convention. */
export const changelogFrozenStrictOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_CHANGELOG_FROZEN_STRICT);
const LOG_FROZEN_STRICT = /no\s+longer\s+(?:being\s+)?(?:actively\s+)?(?:maintained|updated|used)|\b(?:has\s+been|is|was)\s+(?:now\s+)?deprecated\b|\bnot\s+(?:being\s+)?(?:actively\s+)?(?:maintained|updated)\b/i;
const logFrozen = (head: string, env: NodeJS.ProcessEnv = process.env): boolean => (changelogFrozenStrictOn(env) ? LOG_FROZEN_STRICT : LOG_FROZEN_LOOSE).test(head);
const LOG_ASK = /\[\s?\]|\b(?:must|should|please|required?|requires|include[sd]?|add(?:ed|s)?|update[sd]?|record(?:ed)?|entry|entries|row)\b/i;
/** The text of the repo's contribution guides and PR templates (root, .github/, docs/), one string; "" when there are none. */
export function contributionGuides(repoDir: string): string {
  const out: string[] = [];
  for (const d of GUIDE_DIRS) { try { for (const n of readdirSync(join(repoDir, d)).sort()) if (GUIDE_NAME.test(n)) { try { out.push(readFileSync(join(repoDir, d, n), "utf8").slice(0, 60_000)); } catch { /* unreadable */ } } } catch { /* no such dir */ } }
  return out.join("\n\n");
}
/** True when the guide asks for a changelog entry: a clause naming the changelog that asks for it (a checklist box, must, please, add, update, entry ...) and no clause forbidding it. */
export function guideRequiresChangelog(guide: string): boolean {
  const clauses = guide.replace(/\r/g, "").replace(/\n(?!\s*(?:[-*+]\s|\d+[.)]\s|\n|#))/g, " ").split(/(?<=[.!?])\s+|\n+/).filter((c) => LOG_WORD.test(c));
  if (clauses.some((c) => LOG_FORBID.test(c))) return false;
  return clauses.some((c) => !LOG_SOFT.test(c) && LOG_ASK.test(c));
}
/** The unreleased heading of a changelog (markdown heading, underlined rst/setext title, or a bare or linked "Unreleased" title line) and the first entry under it. */
export function unreleasedSection(text: string): { heading: string; entry: string | null } | null {
  const lines = text.split("\n").slice(0, 400);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.length === 0 || l.length > 120 || !/\b(?:unreleased|upcoming)\b/i.test(l)) continue;
    const underlined = /^([=\-~^*+#`])\1{2,}$/.test((lines[i + 1] ?? "").trim());
    if (!/^#{1,6}\s/.test(l) && !underlined && !/^[*_`[(]*(?:unreleased|upcoming)\b/i.test(l)) continue;
    let entry: string | null = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 40) && entry === null; j++) { if (/^#{1,2}\s/.test(lines[j]!.trim())) break; if (/^\s*[-*+]\s+\S/.test(lines[j]!)) entry = lines[j]!.trim().slice(0, 160); }
    return { heading: l.replace(/^#+\s*/, ""), entry };
  }
  return null;
}
/** The changelog-file convention (see changelogConventionOn): the changelog the guide names, else the first root or docs/ changelog with an unreleased section. */
export function changelogFileConvention(repoDir: string): ReleaseNoteConvention | null {
  const guide = contributionGuides(repoDir);
  if (!guide || !guideRequiresChangelog(guide)) return null;
  const files: string[] = [];
  for (const d of [".", "docs"]) { try { for (const n of readdirSync(join(repoDir, d)).sort()) if (LOG_NAME.test(n)) files.push(d === "." ? n : `${d}/${n}`); } catch { /* no such dir */ } }
  const g = guide.toLowerCase(), rank = (f: string): number => (f.includes("/") && g.includes(f.toLowerCase()) ? 0 : g.includes(basename(f).toLowerCase()) ? 1 : 2); // a path the guide writes out, then a bare name it mentions
  for (const f of [...files].sort((a, b) => rank(a) - rank(b))) {
    let t = ""; try { if (!statSync(join(repoDir, f)).isFile()) continue; t = readFileSync(join(repoDir, f), "utf8"); } catch { continue; }
    if (logFrozen(t.split("\n").slice(0, 15).join("\n"))) continue;
    const s = unreleasedSection(t);
    if (s) return { kind: "changelog", dir: f, example: s.entry, heading: s.heading };
  }
  return null;
}
/** The closest named manifest above a file: its directory (repo-relative, "." for the root), name and private flag; null when none within the repo. */
function ownerPackage(repoDir: string, file: string): { dir: string; name: string; private: boolean } | null {
  for (let d = dirname(join(repoDir, file)); d.startsWith(repoDir); d = dirname(d)) {
    const j = readJson(join(d, "package.json")), n = j?.name;
    if (typeof n === "string") return { dir: relative(repoDir, d) || ".", name: n, private: j?.private === true };
    if (d === repoDir) break;
  }
  return null;
}
/** The closest manifest "name" above a file (empty when none within the repo). */
const packageNameFor = (repoDir: string, file: string): string => ownerPackage(repoDir, file)?.name ?? "";
/** TX LOKI_E10_TOWNCRIER_EXAMPLE (default on, =0 opts out): the towncrier brief line names a real fragment (towncrierExample: `<issue>.<type>[.<ext>]` with a declared
 *  type) as its example, or none. The failure: a fresh checkout ties every mtime, so the name tie-break picked the repo's towncrier template (template.rst,
 *  towncrier_template.md.jinja) as the "newest example", and the model wrote no fragment. Off: the newest file of the directory, as before. */
export const towncrierExampleOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_TOWNCRIER_EXAMPLE);
/** CR LOKI_E10_CHANGELOG_REF (default on, =0 opts out): a changelog entry carries the issue or PR reference in the form the repo's existing entries use, with a number the
 *  task gives (never an invented one), and a changeset names the package of the changed files. The brief's changelog line names the form; the pre-delivery self-check
 *  (features/self_review.ts) flags an entry with no reference, a number the task does not give, or a changeset for a package the change does not touch. The failure: on
 *  held-out repos the second review-fail class was changelog entries with no PR or issue reference, or with the wrong package or issue number. */
export const changelogRefOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_CHANGELOG_REF);
const REF_CLASSES: [string, RegExp][] = [
  ["link", /\[#\d+\]\(https?:\/\/[^)\s]+\/(?:pull|issues)\/\d+\)/], ["role", /:(?:pr|pull|issue|gh|ghissue|ghpull|bug):`\d+`/], ["gh", /\bGH-\d+\b/], ["paren", /\(#\d+\)/], ["bare", /(?<![\w/])#\d+\b/],
];
/** The reference form most of a changelog's entries use (at least 3 of the first 40 bullets, and at least half of them), with one example; null when entries carry none. */
export function changelogRefStyle(text: string): { cls: string; example: string } | null {
  const bullets = text.split("\n").filter((l) => /^\s*[-*+]\s+\S/.test(l)).slice(0, 40);
  const hits = bullets.map((b) => { const c = REF_CLASSES.find(([, re]) => re.test(b)); return c ? { cls: c[0], ex: c[1].exec(b)![0] } : null; }).filter((x): x is { cls: string; ex: string } => x !== null);
  if (bullets.length < 3 || hits.length < 3 || hits.length * 2 < bullets.length) return null;
  const n = new Map<string, number>(); for (const h of hits) n.set(h.cls, (n.get(h.cls) ?? 0) + 1);
  const cls = [...n.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  return { cls, example: hits.find((h) => h.cls === cls)!.ex };
}
function refBriefClause(repoDir: string, c: ReleaseNoteConvention): string {
  if (!changelogRefOn()) return "";
  let t = ""; try { t = readFileSync(join(repoDir, c.dir), "utf8"); } catch { return ""; }
  const s = changelogRefStyle(t);
  return s ? `; entries reference the issue or PR like ${s.example}: use the number the task gives in that form, and never invent a number` : "";
}
/** The issue or PR numbers a task names (#123, issues/123, pull/123). */
export const taskNumbers = (task: string): string[] => [...new Set([...task.matchAll(/(?:(?<![\w&])#|\/(?:issues|pull)\/)(\d+)\b/g)].map((m) => m[1]!))];
/** The task's own issue or PR number: one in its first line (the title), or one it introduces as fixes, closes, resolves, issue or PR #N. */
export const taskOwnNumbers = (task: string): string[] => {
  const title = task.split("\n").map((l) => l.trim()).find((l) => l && !/^(<<<|TASK$|Task \(untrusted)/.test(l)) ?? "";
  return [...new Set([...taskNumbers(title), ...[...task.matchAll(/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|issue|pr|pull request)\s*:?\s*#(\d+)\b/gi)].map((m) => m[1]!)])];
};
/** What is wrong with the release note the diff carries (CR): `added` maps each added or changed path to its added lines. Empty when nothing is wrong or CR is off. */
/** CR, deterministic half: removes from `line` every issue or PR reference whose number the task never gives: a markdown link `[#N](url)` (with its parentheses), an
 *  issue or pull URL, `(#N)`, an rst `:pr:`N`` role, `GH-N` and a bare `#N`; then tidies the spaces and empty brackets left behind. Returns the line and the numbers removed. */
export function stripInventedRefs(line: string, allowed: readonly string[]): { line: string; removed: string[] } {
  const removed: string[] = [], keep = (n: string): boolean => allowed.includes(n);
  const drop = (re: RegExp, s: string): string => s.replace(re, (m, n: string) => (keep(n) ? m : (removed.push(n), "")));
  let s = line;
  s = drop(/\s*\(\s*\[#(\d+)\]\([^)\s]*\)\s*\)/g, s);
  s = drop(/\s*\[#(\d+)\]\([^)\s]*\)/g, s);
  s = drop(/\s*\(?\s*https?:\/\/\S+?\/(?:issues|pull)\/(\d+)\b\/?\)?/g, s);
  s = drop(/\s*\(\s*#(\d+)\s*\)/g, s);
  s = drop(/\s*:(?:pr|pull|issue|gh|ghissue|ghpull|bug):`(\d+)`/g, s);
  s = drop(/\s*\bGH-(\d+)\b/g, s);
  s = drop(/\s*(?<![\w/&])#(\d+)\b/g, s);
  if (removed.length) s = s.replace(/\s*(?<![\w\]>])\(\s*[,;]?\s*\)/g, "").replace(/[ \t]+$/, "");
  return { line: s, removed: [...new Set(removed)] };
}
/** CR: rewrites the release note the run added so it cites only numbers the task gives. Only lines absent from the base file (`baseText`, "" for a new fragment) are touched;
 *  the file is rewritten only when something was removed. Returns the numbers removed. No-op with LOKI_E10_CHANGELOG_REF=0. */
export function stripInventedRefsInFile(path: string, baseText: string, task: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!changelogRefOn(env)) return [];
  let text: string; try { text = readFileSync(path, "utf8"); } catch { return []; }
  const base = new Set(baseText.split("\n")), allowed = taskNumbers(task), removed: string[] = [];
  const out = text.split("\n").map((l) => { if (base.has(l)) return l; const r = stripInventedRefs(l, allowed); removed.push(...r.removed); return r.line; });
  if (removed.length) writeFileSync(path, out.join("\n"));
  return [...new Set(removed)];
}
export function releaseNoteProblems(repoDir: string, conv: ReleaseNoteConvention, added: Map<string, string[]>, changed: string[], task: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!changelogRefOn(env)) return [];
  const nums = taskNumbers(task), out: string[] = [];
  const wrongNums = (text: string): string[] => [...text.matchAll(/(?:(?<![\w&])#|GH-|:`|\/(?:issues|pull)\/)(\d+)\b/g)].map((m) => m[1]!).filter((n) => !nums.includes(n));
  if (conv.kind === "changelog") {
    const lines = (added.get(conv.dir) ?? []).filter((l) => /^\s*[-*+]\s+\S/.test(l) || l.trim().length > 0);
    if (lines.length === 0) return out;
    const text = lines.join("\n"), bad = wrongNums(text);
    if (bad.length) out.push(`the entry cites #${bad.join(", #")}, which the task does not give`);
    let style: { cls: string; example: string } | null = null; try { style = changelogRefStyle(readFileSync(join(repoDir, conv.dir), "utf8")); } catch { /* unreadable */ }
    const own = taskOwnNumbers(task); // a number the body only mentions (an older PR) is not this change's reference
    if (style && own.length && !own.some((n) => text.includes(n))) out.push(`the entry has no reference to #${own.join(", #")} in the form the existing entries use (${style.example})`);
  } else if (conv.kind === "changeset") {
    const owners = new Set(changed.filter((f) => !f.startsWith(`${conv.dir}/`)).map((f) => ownerPackage(repoDir, f)?.name).filter((n): n is string => !!n));
    for (const [f, ls] of added) {
      if (!f.startsWith(`${conv.dir}/`) || !f.endsWith(".md")) continue;
      for (const m of ls.join("\n").matchAll(/^\s*["']?(@?[\w./-]+)["']?\s*:\s*(?:patch|minor|major)\b/gm)) if (owners.size && !owners.has(m[1]!)) out.push(`${f} names package ${m[1]}, which the change does not touch (changed: ${[...owners].join(", ")})`);
    }
  } else if (conv.kind === "towncrier") {
    const p = nums.length ? null : towncrierNoNumberPrefix(repoDir, conv.dir, env);
    for (const f of added.keys()) {
      if (!f.startsWith(`${conv.dir}/`)) continue; const n = /^(\d+)\./.exec(basename(f))?.[1]; if (!n || nums.includes(n)) continue;
      out.push(nums.length ? `${f} is numbered ${n}, but the task gives #${nums.join(", #")}` : `${f} is numbered ${n}, a number the task never gives${p ? `; rename it to the orphan form ${conv.dir}/${p}<short-slug>${basename(f).slice(n.length)}` : ""}`); // ON: an invented fragment number
    }
  }
  return out;
}
/** The per-run brief line for a release-note fragment convention, placed after the cache-stable prefix; "" when the repo declares none. A changeset line names the package of the first relevant file. */
export function releaseNoteBrief(repoDir: string, files: string[] = []): string {
  const c = releaseNoteConvention(repoDir);
  if (!c) return "";
  const ex = c.example ? `; newest example: ${c.example}` : "";
  if (c.kind === "changeset") {
    const pkg = files.map((f) => packageNameFor(repoDir, f)).find(Boolean) || packageNameFor(repoDir, "package.json");
    return `Release-note convention (changeset, ${c.dir}/): a user-visible change ships with a new ${c.dir}/<short-kebab-name>.md fragment: front matter with "${pkg || "<package name>"}": patch (minor or major when the task says so), then one line describing the change${ex}.`;
  }
  if (c.kind === "towncrier" && towncrierExampleOn()) { const tx = towncrierExample(repoDir, c.dir); return `Release-note convention (${c.kind}, ${c.dir}/): a user-visible change ships with a new fragment file in ${c.dir}/ named and formatted like the existing ones${tx ? `; newest example: ${tx}` : ""}${orphanBriefClause(repoDir, c.dir)}.`; }
  if (c.kind === "changelog") return `Release-note convention (changelog file, ${c.dir}): the repository's contribution guide asks each user-visible change to add an entry to ${c.dir}; add one entry under its "${c.heading ?? "Unreleased"}" section (in the matching subsection when it has them), formatted and worded like the entries already there${c.example ? `; newest entry: ${c.example}` : ""}${refBriefClause(repoDir, c)}.`;
  return `Release-note convention (${c.kind}, ${c.dir}/): a user-visible change ships with a new fragment file in ${c.dir}/ named and formatted like the existing ones${ex}.`;
}

// ---- release-note fragment writer (LOKI_E10_SCAFFOLD): the deterministic half of the L3 convention line. No model call. ----
/** The task itself says not to touch release notes ("no changelog", "skip the changeset", "do not add a news fragment"). */
export const taskForbidsReleaseNote = (task: string): boolean =>
  /\b(?:no|without|skip|omit|leave\s+out|don'?t\s+(?:add|write|create|touch|update|need)|do\s+not\s+(?:add|write|create|touch|update|need))\b[^.\n]{0,40}\b(?:change\s?logs?|changesets?|release[\s-]+notes?|news\s?fragments?|fragments?)\b/i.test(task);
const FRAGMENT_CODE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp)$/;
const clean = (t: string): string => t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
/** The first meaningful task line as a release-note lead: heading marks, a "Title:" label, a "(#12)" or "(#12 s2)" ref and a trailing period dropped. */
export function fragmentTitle(task: string): string {
  const line = task.split("\n").map((l) => l.trim()).find((l) => l && !/^(<<<|TASK$|Task \(untrusted)/.test(l)) ?? "";
  return clean(line).replace(/^#+\s*/, "").replace(/^(title|issue)\s*:\s*/i, "").replace(/\s*\(#\d+(?:\s+\w+)?\)\s*$/, "").replace(/[.\s]+$/, "").slice(0, 160);
}
const CONV_PREFIX = /^(\w+)(?:\([^)]*\))?!?:\s+/;
/** A title that marks an internal change, which a repo's own release notes leave out: a conventional-commit chore/refactor/ci/build/test/docs/deps/style/revert/release prefix, "Bump ...", "Update dependency ...", "Merge ...", "Revert ...", "Typo". */
export const internalTitle = (title: string): boolean =>
  /^(?:chore|refactor|ci|build|tests?|docs?|style|deps?|dev|ops|revert|wip|release|bump|merge|typo|lint)$/i.test(CONV_PREFIX.exec(title)?.[1] ?? "") || /^(?:bump|update (?:dependency|dependencies)|merge|revert|release|fix typos?|typos?)\b/i.test(title);
const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
/** One sentence of what the run says it changed, from the tail of the implement session's final message; "" when none reads like a maintainer's note.
 *  Markers, code fences, tables, headings, first-person narration, test-status chatter and a sentence that restates the title are all refused. */
export function summaryNote(summary: string, title: string): string {
  const paras = summary.split("\n").filter((l) => !/^\W*LOKI_(?:DONE|ALREADY_DONE|SPEC_CONFLICT)\b/.test(l) && !/^\[sdk-loop/.test(l)).join("\n").split(/\n\s*\n/);
  const tw = words(title);
  for (let i = paras.length - 1; i >= 0; i--) {
    const lines = paras[i]!.split("\n").map((l) => l.trim());
    if (lines.some((l) => /^(```|\||#)/.test(l))) continue;
    const text = clean(lines.map((l) => l.replace(/^(?:[-*+]|\d+[.)])\s+/, "")).join(" ")).replace(/\*\*/g, "");
    for (const s of text.split(/(?<=[.!?])\s+(?=[A-Z`])/)) {
      const t = s.trim().replace(/[.\s]+$/, "");
      if (t.length < 20 || t.length > 220 || !/^[A-Za-z`]/.test(t) || /LOKI_|\/Users\/|\/tmp\/|\/home\//.test(t)) continue;
      if (/^(?:I|I'[a-z]+|Let me|Let's|Now|Done|All\b|The (?:tests?|checks?|build|suite|wall)|Tests?\b|Verified|Ran\b|Note\b|Here|This (?:is|was) (?:done|complete)|Summary|Changes?:)/i.test(t) || /\b(?:tests?|checks?|suite)\b[^.]{0,40}\b(?:pass|passes|passed|green|fail)/i.test(t)) continue;
      const sw = words(t), common = [...sw].filter((w) => tw.has(w)).length;
      if (sw.size === 0 || common / Math.min(sw.size, Math.max(tw.size, 1)) >= 0.8) continue; // restates the title
      return t;
    }
  }
  return "";
}
/** The globs a workspace declares (package.json "workspaces", pnpm-workspace.yaml "packages:"); null when the repo is one package. */
function workspaceGlobs(repoDir: string): string[] | null {
  const w = readJson(join(repoDir, "package.json"))?.workspaces, g: string[] = [];
  if (Array.isArray(w)) g.push(...w.map(String)); else if (w && typeof w === "object" && Array.isArray((w as { packages?: unknown }).packages)) g.push(...((w as { packages: unknown[] }).packages).map(String));
  try {
    const blk = /^packages:[ \t]*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?)*)/m.exec(readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"))?.[1] ?? "";
    for (const m of blk.matchAll(/^[ \t]+-[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/gm)) g.push(m[1]!);
  } catch { /* no pnpm workspace */ }
  return g.length ? g : null;
}
const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/^\.\//, "").replace(/\/$/, "").split("/").map((seg) => seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("/")}$`);
const inWorkspace = (dir: string, globs: string[] | null): boolean =>
  globs === null ? dir === "." : dir !== "." && globs.some((g) => !g.startsWith("!") && globRe(g).test(dir)) && !globs.some((g) => g.startsWith("!") && globRe(g.slice(1)).test(dir));
/** The repo's own binary: the repo-local one first, then the PATH. */
function repoTool(repoDir: string, name: string, rel: string[]): string | null {
  for (const r of rel) if (existsSync(join(repoDir, r))) return join(repoDir, r);
  const p = spawnSync(name, ["--version"], { cwd: repoDir, encoding: "utf8", timeout: 15_000 });
  return p.error || p.status !== 0 ? null : name;
}
const sentence = (t: string, example: string): string => (/[.!?]\s*$/.test(example) || example === "" ? `${t.replace(/[.!?]+$/, "")}.` : t.replace(/[.!?]+$/, ""));
const FEAT = /^(?:feat|feature|add|adds|added|support|allow|introduce|implement)\b/i, FIX = /^(?:fix|fixes|fixed|bug|resolve|correct|handle|prevent|stop|avoid|repair)\b|\b(?:crash|error|regress|incorrect|wrong|broken|fails?)\b/i;

/** LOKI_E10_SCAFFOLD gates the fragment writer. On by default; =0 opts out. */
export const fragmentWriterOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_SCAFFOLD);
/** The one line the receipt and the PR body carry whenever the writer added a fragment, so the write is never silent. */
export const fragmentNoticeLine = (path: string): string => `Loki added ${path} as the release note for this change; delete it if this change needs no release note (LOKI_E10_SCAFFOLD=0 turns this off).`;

/** The towncrier types a repo declares ([[tool.towncrier.type]] directory keys), else towncrier's defaults. */
function towncrierTypes(repoDir: string): string[] {
  const cfg = ["towncrier.toml", ".towncrier.toml", "pyproject.toml"].map((c) => { try { return readFileSync(join(repoDir, c), "utf8"); } catch { return ""; } }).join("\n");
  const types = [...cfg.matchAll(/\[\[tool\.towncrier\.type\]\][^[]*?directory\s*=\s*["'](\w+)["']/g)].map((m) => m[1]!);
  return types.length ? types : ["feature", "bugfix", "doc", "removal", "misc"];
}
/** A real fragment of the repo (name `<issue>.<type>[.<ext>]` or `+<slug>.<type>[.<ext>]` with a declared type), the newest among those with the most common extension; helper files such as _template.rst never count. */
function towncrierExample(repoDir: string, dir: string): string | null {
  const types = towncrierTypes(repoDir);
  try {
    const frags = readdirSync(join(repoDir, dir)).filter((n) => /^\+?[\w-]+\.[a-z]+(?:\.[a-z]+)?$/.test(n) && types.includes(n.split(".")[1]!)).map((n) => ({ n, ext: n.split(".").slice(2).join("."), t: statSync(join(repoDir, dir, n)).mtimeMs }));
    const count = new Map<string, number>(); for (const f of frags) count.set(f.ext, (count.get(f.ext) ?? 0) + 1);
    const top = [...count.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
    const f = frags.filter((x) => x.ext === top).sort((x, y) => y.t - x.t || y.n.localeCompare(x.n))[0];
    return f ? `${dir}/${f.n}` : null;
  } catch { return null; }
}

/** TO LOKI_E10_TOWNCRIER_ORPHAN (default on, =0 opts out): a task with no issue number gets an orphan fragment (`<prefix><slug>.<type>[.<ext>]`) when the repo itself
 *  uses orphans: its towncrier config sets `orphan_prefix`, or any fragment in its directory already starts with the prefix (default "+"). Before, only a newest
 *  example that was itself an orphan counted, so a repo with orphans older than its newest numbered fragment got nothing. A repo with no orphan in use still gets
 *  nothing (the skip reason goes on the receipt, see fragmentTraceOn). */
export const towncrierOrphanOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_TOWNCRIER_ORPHAN);
export function towncrierOrphanPrefix(repoDir: string, dir: string): string | null {
  const cfg = ["towncrier.toml", ".towncrier.toml", "pyproject.toml"].map((c) => { try { return readFileSync(join(repoDir, c), "utf8"); } catch { return ""; } }).join("\n");
  const set = /^\s*orphan_prefix\s*=\s*["']([^"'\s/]+)["']/m.exec(cfg)?.[1];
  if (set) return set;
  const types = towncrierTypes(repoDir);
  try { return readdirSync(join(repoDir, dir)).some((n) => n.startsWith("+") && types.includes(n.split(".")[1] ?? "")) ? "+" : null; } catch { return null; }
}
/** TN LOKI_E10_TOWNCRIER_NEW_ORPHAN (default on, =0 opts out): a fix whose task gives no issue or PR number still ships the towncrier fragment the repo requires, in
 *  towncrier's orphan form (`+<slug>.<type>[.<ext>]`, which towncrier renders without an issue link), even when the repo has no orphan fragment yet; only a config that
 *  disables orphans (`orphan_prefix = ""`) keeps the old skip. The brief's towncrier line and the self-check name that form. The failure: on a repo whose CONTRIBUTING
 *  requires a news fragment named by the PR number, the writer skipped (no number), the model declined to invent one, and review failed the diff for the missing fragment. */
export const towncrierNewOrphanOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_TOWNCRIER_NEW_ORPHAN);
export function towncrierOrphansAllowed(repoDir: string): boolean {
  const cfg = ["towncrier.toml", ".towncrier.toml", "pyproject.toml"].map((c) => { try { return readFileSync(join(repoDir, c), "utf8"); } catch { return ""; } }).join("\n");
  return !/^\s*orphan_prefix\s*=\s*(?:""|'')/m.test(cfg);
}
/** The orphan prefix a towncrier fragment without a number takes: the repo's own (TO), else "+" when TN allows a first orphan; null when neither applies. */
export const towncrierNoNumberPrefix = (repoDir: string, dir: string, env: NodeJS.ProcessEnv = process.env): string | null =>
  (towncrierOrphanOn(env) ? towncrierOrphanPrefix(repoDir, dir) : null) ?? (towncrierNewOrphanOn(env) && towncrierOrphansAllowed(repoDir) ? "+" : null);
/** ON LOKI_E10_ORPHAN_RENAME (default on, =0 opts out): a towncrier fragment the run created under a number the task never gives (the task gives none) is renamed to the
 *  orphan form `<prefix><slug>.<type>[.<ext>]` when the repo already has orphan fragments or sets orphan_prefix; slug from the task title. Otherwise nothing moves and the
 *  self-check flags it for the review turn (releaseNoteProblems). Returns "<old> -> <new>" or null. The failure: a run named its fragment with a number
 *   no input carried. */
export const orphanRenameOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_ORPHAN_RENAME);
export function renameInventedFragment(repoDir: string, conv: ReleaseNoteConvention, f: string, task: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!orphanRenameOn(env) || conv.kind !== "towncrier" || !f.startsWith(`${conv.dir}/`) || taskNumbers(task).length) return null;
  const n = /^(\d+)\./.exec(basename(f))?.[1], p = towncrierOrphanPrefix(repoDir, conv.dir); // the repo's own orphans only
  if (!n || !p) return null;
  const slug = fragmentTitle(task).toLowerCase().replace(/[`'"]/g, "").split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6).join("-") || "change";
  let to = `${conv.dir}/${p}${slug}${basename(f).slice(n.length)}`;
  for (let i = 2; existsSync(join(repoDir, to)); i++) to = `${conv.dir}/${p}${slug}-${i}${basename(f).slice(n.length)}`;
  try { renameSync(join(repoDir, f), join(repoDir, to)); } catch { return null; }
  return `${f} -> ${to}`;
}
/** The towncrier brief clause for a task with no number (TN/TO): the orphan name to use instead of an invented number; "" when neither knob allows one. */
export function orphanBriefClause(repoDir: string, dir: string): string {
  const p = towncrierNoNumberPrefix(repoDir, dir);
  return p ? `; name it with the issue or PR number the task gives; when the task gives none, use towncrier's orphan form ${dir}/${p}<short-slug>.<type> with the same type and extension, and never invent a number` : "";
}
/** TR LOKI_E10_SCAFFOLD_TRACE (default on, =0 opts out): when the repo has a release-note convention but the writer wrote nothing, its reason goes on the receipt
 *  (`release_note_skipped`), so a missing fragment is never silent. The failure: a towncrier repo whose task named no issue number lost its fragment with no record. */
export const fragmentTraceOn = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_SCAFFOLD_TRACE);
/** What the scaffold hook records: the written fragment, the skip reason (TR on, a convention exists), or null. */
export function scaffoldRecord(r: FragmentOutcome, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if ("path" in r) return { ...r };
  return fragmentTraceOn(env) && r.skipped !== NO_CONVENTION && r.skipped !== ALREADY_CARRIES ? { skipped: r.skipped } : null; // nothing missing, nothing to record
}
const NO_CONVENTION = "the repo has no release-note convention", ALREADY_CARRIES = "the change already carries a fragment";
/** The receipt block for a skipped fragment; {} when nothing was skipped or a fragment was written. */
export const releaseNoteSkipBlock = (implement: Record<string, unknown> | undefined): { release_note_skipped?: string } => (typeof implement?.scaffold_skipped === "string" ? { release_note_skipped: implement.scaffold_skipped } : {});

export type FragmentOutcome ={ path: string; kind: string; body: string; validated: "ok" | "unavailable" } | { skipped: string };
/** Which changed files count as code for a fragment: a file that exists at `ref` (the run base, else HEAD) always counts, being a tracked change; a file the run created counts
 *  only when it is not git-ignored and not generated (generated marker or path, or linguist vendored/generated). Untracked generated output never triggers a fragment. */
export function runCode(repoDir: string, files: string[], ref = "HEAD"): string[] {
  const tracked = (f: string): boolean => safeGitSpawn(repoDir, ["cat-file", "-e", `${ref}:${f}`], { timeout: 5000 }).status === 0;
  const ignored = (f: string): boolean => safeGitSpawn(repoDir, ["check-ignore", "-q", "--", f], { timeout: 5000 }).status === 0;
  const head = (f: string): string => { try { return readFileSync(join(repoDir, f), "utf8").slice(0, 4096); } catch { return ""; } };
  return files.filter((f) => tracked(f) || (!ignored(f) && !isGeneratedSource(f, head(f)) && !isVendoredOrGenerated(f, {}, head(f))));
}
/** Writes the release-note fragment the repo's own convention asks for, when the run's diff has none. `files` are the repo-relative paths the run changed
 *  (changedFiles); `summary` is the tail of the implement session's final message. Writes only for a convention this function can follow exactly
 *  (changesets, towncrier) and only from a real example or config; every other case returns the reason it did not. A fragment the repo's own tool rejects is removed again. */
export function writeReleaseNoteFragment(repoDir: string, files: string[], task: string, summary = "", opts: { tools?: boolean; base?: string } = {}): FragmentOutcome {
  const conv = releaseNoteConvention(repoDir);
  if (!conv) return { skipped: NO_CONVENTION };
  const live = files.filter((f) => existsSync(join(repoDir, f)));
  if (live.some((f) => f === conv.dir || (f.startsWith(`${conv.dir}/`) && !/readme|config\.json$|\.toml$/i.test(basename(f))))) return { skipped: ALREADY_CARRIES }; // a changelog-file entry counts too
  if (conv.kind !== "changeset" && conv.kind !== "towncrier") return { skipped: `the ${conv.kind} convention is not written automatically` };
  if (taskForbidsReleaseNote(task)) return { skipped: "the task says no release note" };
  const code = runCode(repoDir, live, opts.base).filter((f) => FRAGMENT_CODE.test(f) && !isTestFile(f) && !f.startsWith(`${conv.dir}/`));
  if (code.length === 0) return { skipped: "no non-test code changed" };
  const example = conv.kind === "towncrier" ? towncrierExample(repoDir, conv.dir) : conv.example;
  const raw = fragmentTitle(task);
  if (internalTitle(raw)) return { skipped: "the title marks an internal change (chore, refactor, ci, docs, deps ...)" };
  const exBody = example ? ((): string => { try { return readFileSync(join(repoDir, example), "utf8"); } catch { return ""; } })() : "";
  const title = CONV_PREFIX.test(exBody.replace(/^---[\s\S]*?\n---\s*/, "").trimStart()) ? raw : raw.replace(CONV_PREFIX, ""), note = summaryNote(summary, title); // a conventional prefix stays only where the repo's own fragments carry one
  const lead = title.length >= 12 ? title : note;
  if (!lead) return { skipped: "no usable title or summary for a body" };
  const body = lead === title && note ? `${lead}. ${note}` : lead;
  const exText = exBody;
  const dir = join(repoDir, conv.dir), slug = title.toLowerCase().replace(/[`'"]/g, "").split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6).join("-") || "change";
  try { const root = realpathSync(repoDir), real = realpathSync(dir); if (real !== root && !real.startsWith(root + sep)) return { skipped: "the fragment directory resolves outside the repo" }; } catch { return { skipped: "the fragment directory cannot be resolved" }; } // a "../x" directory key or a symlinked directory never receives a write
  let rel: string, text: string;
  if (conv.kind === "changeset") {
    let cfg: { ignore?: unknown } = {};
    try { cfg = (parseJsonc(readFileSync(join(dir, "config.json"), "utf8")) ?? {}) as { ignore?: unknown }; } catch { /* default config */ }
    const ignore = Array.isArray(cfg.ignore) ? cfg.ignore.map(String) : [], globs = workspaceGlobs(repoDir), names = new Set<string>();
    for (const f of code) { const p = ownerPackage(repoDir, f); if (p && !p.private && !ignore.some((g) => g === p.name || (g.includes("*") && new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(p.name))) && inWorkspace(p.dir, globs)) names.add(p.name); }
    if (names.size === 0) return { skipped: "no changed file belongs to a public workspace package" };
    const q = /^---\s*\n\s*(["'])/.exec(exText)?.[1] ?? '"', bump = FEAT.test(raw) ? "minor" : "patch";
    let n = `${slug}.md`; for (let i = 2; existsSync(join(dir, n)); i++) n = `${slug}-${i}.md`;
    rel = `${conv.dir}/${n}`; text = `---\n${[...names].sort().map((p) => `${q}${p}${q}: ${bump}`).join("\n")}\n---\n\n${sentence(body, exText.replace(/^---[\s\S]*?\n---\s*/, ""))}\n`;
  } else {
    if (!example) return { skipped: "towncrier: no existing fragment to take the naming from" };
    const parts = basename(example).split("."), op = towncrierNoNumberPrefix(repoDir, conv.dir), orphan = parts[0]!.startsWith("+") || op !== null; // TO, then TN
    const issue = /(?:^|[\s(])#(\d+)\b/.exec(task)?.[1];
    if (!issue && !orphan) return { skipped: "towncrier: the task names no issue number and the repo does not use orphan fragments" };
    const prefix = op ?? "+";
    const known = towncrierTypes(repoDir);
    const kind = FEAT.test(raw) ? known.find((t) => /feat/.test(t)) : FIX.test(raw) ? known.find((t) => /bug|fix/.test(t)) : undefined;
    if (!kind) return { skipped: "towncrier: the change type is not clear from the task" };
    const ext = parts.length >= 3 ? `.${parts[parts.length - 1]}` : "";
    const n = `${issue ?? `${prefix}${slug}`}.${kind}${ext}`;
    if (existsSync(join(dir, n))) return { skipped: "towncrier: a fragment with this name exists" };
    rel = `${conv.dir}/${n}`; text = `${sentence(body, exText)}\n`;
  }
  writeFileSync(join(repoDir, rel), text);
  // The repo's own tool judges it when present: a rejected fragment is removed (the model's own would have failed the same check). An absent or erroring tool never blocks the write.
  let validated: "ok" | "unavailable" = "unavailable";
  if (opts.tools !== false) {
    if (conv.kind === "changeset") {
      const t = repoTool(repoDir, "changeset", ["node_modules/.bin/changeset"]);
      if (t) {
        const r = spawnSync(t, ["status"], { cwd: repoDir, encoding: "utf8", timeout: 60_000 }), out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        if (r.status === 0) validated = "ok";
        else if (/not in the workspace|could not parse changeset|invalid version type/i.test(out)) { rmSync(join(repoDir, rel), { force: true }); return { skipped: `changeset status rejected the fragment: ${clean(out).slice(0, 160)}` }; }
      }
    } else {
      const t = repoTool(repoDir, "towncrier", [".venv/bin/towncrier", "venv/bin/towncrier", "node_modules/.bin/towncrier"]);
      if (t) {
        const r = spawnSync(t, ["build", "--draft", "--version", "0.0.0"], { cwd: repoDir, encoding: "utf8", timeout: 60_000 });
        if (r.status === 0) { if (clean(r.stdout ?? "").includes(clean(text).slice(0, 25))) validated = "ok"; else { rmSync(join(repoDir, rel), { force: true }); return { skipped: "towncrier build --draft did not render the fragment" }; } }
      }
    }
  }
  return { path: rel, kind: conv.kind, body: clean(text.replace(/^---[\s\S]*?\n---\s*/, "")), validated };
}

/** A generated Wall file the package's own compiler would reject (import.meta under CommonJS); null when it is fine. Comments and strings are ignored. */
export function conventionViolation(c: PackageConventions | null, fileName: string, content: string): string | null {
  if (!c || c.moduleSystem !== "commonjs" || !/\.[cm]?[jt]sx?$/.test(fileName) || /\.m[jt]s$/.test(fileName)) return null;
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  return /\bimport\.meta\b/.test(code) ? "import.meta is not allowed in a CommonJS package (TS1470)" : null;
}

/** FC-WALL-OUT-OF-REPO-TARGET: a test that locates the code under test through the user home (an installed copy) instead of the repo. Flags a home-derived value (homedir, Path.home, expanduser, $HOME, ~/) that is joined into an import/require/source/spawn/exec target or a dot-directory path, outside expect/assert lines. A quoted absolute home literal (/Users, /home, /root, C:\\Users) that is itself the target of a from/import/require/source line is also flagged; plain string literals are not. Lines from the first HOME assignment on are sandboxed and not flagged. Comments ignored; null when clean. */
export function outOfRepoTarget(content: string): string | null {
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/(^|\s)#.*$/gm, "$1");
  const lines = code.split("\n"), at = lines.findIndex((l) => /\bprocess\.env\.(HOME|USERPROFILE)\s*=(?!=)|\benv\[\s*["'](HOME|USERPROFILE)["']\s*\]\s*=(?!=)|^\s*(export\s+)?(HOME|USERPROFILE)=|\bexport\s+(HOME|USERPROFILE)\b|\bsetenv\(\s*["'](HOME|USERPROFILE)["']|\benv\s*:\s*\{[^}]*\b(HOME|USERPROFILE)\s*:|\bpatch\.dict\([^)]*["'](HOME|USERPROFILE)["']/.test(l)); // the exemption starts at the HOME assignment
  const home = /\bhomedir\s*\(|\bPath\.home\s*\(|\bexpanduser\s*\(|\$\{?HOME\b|\$\{?USERPROFILE\b|\bprocess\.env\.(HOME|USERPROFILE)\b|["'`]~\//;
  const HOMELIT = String.raw`(?:file:\/\/)?(?:\/(?:Users|home|root)\/|[A-Za-z]:\\+Users\\)`;
  const literalTarget = new RegExp(String.raw`\b(?:from|import|require)\s*\(?\s*["'`+"`"+String.raw`]${HOMELIT}|^\s*(?:source|\.)\s+["']?${HOMELIT}`);
  const locates = /["'`\/]\.[A-Za-z][\w-]*(?:[\/"'`]|$)|\b(?:import|require|source|spawn\w*|exec\w*|pathToFileURL|readFile\w*)\b/;
  for (const line of lines.slice(0, at < 0 ? lines.length : at)) {
    if (/^\s*(?:await\s+)?(?:expect|assert\w*)\b/.test(line)) continue;
    if ((home.test(line) && locates.test(line)) || literalTarget.test(line)) return "resolves the code under test outside the repo via a home-directory path; target repo-relative paths (relative to this test file or the repo root) so the check exercises the change";
  }
  return null;
}

/** A Wall test that reads a dotenv file (.env, .env.example, .env.local, ...) by literal path. The implementer's sandbox denies every tool access to those files, so the check could never be satisfied from
 *  the implementer's side and its assertion would end as a harness-owned conflict; the author is asked to assert on the config source (schema, loader) instead. Writes, temp dirs and expect/assert lines are ignored. */
export function dotenvFileRead(content: string): string | null {
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/(^|\s)#.*$/gm, "$1");
  for (const line of code.split("\n")) {
    if (/^\s*(?:await\s+)?(?:expect|assert\w*)\b|\b(?:write\w*|mkdtemp\w*|tmpdir|rm\w*|unlink\w*|touch)\b/.test(line)) continue;
    const m = /["'`](?:[^"'`\n]*\/)?(\.env(?:\.[\w.-]+)?)["'`]/.exec(line);
    if (m) return `reads ${m[1]}, which the implementer's sandbox blocks (dotenv files are denied to every tool), so the check cannot be satisfied; assert on the code that defines or loads the variables (the env schema or config module) instead of the dotenv file`;
  }
  return null;
}

/** Go: true when the file has Test funcs, every body is empty or only t.Log/t.Skip calls, and nothing in the file can fail a test. Linear brace scan, no backtracking regex over the body. */
function goVacuous(code: string): boolean {
  if (/\b\w+\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow|Run)\b/.test(code)) return false;
  const head = /func\s+(?:Test|Fuzz)\w*\(\s*\w+\s+\*testing\.[TF]\s*\)\s*\{/g, trivialStmt = /^\w+\.(?:Log|Logf|Skip|Skipf|SkipNow)\(.*\)$/;
  let m: RegExpExecArray | null, n = 0;
  while ((m = head.exec(code))) {
    let d = 1, i = head.lastIndex, q = "";
    for (; i < code.length && d > 0; i++) { const c = code[i]!; if (q) { if (c === "\\" && q !== "`") i++; else if (c === q) q = ""; } else if (c === '"' || c === "'" || c === "`") q = c; else if (c === "{") d++; else if (c === "}") d--; }
    if (d > 0) return false;
    const body = code.slice(head.lastIndex, i - 1);
    if (/[{}]/.test(body.replace(/"(?:\\.|[^"\\\n])*"|`[^`]*`|'(?:\\.|[^'\\\n])*'/g, ""))) return false;
    if (!body.split(/[\n;]/).map((x) => x.trim()).filter(Boolean).every((x) => trivialStmt.test(x))) return false;
    head.lastIndex = i; n++;
  }
  return n > 0;
}

/** One lexical pass over Go source, in source order: comments are blanked and each string, raw string and rune literal is replaced by a numbered placeholder (`"\u0001N"`), so a comment marker inside a string, or a quote inside a comment, can never be misread. */
function goLex(src: string): { masked: string; strs: string[] } {
  const strs: string[] = []; let out = "", i = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2), end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; }
    else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1; while (j < src.length && src[j] !== c && (c === "`" || src[j] !== "\n")) j += c !== "`" && src[j] === "\\" ? 2 : 1;
      out += c === "'" ? "0" : `"\u0001${strs.push(src.slice(i + 1, j))}"`;
      i = j + 1;
    } else { out += c; i++; }
  }
  return { masked: out, strs };
}
const goClose = (t: string, at: number): number => { const o = t[at]!, c = o === "(" ? ")" : o === "[" ? "]" : "}"; let d = 0; for (let j = at; j < t.length; j++) { if (t[j] === o) d++; else if (t[j] === c && --d === 0) return j; } return -1; };
/** Names declared by one Go parameter, result or type-parameter list: in the named form a lone entry shares the type that follows (`a, b int`), in the unnamed form every entry is a type. */
function goGroupNames(list: string): string[] {
  const segs: string[] = []; let d = 0, cur = "";
  for (const ch of list) { if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) d--; if (ch === "," && d === 0) { segs.push(cur); cur = ""; } else cur += ch; }
  segs.push(cur);
  const toks = segs.map((s) => s.trim().split(/\s+/).filter(Boolean)), named = toks.some((t) => t.length >= 2);
  return toks.flatMap((t) => (named || t.length >= 2) && /^[A-Za-z_]\w*$/.test(t[0] ?? "") ? [t[0]!] : []);
}
/** Go: a Test or Fuzz file with a package clause that never references the package under test. An external `package x_test` must import the package it tests and use it (a dot import of that package is not judged); a same-package test must use an identifier it does not itself declare (its imports, parameters and results, type parameters, locals, var/const names, fields and keywords excluded; with a dot import present only lowercase names count, since a dot import brings in exported names only). Comments and string/rune literals are removed in one pass first. Files without a package clause or a Test/Fuzz func are not judged. */
function goUnreferenced(src: string, goPkgPath?: string, goTestedPath?: string): boolean {
  const { masked, strs } = goLex(src), code = masked.replace(/"\u0001\d+"/g, '""');
  const pkg = /^\s*package\s+(\w+)/m.exec(code);
  if (!pkg || !/\bfunc\s+(?:Test|Fuzz)\w*\s*\(/.test(code)) return false;
  const specs: { alias: string; path: string }[] = [];
  for (const d of masked.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)|^[ \t]*import[ \t]+([^\n(]*)$/gm)) for (const l of (d[1] ?? d[2] ?? "").split("\n")) { const m = /^[ \t]*(?:([\w.]+)[ \t]+)?"\u0001(\d+)"[ \t;]*$/.exec(l); if (m) specs.push({ alias: m[1] ?? "", path: strs[Number(m[2]) - 1]! }); }
  const lastOf = (p: string): string => { const parts = p.split("/"); let l = parts.pop()!; if (/^v\d+$/.test(l) && parts.length) l = parts.pop()!; return l.replace(/\.v\d+$/i, ""); }; // x/v2 and x.v3 both name x
  const rawLast = (p: string): string => p.split("/").pop()!; // v1 in k8s.io/api/core/v1 is the identifier a file writes
  const norm = (l: string): string => l.toLowerCase().replace(/[^a-z0-9_]/g, "");
  const body = code.replace(/^\s*import\s*\([\s\S]*?\)/gm, " ").replace(/^\s*import\b.*$/gm, " ");
  const dots = specs.filter((s) => s.alias === ".");
  // A black-box test package (a tests/ directory of only _test.go files) tests the package the task changes: importing THAT package and calling it qualified is a reference. Any other import, of the same module or not, is not.
  if (goTestedPath && specs.some((s) => s.alias !== "_" && s.alias !== "." && s.path === goTestedPath && new RegExp(String.raw`(?<![\w.])${s.alias || lastOf(s.path)}\s*\.\s*[A-Za-z_]`).test(body))) return false;
  if (pkg[1]!.endsWith("_test")) {
    const x = pkg[1]!.slice(0, -5), nameOf = (p: string): string => { const parts = p.split("/"); let l = parts.pop()!; if (/^v\d+$/.test(l) && parts.length) l = parts.pop()!; return norm(l); }; // no .vN strip: gopkg.in/yaml.v3 is not package yaml
    const named = (p: string): boolean => goPkgPath !== undefined ? p === goPkgPath || (p.startsWith(goPkgPath + "/") && /^v\d+$/.test(p.slice(goPkgPath.length + 1))) : nameOf(p) === x; // the package under test is identified by its import path (module path plus the Wall's directory, plus an optional /vN) when known; the name match is only for an unknown path, since a go-x or x-go name also names an unrelated dependency
    const mine = specs.filter((s) => s.alias !== "_" && (named(s.path) || (goPkgPath === undefined && s.alias === x)));
    if (mine.some((s) => s.alias === ".")) return false;
    return !mine.some((s) => { const nm = s.alias || x; return new RegExp(String.raw`(?<![\w.])${nm}\s*\.\s*[A-Za-z_]`).test(body); });
  }
  const own = new Set<string>(["_", pkg[1]!, "true", "false", "nil", "iota"]);
  for (const w of "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr append cap clear close complex copy delete imag len make max min new panic print println real recover".split(" ")) own.add(w);
  for (const s of specs) if (s.alias !== ".") { own.add(s.alias && s.alias !== "_" ? s.alias : norm(lastOf(s.path)) || lastOf(s.path)); const l = lastOf(s.path), r = rawLast(s.path); own.add(l.replace(/[^\w]/g, "")); own.add(norm(l.replace(/^go-|-go$|\.go$/gi, ""))); own.add(r.replace(/[^\w]/g, "")); own.add(l.replace(/^go-|-go$|\.go$/gi, "").replace(/[^\w]/g, "")); }
  const names = (t: string): string[] => t.match(/[A-Za-z_]\w*/g) ?? [];
  for (const m of body.matchAll(/\b(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g)) own.add(m[1]!);
  for (const m of body.matchAll(/\b(?:var|const)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/g)) names(m[1]!).forEach((n) => own.add(n));
  for (const m of body.matchAll(/^\s*(?:var|const)\s*\(([\s\S]*?)\n\s*\)/gm)) for (const l of m[1]!.split("\n")) { const d = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/.exec(l); if (d) names(d[1]!).forEach((n) => own.add(n)); }
  for (const m of body.matchAll(/([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=/g)) names(m[1]!).forEach((n) => own.add(n));
  for (const m of body.matchAll(/^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+[\w*\[\]{}.]+\s*$/gm)) names(m[1]!).forEach((n) => own.add(n)); // struct field declarations
  for (const m of body.matchAll(/(?:^|[{,])\s*([A-Za-z_]\w*)\s*:(?!=)/gm)) own.add(m[1]!); // keyed literal fields and labels
  const bracket = (at: number): number => { let j = at; while (/\s/.test(body[j] ?? "")) j++; if (body[j] === "[") { const e = goClose(body, j); if (e > 0) { goGroupNames(body.slice(j + 1, e)).forEach((n) => own.add(n)); return e + 1; } } return at; }; // type parameters
  for (const m of body.matchAll(/\btype\s+[A-Za-z_]\w*/g)) bracket(m.index! + m[0].length);
  for (const m of body.matchAll(/\bfunc\b/g)) {
    let j = m.index! + 4; while (/\s/.test(body[j] ?? "")) j++;
    const grab = (at: number): number => { const e = goClose(body, at); if (e < 0) return body.length; goGroupNames(body.slice(at + 1, e)).forEach((n) => own.add(n)); return e + 1; };
    if (body[j] === "(") {
      let k = grab(j); while (/\s/.test(body[k] ?? "")) k++;
      if (/[A-Za-z_]/.test(body[k] ?? "")) { const nm = /^[A-Za-z_]\w*/.exec(body.slice(k))![0]; k = bracket(k + nm.length); while (/\s/.test(body[k] ?? "")) k++; if (body[k] === "(") k = grab(k); } // receiver, name, params
      while (/\s/.test(body[k] ?? "")) k++; if (body[k] === "(") grab(k); // results
    } else if (/[A-Za-z_]/.test(body[j] ?? "")) {
      const nm = /^[A-Za-z_]\w*/.exec(body.slice(j))![0]; let k = bracket(j + nm.length); while (/\s/.test(body[k] ?? "")) k++;
      if (body[k] === "(") { k = grab(k); while (/\s/.test(body[k] ?? "")) k++; if (body[k] === "(") grab(k); }
    }
  }
  const lowerOnly = dots.length > 0;
  for (const m of body.matchAll(/(?<![\w.])([A-Za-z_]\w*)/g)) if (!own.has(m[1]!) && !(lowerOnly && /^[A-Z]/.test(m[1]!))) return false;
  return true;
}

/** TEN-MOAT-26: a generated Wall file that asserts nothing: its only assertions are tautologies (expect(true).toBe(true), assert True), its tests have empty bodies, or a shell file holds only true / exit 0 / ":". Such a file can never fail, so it proves nothing about the change. A JS/Python file with no tautology and no assertion but real calls is NOT flagged (it can still be red by throwing); a file that holds a tautology and no real assertion is flagged even if it also calls code. Go is judged per file: flagged only when every Test func body is empty or only t.Log/t.Skip and nothing can fail a test. Comments are ignored. Returns the reason, or null when the file is acceptable or its language is not recognised. */
export function vacuousCheck(fileName: string, content: string, goPkgPath?: string, goTestedPath?: string): string | null {
  const reason = "asserts nothing (no assertion, or only an always-true one such as true or exit 0); write a check that fails when the behavior is absent";
  const strip = (re: RegExp): string => content.replace(/\/\*[\s\S]*?\*\//g, "").replace(re, "$1");
  if (/\.[cm]?[jt]sx?$/.test(fileName)) {
    const code = strip(/(^|[^:])\/\/.*$/gm);
    const lit = String.raw`(?:true|false|null|undefined|\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*')`;
    const taut = new RegExp(String.raw`\b(?:expect\(\s*(${lit})\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)|expect\(\s*(?:true|[1-9]\d*|"[^"\n]+"|'[^'\n]+')\s*\)\s*\.\s*(?:toBeTruthy|toBeDefined)\(\s*\)|expect\(\s*false\s*\)\s*\.\s*toBeFalsy\(\s*\)|(?:assert|assert\.ok|assert\.equal|assert\.strictEqual)\(\s*(?:true|1|(${lit})\s*,\s*\2)\s*\))`);
    const tautAll = new RegExp(taut.source, "g"); // judged per assertion: a tautology is removed and what remains on the line must still hold a real assertion
    const real = code.split("\n").some((l) => /\b(?:expect|assert\w*|should|fail)\s*[(.]|\bt\.(?:is|true|ok|equal|deepEqual|throws)\b|\bthrow\b/.test(l.replace(tautAll, "")));
    return !real && (code.split("\n").some((l) => taut.test(l)) || /(?:=>|function\s*\([^)]*\))\s*\{\s*\}\s*\)/.test(code)) ? reason : null;
  }
  if (/\.py$/.test(fileName)) {
    const code = strip(/(^|\s)#.*$/gm);
    const pylit = String.raw`(?:True|[1-9]\d*|"[^"\n]+"|'[^'\n]+')`;
    const wrap = (x: string): string => String.raw`(?:\(\s*)*${x}(?:\s*\))*`; // CCR-06: a rendered `assert (True)` or `assert (1) == (1)` is the same tautology; each starts with a literal paren so there is no ambiguity
    const PYTAUT0 = new RegExp(String.raw`^(?:assert(?:\s+|(?=\())(?:${wrap(pylit)}|${wrap("([1-9]\\d*)")}\s*==\s*${wrap("\\1")})(?:\s*,.*)?|(?:self\.)?assertTrue\(\s*${wrap(pylit)}\s*\)|(?:self\.)?assertEqual\(\s*${wrap("(" + pylit + ")")}\s*,\s*${wrap("\\2")}\s*\))$`);
    const PYTAUT = { test: (l: string): boolean => PYTAUT0.test(l.trim()) }; // lines are trimmed first so no pattern carries adjacent whitespace quantifiers (quadratic on a near-miss)
    const real = code.split("\n").some((l) => /\bassert\b|\bself\.assert\w*\(|\bpytest\.(?:raises|fail)\b|\braise\b|\bfail\(/.test(l) && !PYTAUT.test(l));
    return !real && (code.split("\n").some((l) => PYTAUT.test(l)) || /def\s+test\w*\([^)]*\):\s*(?:pass|\.\.\.)\s*$/m.test(code)) ? reason : null;
  }
  if (/\.(?:sh|bash)$/.test(fileName)) {
    const lines = strip(/(^|\s)#.*$/gm).split("\n").map((l) => l.trim()).filter((l) => l && !/^set\s+-/.test(l));
    const tok = String.raw`(?:"[^"$\x60\\\n]*"|'[^'\n]*'|[^\s"'$\x60\\|&;<>(){}*?~-][^\s"'$\x60\\|&;<>(){}*?]*)`; // one quoted or bare literal word: no expansion, glob, redirect or option
    const trivial = new RegExp(String.raw`^(?:true|:|exit\s+0|return\s+0|(?:/usr)?/bin/true|(?:echo|printf)(?:\s+${tok})*|test\s+(?:[1-9]\d*|${tok})|\[\[?\s+(?:[1-9]\d*|${tok})\s+\]\]?)$`);
    return lines.length === 0 || lines.every((l) => l.split(/&&|\|\||;/).map((x) => x.trim()).every((x) => x === "" || trivial.test(x))) ? reason : null;
  }
  if (/_test\.go$/.test(fileName)) return goVacuous(strip(/(^|[^:])\/\/.*$/gm)) ? reason : goUnreferenced(content, goPkgPath, goTestedPath) ? "never references the package under test (an external _test package must import and use it; a same-package test must use an identifier the package declares outside this file); write a check that calls the changed code" : null;
  return null;
}

// Rust source with comments, string and char literals blanked (same length is not kept; only call shapes are read afterwards).
const rustCode = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, "").replace(/r(#*)"[\s\S]*?"\1/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\\n])'/g, "' '");
/** Top-level comma-separated items between the "(" ending at `open` and its matching ")"; null when unbalanced or holding a closure or turbofish (commas there are not argument separators). */
function rustItems(code: string, open: number): string[] | null {
  let depth = 0, cur = ""; const items: string[] = [];
  for (let k = open; k < code.length; k++) {
    const c = code[k]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) { if (cur.trim()) items.push(cur.trim()); return items.some((x) => x.includes("|") || x.includes("::<")) ? null : items; } depth--; }
    else if (c === "," && depth === 0) { items.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  return null;
}
const RUST_SKIP_DIRS = new Set(["target", "tests", "benches", "examples", ".git", ".loki", "node_modules"]);
/** Argument counts of the crate's own associated functions and methods ("Type.fn" to {n: count without the self receiver, self: whether it takes one}), read from non-test .rs files. A name defined twice with different shapes is left out (unknown). */
export interface RustArity { n: number; self: boolean }
export function rustArities(repoDir: string, maxFiles = 200): Map<string, RustArity> {
  const out = new Map<string, RustArity>(), clash = new Set<string>(), files: string[] = [];
  const walk = (d: string, depth: number): void => { if (depth > 6 || files.length >= maxFiles) return; let names: string[] = []; try { names = readdirSync(d); } catch { return; } for (const n of names) { const f = join(d, n); if (RUST_SKIP_DIRS.has(n)) continue; if (n.endsWith(".rs")) files.push(f); else if (!n.includes(".")) walk(f, depth + 1); } };
  walk(repoDir, 0);
  for (const f of files) {
    let src = ""; try { src = readFileSync(f, "utf8"); } catch { continue; } if (src.length > 256_000) continue;
    const code = rustCode(src), starts = [0]; for (let k = 0; k < code.length; k++) if (code[k] === "\n") starts.push(k + 1);
    for (const sp of symbolSpans(f, code)) {
      const parts = sp.name.split("."); if (parts.length !== 2 || sp.container) continue;
      const at = starts[sp.start - 1] ?? 0, m = new RegExp(`\\bfn\\s+${parts[1]}\\b[^(]*\\(`).exec(code.slice(at, at + 2000)); if (!m) continue;
      const items = rustItems(code, at + m.index + m[0].length); if (!items) continue;
      const own = items.filter((x) => !/^(?:&\s*(?:'\w+\s+)?)?(?:mut\s+)?self\b/.test(x)), key = `${parts[0]}.${parts[1]}`, shape = { n: own.length, self: own.length < items.length }, prev = out.get(key);
      if (prev && (prev.n !== shape.n || prev.self !== shape.self)) clash.add(key); else out.set(key, shape);
    }
  }
  for (const k of clash) out.delete(k);
  return out;
}
/** A Rust Wall file that calls `Type::f(...)` with an argument count the crate's own `fn f` in `impl Type` does not take (a method called in the explicit form `Type::f(&mut x, ...)` counts its receiver): Rust has no overloading, so the file cannot compile. Callers pass the arities of the code as implement left it. A function the task text names (`Type::f` or `fn f`) is skipped. Null when nothing clashes or nothing is known. */
export function rustCallClash(repoDir: string, fileName: string, content: string, task: string, arities: Map<string, RustArity> = rustArities(repoDir)): string | null {
  if (!fileName.endsWith(".rs") || arities.size === 0) return null;
  const code = rustCode(content);
  for (const m of code.matchAll(/\b([A-Z]\w*)::([a-z_]\w*)\s*\(/g)) {
    const want = arities.get(`${m[1]}.${m[2]}`); if (want === undefined) continue;
    if (new RegExp(`\\b${m[1]}::${m[2]}\\b|\\bfn\\s+${m[2]}\\b`).test(task)) continue;
    const got = rustItems(code, m.index! + m[0].length)?.length;
    if (got !== undefined && got !== want.n && !(want.self && got === want.n + 1)) return `calls ${m[1]}::${m[2]} with ${got} argument(s) but the crate defines it with ${want.n}${want.self ? " plus self" : ""}; Rust has no overloading, so this file cannot compile`;
  }
  return null;
}

/** The shared re-ask text for files rejected by the out-of-repo checks (Wall and the implement repro test): the lead says what to rewrite, then each rejected name with its reason. */
export const outOfRepoReask = (lead: string, bad: { name: string; why: string }[]): string => [`${lead} Each was rejected:\n${bad.map((b) => `- ${b.name}: ${b.why}`).join("\n")}`, `Point every reference at the repository code with repo-relative paths (for example join(import.meta.dir, "..", "<repo path>") or the equivalent for this runner). Do not read the home directory, $HOME or an environment variable that falls back to one. Write nothing else.`].join("\n\n");

/** TEN-QUALITY-44: the changed test-like files (repo-relative names) that fail outOfRepoTarget. */
export const outOfRepoTests = (repoDir: string, changed: string[]): { name: string; why: string }[] => changed.filter((f) => /(^|[\/._-])(test|spec)s?[\/._-]|_test\./i.test(f) && existsSync(join(repoDir, f))).flatMap((name) => { const why = outOfRepoTarget(readFileSync(join(repoDir, name), "utf8")); return why ? [{ name, why }] : []; });

/** The package root verify runs a test file in. A known project model is trusted fully (its package cwd, else the repo root). Without one, the nearest directory at or above the test dir holding a manifest-shaped JSON file (a string "name" plus another key, by shape and never by file name, as readPackageConventions does); config files (compiler, linter, test-runner) are never roots, so they cannot hide a real phantom. No manifest file name is hardcoded (L0). */
function nearestPackageRoot(testDir: string, repoDir: string, fileName: string): string {
  const api = loadProjectApi(repoDir);
  if (api) return siteFor(api, repoDir, relative(repoDir, join(testDir, fileName)))?.cwd ?? repoDir;
  const shaped = (d: string): boolean => { try { return readdirSync(d).some((f) => { if (!f.endsWith(".json")) return false; const j = readJson(join(d, f)); return !!j && typeof j.name === "string" && Object.keys(j).length > 1; }); } catch { return false; } };
  let pkg = testDir; while (pkg !== repoDir && pkg !== dirname(pkg) && !shaped(pkg)) pkg = dirname(pkg);
  return pkg;
}
const CREATORS = /\b(?:mkdirSync|writeFileSync|appendFileSync|cpSync|copyFileSync|renameSync|symlinkSync|mkdir|writeFile|appendFile|cp|copyFile|rename|outputFile|ensureDir|mkdirp|write)\(/g;

const PRODUCT_SUFFIX = /^[A-Z][A-Za-z0-9]*[a-z0-9]\.(?:js|io)$/, MODIFIED_NOUN = /^\s+(?:cli|code|script|app|application|project|module|server|program|service|library|package|backend|frontend|api|runtime|tool|binary|snippet|command|environment|version|implementation)\b/i;
const PROSE_CUE_END = /\b(use|using|with|via|without|no|on|e\.g\.?|i\.e\.?|such as|like|including|built on|powered by)\s+(?:[\w.-]+(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+))*$/i;
/** A capitalized bare product-shaped name (Name.js, no directory) is prose only on direct evidence, and a file otherwise: a use-type cue right before it or before the comma/and list it belongs to (use, using, with, via, without, no, on, e.g., such as; "use X as ..." is a file), or the name used as a modifier (a noun right after it unless a determiner precedes the name: "Name.js CLI", "Name.js code", "Name.js 20", "Name.js file named x"). */
function proseProductName(task: string, at: number, name: string): boolean {
  if (!PRODUCT_SUFFIX.test(name)) return false;
  const after = task.slice(at + name.length);
  if ((MODIFIED_NOUN.test(after) && !/\b(?:the|this|that|its|your|our)\s+$/i.test(task.slice(Math.max(0, at - 8), at))) || /^\s+(?:[A-Za-z]+\s+){1,2}(?:named|called)\b/.test(after)) return true;
  const cue = PROSE_CUE_END.exec(task.slice(Math.max(0, at - 200), at));
  return !!cue && !(/^(?:use|using)$/i.test(cue[1]!) && /^\s+as\b/i.test(after));
}
const TEST_DIR = /^(?:tests?|__tests__|specs?)$/, TEST_NAME = /^(?:conftest\.py|test_.*|.*_test\..*|.*\.test\..*|.*\.spec\..*|.*_spec\..*)$/;
const hollow = (body: string): boolean => body.split("\n").every((l) => { const t = l.trim(); return !t || /^(?:#|\/\/|\/\*|\*)/.test(t); }); // empty, whitespace or comment/shebang lines only

/** Paths the task text names as files (a name with a letter-bearing extension, optionally dir-prefixed), normalized repo-relative; the greenfield counterpart of namedFiles, which only sees files already in the repo map. */
export function taskNamedPaths(task: string): string[] {
  const names = [...task.matchAll(/(?<![\w./-])((?:\.\/)?(?:[\w.-]+\/)*[\w-]+\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*)(?![\w-]|\.\w)/g)].filter((m) => !proseProductName(task, m.index!, m[1]!)).map((m) => m[1]!.replace(/^\.\//, ""));
  return [...new Set(names.filter((n) => !/^[A-Za-z]\.[A-Za-z]$/.test(n)))]; // "e.g" and "i.e" are prose, never files; a capitalized product-shaped name is prose only on direct evidence (see proseProductName)
}

/** Top-level symbol names a source text defines, by shape and never by language: a line-start def, class, function, func, fn, const, let, var, type, struct, enum, trait, interface, sub, proc, fun or val (optionally exported, public or async, with an optional Go receiver or `self.`), a line-start `name =` or `name() {`, `exports.name =`, and the names in `module.exports = { ... }` or `export { ... }`. Docstrings, block comments and line comments are ignored; main, init, dunder and test-prefixed names are not counted, so a stub cannot match on them. */
export function topLevelSymbols(src: string): Set<string> {
  const code = src.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(?:#|\/\/).*$/gm, "");
  const out = new Set<string>(), add = (n: string | undefined): void => { if (n && n !== "_" && !/^(?:main|init)$|^__\w+__$|^[Tt]est/.test(n)) out.add(n); };
  for (const m of code.matchAll(/^(?:(?:export|default|async|pub(?:\([^)]*\))?|static|public|abstract|final)\s+)*(?:def|class|function\*?|func|fn|const|let|var|type|interface|struct|enum|trait|sub|proc|fun|val)\s+(?:\([^)]*\)\s*)?(?:self\.)?([A-Za-z_$][\w$]*)|^(?:(?:module\.)?exports\.)?([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\(\)\s*\{)/gm)) add(m[1] ?? m[2]);
  for (const m of code.matchAll(/^(?:module\.exports\s*=|export)\s*\{([^}]*)\}/gm)) for (const part of m[1]!.split(",")) add(part.trim().split(/\s+/).pop());
  return out;
}

/** FALSEVER-WALLPATH-3: language-agnostic last check. The task names a bare file X (a repo-root file), the run added X only under a test directory (tests/X) and not at the repo root, and the task does not name that directory (see taskNamesDir): the real grader runs X at the root, so the result is NOT PROVEN. A root X clears the note only when the run added or changed it (a root file untouched by the run is stale) and it defines at least one top-level symbol the test-directory copy defines; when that copy defines no symbol, any non-hollow root file clears it. Returns the note lines (empty when nothing is misplaced). */
export function misplacedNamedNotes(task: string, rawDiff: string[], repoDir: string, head: string): string[] {
  const named = taskNamedPaths(task), added = rawDiff.flatMap((m, i) => (i % 2 === 0 && m.trim().split(" ").pop() === "A" && rawDiff[i + 1] ? [rawDiff[i + 1]!] : [])), changed = new Set(rawDiff.filter((_, i) => i % 2 === 1));
  return named.filter((x) => !x.includes("/") && !TEST_NAME.test(x)).flatMap((x) => {
    const hit = added.find((f) => f.includes("/") && basename(f) === x && TEST_DIR.test(f.split("/")[0]!)); // only a test directory copy stands in for the root file; cmd/server/main.go, pkg/__init__.py, src/components/index.ts are idiomatic
    if (!hit || named.some((p) => p.endsWith(`/${x}`)) || taskNamesDir(task, dirname(hit))) return [];
    const root = safeGitSpawn(repoDir, ["show", `${head}:${x}`], { timeout: 5000, encoding: "utf8" });
    if (root.status === 0 && changed.has(x) && !hollow(root.stdout ?? "")) { // a stale root file (untouched by the run), or an empty or stub one beside the real file under tests/, keeps the cap
      const copy = safeGitSpawn(repoDir, ["show", `${head}:${hit}`], { timeout: 5000, encoding: "utf8" }), want = topLevelSymbols(copy.status === 0 ? copy.stdout ?? "" : "");
      if (want.size === 0 || [...topLevelSymbols(root.stdout ?? "")].some((n) => want.has(n))) return [];
    }
    return [`task names ${x} but it exists only at ${hit}`];
  });
}
/** Whether the task names the directory as a home for the file: a path with a slash (`tests/`, `cmd/server`) or a phrase such as "in/under/inside the X directory". The bare words tests, test and spec never count, and neither does a mention that says the tests live there ("put the tests in tests/"): that is the home of the tests, not of the named file. */
const taskNamesDir = (task: string, dir: string): boolean => {
  const d = escapeRegex(dir);
  return [...task.matchAll(new RegExp(`(?<![\\w.-])${d}/|\\b(?:in|into|under|inside|within)\\s+(?:the\\s+)?[\`"']?${d}/?[\`"']?\\s+(?:directory|dir|folder)\\b`, "g"))].some((m) => !/\b(?:tests?|specs?)\b[^.;\n]{0,30}\b(?:in|into|under|inside|to|at|within)\s+(?:the\s+)?$/i.test(task.slice(0, m.index!) + (/^(?:in|into|under|inside|within)\b/.test(m[0]) ? `${/^\w+/.exec(m[0])![0]} ` : "")));
};

/** FC-WALL-PHANTOM-PATH: repo paths a JS/TS test builds with join/resolve from the test dir, the cwd or a const derived from them (const assignments followed, calls split across lines joined) that do not exist in the base tree. process.cwd() is tried as the nearest package root of the test dir (verify runs a package's tests there) and as the repo root; a path existing under either passes. A path the plan names, creates (mkdir/write/cp/rename target), or that git ignores passes; write/expect/tmp lines are ignored. A path that stays inside the test dir is reported only when its first segment is absent from the test dir but present at the package or repo root (tests/plugins/x for plugins/x); fixtures the test dir lacks stay unreported. Returns repo-relative missing paths (max 3). */
export function phantomRepoPaths(content: string, fileName: string, testDir: string, repoDir: string, planText: string | null, task: string | null = null): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(fileName)) return [];
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s*\n\s*/g, ", ").replace(/=\s*\n\s*/g, "= ");
  const walkCode = /\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+of\s*\[/.test(code) ? code.replace(/([;{])[ \t]*(?=(?:const|let|var)\s)/g, "$1\n") : code; // a walk-up loop: statements sharing a line are split so each binding is followed
  const pkg = nearestPackageRoot(testDir, repoDir, fileName);
  const split = (s: string): string[] => { const out: string[] = []; let d = 0, q = "", cur = ""; for (let i = 0; i < s.length; i++) { const c = s[i]!; if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === q) q = ""; } else if (c === '"' || c === "'" || c === "`") { q = c; cur += c; } else if ("([{".includes(c)) { d++; cur += c; } else if (")]}".includes(c)) { d--; cur += c; } else if (c === "," && d === 0) { out.push(cur); cur = ""; } else cur += c; } if (cur.trim()) out.push(cur); return out; };
  const close = (line: string, at: number): number => { let d = 0; for (let j = at; j < line.length; j++) { if (line[j] === "(") d++; else if (line[j] === ")" && --d === 0) return j; } return -1; };
  const strayInTestDir = (out: string): boolean => { const first = relative(testDir, out).split("/")[0]!; return !!first && first !== "__self__" && !existsSync(join(testDir, first)) && [pkg, repoDir].some((d) => d !== testDir && existsSync(join(d, first))); }; // inside the test dir but the first segment only exists at a repo root: the author meant a repo path
  const named = new Set(taskNamedPaths(task ?? "")), namedStray = (out: string): boolean => named.has(relative(testDir, out)); // the task names this file (bare name = repo root) and the test resolves it beside the test file, even when it exists nowhere yet (greenfield)
  const scan = (cwd: string): { reports: Map<string, { out: string; rel: string; tail?: string }>; created: string[] } => {
    const vars = new Map<string, string>(), walk = new Set<string>(), taint = new Set<string>(), reports = new Map<string, { out: string; rel: string; tail?: string }>(), created: string[] = []; let ln = 0; // reports are keyed by source line and call text so two cwd runs pair the same call
    const ev = (raw: string, report: boolean): string | null => {
      const e = raw.trim().replace(/^await\s+/, "").replace(/\s+as\s+\w+$/, "").replace(/!$/, "");
      if (/^import\.meta\.(dir|dirname)$|^__dirname$/.test(e)) return testDir;
      if (e === "process.cwd()") return cwd;
      const env = /^process\.env(?:\.[\w$]+|\[[^\]]+\])\s*(?:\?\?|\|\|)\s*([\s\S]+)$/.exec(e); if (env) return ev(env[1]!, report); // an env override is unset in the run: the fallback is the value
      if (e === "fileURLToPath(import.meta.url)" || e === "__filename") return join(testDir, "__self__");
      const url = /^fileURLToPath\(new URL\((["'])([^"']*)\1\s*,\s*import\.meta\.url\)\)$/.exec(e); if (url) return resolve(testDir, url[2]!);
      const lit = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(e); if (lit) return lit[2]!.includes("${") ? null : lit[2]!;
      if (/^[A-Za-z_$][\w$]*$/.test(e)) return vars.get(e) ?? null;
      const call = /^(?:path\.)?(join|resolve|dirname)\(([\s\S]*)\)$/.exec(e); if (!call) return null;
      const parts = split(call[2]!), args = parts.map((a) => ev(a, report)); if (args.some((a) => a === null)) return null;
      if (call[1] === "dirname") return dirname(args[0]!);
      const out = resolve(...(args as string[]));
      const first = parts.slice(1).map((a) => /^\s*["'`]([^"'`]*)["'`]\s*$/.exec(a)?.[1]).find((x) => x), viaWalk = !!first && walk.has(parts[0]!.trim()) && [pkg, repoDir].some((d) => existsSync(join(d, first.split("/").filter(Boolean)[0] ?? "\0"))); // a walk-up base reaches the repo root: the first literal segment is checked there (absent everywhere keeps the old silence)
      if (report && (viaWalk || (!parts.some((a) => walk.has(a.trim()) || taint.has(a.trim())) && (relative(testDir, out).startsWith("..") || strayInTestDir(out) || namedStray(out)))) && parts.some((a) => /^\s*["'`]/.test(a))) reports.set(`${ln}|${e}`, { out, rel: relative(repoDir, out), tail: viaWalk ? join(...(args.slice(1) as string[])) : undefined });
      return out;
    };
    for (const line of walkCode.split("\n")) {
      ln++;
      for (const m of line.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]/g)) { const seeds = split(m[2]!).map((x) => ev(x, false)); if (seeds.length && seeds.every((x) => x === cwd || x === testDir)) { vars.set(m[1]!, cwd); walk.add(m[1]!); } } // loop variable whose every item is the cwd or the test dir: a walk-up start (repo-relative strings and joins stay unresolved)
      const wasg = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?\s*$/.exec(line); if (wasg && walk.has(wasg[2]!)) walk.add(wasg[1]!); // dir = resolve(start) keeps the walk base
      for (const m of line.matchAll(CREATORS)) { const j = close(line, m.index! + m[0].length - 1); if (j > 0) for (const a of split(line.slice(m.index! + m[0].length, j))) { const v = ev(a, false); if (v) created.push(v); } }
      const skip = /^\s*(?:await\s+)?(?:expect|assert\w*)\b|\b(?:write\w*|mkdir\w*|rm\w*|cp\w*|copy\w*|rename\w*|symlink\w*|mkdtemp\w*|tmpdir|outputFile|touch)\b/.test(line);
      const asg = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+?);?\s*$/.exec(line);
      if (asg && /[A-Za-z_$][\w$]*/.test(asg[2]!) && [...asg[2]!.matchAll(/[A-Za-z_$][\w$]*/g)].some((w) => walk.has(w[0]) || taint.has(w[0]))) taint.add(asg[1]!); // built on a walk-up base: only the walk rule reports it
      if (asg) { const v = ev(asg[2]!, !skip); if (v !== null) vars.set(asg[1]!, v); continue; }
      if (skip) continue;
      for (const m of line.matchAll(/(?:path\.)?(?:join|resolve)\(/g)) { const j = close(line, m.index! + m[0].length - 1); if (j > 0) ev(line.slice(m.index!, j + 1), true); }
    }
    return { reports, created };
  };
  const runs = [...new Set([pkg, repoDir])].map(scan);
  const planned = (rel: string): boolean => !!planText && rel.split("/").some((_, i, a) => { const pre = a.slice(0, i + 1).join("/"); return (i > 0 || a.length === 1) && !existsSync(join(repoDir, pre)) && new RegExp(`(?<![\\w-])${escapeRegex(pre)}(?![\\w-])`).test(planText); }); // only a path named with its parent (plugins/ralph-loop) is planned, never a bare segment or basename
  const phantom = (r: { out: string; rel: string; tail?: string }, created: string[]): boolean => {
    const rel = r.rel; if (!rel || rel.startsWith("..") || isAbsolute(rel) || /(^|\/)(\.git|\.loki|dist|build|coverage|tmp)(\/|$)/.test(rel) || existsSync(r.out) || planned(rel) || named.has(rel)) return false; // a task-named file at its named repo path is the implementer's to create
    if (r.tail) { const seen = (from: string): boolean => { let d = from; for (let i = 0; i < 64; i++) { if (existsSync(join(d, r.tail!))) return true; if (d === repoDir || d === dirname(d)) return false; d = dirname(d); } return false; }; if ([testDir, pkg, repoDir].some(seen)) return false; } // a walk-up path found at any directory the walk passes (test dir or package root, up to the repo root) is real
    if (created.some((c) => c === r.out || c.startsWith(r.out + "/") || r.out.startsWith(c + "/"))) return false;
    return safeGitSpawn(repoDir, ["check-ignore", "-q", "--", rel], { timeout: 5000 }).status !== 0;
  };
  const missing: string[] = [];
  for (const [k, r] of runs[0]!.reports) if (runs.every((x) => x.reports.has(k) && phantom(x.reports.get(k)!, x.created)) && !missing.includes(r.rel)) missing.push(r.rel);
  return missing.filter((m) => !missing.some((o) => o !== m && m.startsWith(o + "/"))).slice(0, 3);
}

/** FC-WALL-PHANTOM-PATH: the re-ask text (null when nothing is missing) for a phantom Wall file; the hint names real paths holding a segment with the same name, so a missing directory finds its real home too. */
export function phantomReason(miss: string[], repoFiles: string[], testDir = "", pkgRoot = "", task: string | null = null): string | null {
  if (miss.length === 0) return null;
  const real = (r: string): boolean => !!r && repoFiles.some((f) => f === r || f.startsWith(`${r}/`)), pkg = pkgRoot === "." ? "" : pkgRoot; // FC-WALL-LOCATION-BLIND: a phantom that is the test dir plus a path real at the repo root or the package root
  const at = (m: string): string | null => { const r = testDir && m.startsWith(`${testDir}/`) ? m.slice(testDir.length + 1) : ""; return !r ? doubled(m) : real(r) ? `${r} exists relative to the repo root` : pkg && real(`${pkg}/${r}`) ? `${r} exists relative to the package root ${pkg}/` : null; };
  // A multi-root repo: the test dir backend/src/lib, a root taken one level too shallow (backend/src) and a repo path appended to it (backend/src/utils/x) doubles the prefix (backend/src/backend/src/utils/x): the tail after a repeated ancestor is the real repo path.
  const doubled = (m: string): string | null => { const segs = testDir.split("/").filter(Boolean); for (let k = segs.length - 1; k >= 1; k--) { const anc = segs.slice(0, k).join("/"), rest = m.startsWith(`${anc}/`) ? m.slice(anc.length + 1) : ""; if (rest.startsWith(`${segs[0]}/`) && (real(rest) || repoFiles.some((f) => f.replace(/\.[^./]+$/, "") === rest))) return `${rest} exists relative to the repo root, but the path was built from ${anc}/ (the root was taken ${segs.length - k} level(s) too shallow, so the prefix is doubled): build it from the repo root, ${segs.length} level(s) above ${testDir}/`; } return null; };
  const nm = new Set(taskNamedPaths(task ?? "")), beside = (m: string): string | null => { const r = testDir && m.startsWith(`${testDir}/`) ? m.slice(testDir.length + 1) : ""; return r && nm.has(r) ? r : null; }; // FALSEVER-WALLPATH: a task-named file resolved beside the test file
  const own = miss.map((m) => [m, at(m) ?? (beside(m) ? `the task names ${beside(m)} at the repo path ${beside(m)}, not beside the test file` : null)] as const), loc = own.filter(([, w]) => w).map(([, w]) => w!), rest = own.filter(([, w]) => !w).map(([m]) => m);
  const hint = (m: string): string => { const n = basename(m), near = [...new Set(repoFiles.flatMap((f) => { const s = f.split("/"), k = s.indexOf(n); return k >= 0 && s.slice(0, k + 1).join("/") !== m ? [s.slice(0, k + 1).join("/")] : []; }))].slice(0, 3); return near.length ? `${m} (a path named ${n} exists at ${near.join(", ")})` : m; };
  const wrong = loc.length ? `references repo path(s) built from the wrong directory: your test file is copied to ${testDir}/, so __dirname and import.meta.dir are that directory, not the repo root; ${loc.join("; ")}. Compute the root from ${testDir}/ (go up ${testDir.split("/").length} level(s)) or use process.cwd() only if the runner starts at the root, and build every repo path from it` : "", typo = rest.length ? `references repo path(s) that do not exist in the repository and that the plan does not create: ${rest.map(hint).join("; ")}. Locate the real code by searching the repository; do not copy a name from the task text as a path` : "";
  return [wrong, typo].filter(Boolean).join(". Also, it ");
}
