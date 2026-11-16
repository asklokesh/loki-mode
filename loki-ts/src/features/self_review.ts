// SR LOKI_E10_SELF_REVIEW: the pre-delivery review self-check. New file: no module owns a review that may EDIT the diff before delivery (stages/xreview.ts is a
// read-only reviewer that can only lower the verdict, after verify). Deterministic checks first, then at most one bounded resume of the implement session.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildArtifacts, runOutputs, type Staged } from "../e10ext/commit_filter.ts";
import { outsideScope } from "../e10ext/scope.ts";
import type { Obj } from "../engine10/types.ts";
import { contributionGuides, releaseNoteBrief, releaseNoteConvention, releaseNoteProblems, renameInventedFragment, stripInventedRefsInFile, taskForbidsReleaseNote, taskNumbers, towncrierNoNumberPrefix } from "../project_model/conventions.ts";
import { detectFormatters } from "../runner/repo_profile.ts";
import { applyDiff, type DiffEntry, snapshotDiff } from "../e10ext/treeswap.ts";
import { safeGit } from "../util/safe_git.ts";
import { escapeRegex } from "../util/regex_escape.ts";
import { isTestFile as narrowTestFile } from "../util/test_file_text.ts";
/** A test file by name or location in any common layout (the shared helper misses Rust tests.rs, a top-level test/ dir, __tests__/, JVM *Test sources). */
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|specs?|testing|[a-z]*Test)\//, TEST_NAME = /(?:^|\/)(?:tests?\.[a-z]+|test_[^/]+|[^/]+_tests?\.[a-z]+|[^/]+\.(?:test|spec)\.[a-z]+|[A-Z][^/]*Tests?\.(?:kt|java|cs|scala|swift|groovy))$/;
export const isTestFile = (f: string): boolean => narrowTestFile(f) || TEST_DIR.test(f) || TEST_NAME.test(f);

/** Off (`0`), `on` (default: the turn runs only when a deterministic item flags, so a clean minimal diff is never touched and costs nothing), or `always`. */
export type SelfReviewMode = "off" | "on" | "always";
export const selfReviewMode = (env: NodeJS.ProcessEnv = process.env): SelfReviewMode => { const v = (env["LOKI_E10_SELF_REVIEW"] ?? "").trim().toLowerCase(); return /^(0|off|false|no)$/.test(v) ? "off" : v === "always" ? "always" : "on"; };
/** The turn cap of the review resume (cost cap); LOKI_E10_SELF_REVIEW_MAX_TURNS overrides, 0 or junk keeps the default. */
export const SELF_REVIEW_MAX_TURNS = 12;
export const selfReviewMaxTurns = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number((env["LOKI_E10_SELF_REVIEW_MAX_TURNS"] ?? "").trim()); return Number.isInteger(n) && n > 0 ? n : SELF_REVIEW_MAX_TURNS; };

export type ItemKey = "release_note" | "stray_files" | "test" | "format" | "scope" | "cases" | "siblings" | "docs" | "conventions";
export type ItemStatus = "ok" | "flagged" | "fixed" | "justified" | "unresolved" | "auto";
export interface ReviewItem { item: ItemKey; status: ItemStatus; detail: string }
const SRC_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|ex|exs|clj|dart|lua)$/;
const STYLE_FILES = [".editorconfig", ".prettierrc", ".prettierrc.json", "prettier.config.js", "biome.json", "rustfmt.toml", ".rustfmt.toml", "ruff.toml", ".ruff.toml", ".flake8", "setup.cfg", "tox.ini", ".golangci.yml", ".golangci.yaml", ".eslintrc", ".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", ".clang-format", ".pre-commit-config.yaml", "checkstyle.xml", ".scalafmt.conf"];

/** The deterministic half: one item per rule, from the staged diff against base. No model call, never throws. */
/** RC LOKI_E10_REPO_CONVENTIONS (acc-173, off by default until measured, =1 on): self-check item (i) runs the repository's own convention checks on the change,
 *  with no install and no model: (1) the local hooks of .pre-commit-config.yaml that need no environment, `language: fail` (a changed file that matches
 *  `files` and not `exclude` is rejected with the hook's entry text) and `pygrep` (the entry regex in an added line); (2) the contribution guide's explicit bans,
 *  "never use `X`" / "do not use `X`" / "don't use `X`" for an identifier-shaped X, as a whole-word grep of added code lines with comments and strings removed,
 *  import and export lines skipped, the guide's "only exception is `X Y`" exempted, and a use whose surrounding text the file already has on base (the
 *  repository's own established usage, such as `DataKey<any>`) exempted. */
export const repoConventionsOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_E10_REPO_CONVENTIONS"] ?? "").trim());
const PC_TYPES: Record<string, RegExp> = { file: /./, text: /./, rst: /\.rst$/, python: /\.pyi?$/, markdown: /\.(?:md|markdown)$/, yaml: /\.ya?ml$/, toml: /\.toml$/, json: /\.json$/, javascript: /\.[cm]?jsx?$/, ts: /\.[cm]?tsx?$/, tsx: /\.tsx$/, jsx: /\.jsx$/ };
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|swift|scala)$/;
/** A pre-commit (Python) regex as a JS RegExp: (?x) verbose whitespace and comments dropped, (?P<n> named groups renamed; null when it does not compile. */
export function pyRegex(src: string, flags = ""): RegExp | null {
  let p = src.trim();
  if (p.startsWith("(?x)")) p = p.slice(4).split("\n").map((l) => l.replace(/(?<!\\)#.*$/, "")).join("").replace(/(?<!\\)\s+/g, "");
  p = p.replace(/\(\?P</g, "(?<");
  try { return new RegExp(p, flags); } catch { return null; }
}
export function precommitFlags(cfgText: string, added: Map<string, string[]>): string[] {
  let doc: unknown; try { doc = (globalThis as { Bun?: { YAML: { parse(t: string): unknown } } }).Bun?.YAML.parse(cfgText); } catch { return []; }
  const out: string[] = [];
  for (const repo of ((doc as { repos?: unknown[] } | null)?.repos ?? []) as { repo?: string; hooks?: Record<string, unknown>[] }[]) {
    if (repo?.repo !== "local") continue;
    for (const h of repo.hooks ?? []) {
      const lang = String(h.language ?? ""), types = (Array.isArray(h.types) ? h.types : []).map(String), args = (Array.isArray(h.args) ? h.args : []).map(String);
      if ((lang !== "fail" && lang !== "pygrep") || types.some((t) => !PC_TYPES[t]) || args.some((a) => a !== "--ignore-case")) continue; // only hooks that need no environment and no flag Loki does not model
      const files = pyRegex(String(h.files ?? "")), excl = h.exclude ? pyRegex(String(h.exclude)) : null; if (!files || (h.exclude && !excl)) continue;
      for (const [f, lines] of added) {
        if (!files.test(f) || (excl && excl.test(f)) || !types.every((t) => PC_TYPES[t]!.test(f))) continue;
        if (lang === "fail") { out.push(`pre-commit hook ${String(h.id)} rejects ${f}: ${String(h.entry ?? h.name ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`); continue; }
        const rx = pyRegex(String(h.entry ?? ""), args.includes("--ignore-case") ? "i" : ""); const hit = rx ? lines.find((l) => rx.test(l)) : undefined;
        if (hit !== undefined) out.push(`pre-commit hook ${String(h.id)} (${String(h.name ?? "")}) rejects a line in ${f}: ${hit.trim().slice(0, 100)}`);
      }
    }
  }
  return out;
}
export type GuideBan = { token: string; exceptions: string[]; rule: string };
export function guideBans(guide: string): GuideBan[] {
  const out: GuideBan[] = [];
  for (const line of guide.split("\n")) for (const m of line.matchAll(/\b(?:never|do not|don't)\s+use\s+`([A-Za-z_]\w*)`/gi)) out.push({ token: m[1]!, exceptions: [...line.matchAll(/only exception is\s+`([^`]+)`/gi)].map((e) => e[1]!), rule: line.trim().replace(/^[-*+]\s*/, "").slice(0, 120) });
  return out;
}
export function banFlags(bans: GuideBan[], added: Map<string, string[]>, baseText: (f: string) => string): string[] {
  const out: string[] = [];
  for (const b of bans) {
    const rx = new RegExp(`(?<![\\w$.])${escapeRegex(b.token)}(?![\\w$])`);
    for (const [f, lines] of added) {
      if (!CODE_FILE.test(f)) continue;
      for (const l of lines) {
        if (/^\s*(?:import|export)\b/.test(l)) continue;
        let c = l.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""').replace(/(?:\/\/|#).*$/, "");
        for (const e of b.exceptions) c = c.split(e).join("");
        const m = rx.exec(c); if (!m) continue;
        const chunk = (/\S*$/.exec(c.slice(0, m.index))![0] + b.token + /^\S*/.exec(c.slice(m.index + b.token.length))![0]).replace(/[,;)]+$/, "");
        if (chunk.length > b.token.length && baseText(f).includes(chunk)) continue; // the repository's own established usage
        out.push(`contribution rule "${b.rule}": ${f}: ${l.trim().slice(0, 100)}`); break;
      }
    }
  }
  return out;
}
export function repoConventionFlags(repoDir: string, baseSha: string, live: Staged[]): string[] {
  const added = addedLines(repoDir, baseSha, live), out: string[] = [];
  for (const { f, st } of live) if (st === "A" && !added.has(f)) added.set(f, []); // a new empty file still has a name a hook can reject
  const cfg = (() => { try { return readFileSync(join(repoDir, ".pre-commit-config.yaml"), "utf8"); } catch { return ""; } })();
  if (cfg) out.push(...precommitFlags(cfg, added));
  const bans = guideBans(contributionGuides(repoDir));
  if (bans.length) out.push(...banFlags(bans, added, (f) => { try { return safeGit(repoDir, ["show", `${baseSha}:${f}`], { maxBuffer: 64 << 20 }); } catch { return ""; } }));
  return out;
}
export function selfReviewChecks(repoDir: string, baseSha: string, staged: Staged[], task: string, outputs: Partial<Record<string, Obj>>, env: NodeJS.ProcessEnv = process.env, runDir?: string): ReviewItem[] {
  const live = staged.filter(({ st, f }) => (st === "A" || st === "M") && !f.startsWith(".loki/"));
  const files = live.map(({ f }) => f), src = files.filter((f) => SRC_EXT.test(f) && !isTestFile(f)), tests = files.filter((f) => isTestFile(f));
  const items: ReviewItem[] = [];
  // (a) release note the repo's rules require
  const conv = (() => { try { return releaseNoteConvention(repoDir, env); } catch { return null; } })();
  const carried = conv ? files.some((f) => f === conv.dir || f.startsWith(`${conv.dir}/`)) : false;
  const refProblems = conv && carried && src.length > 0 ? (() => { try { return releaseNoteProblems(repoDir, conv, addedLines(repoDir, baseSha, live.filter(({ f }) => f === conv.dir || f.startsWith(`${conv.dir}/`))), files, task, env); } catch { return []; } })() : [];
  if (refProblems.length) items.push({ item: "release_note", status: "flagged", detail: refProblems.slice(0, 4).join("; ") }); else
  items.push(!conv || src.length === 0 || taskForbidsReleaseNote(task) ? { item: "release_note", status: "ok", detail: conv ? (src.length === 0 ? "no source change" : "the task says no release note") : "the repo states no release-note rule" }
    : carried ? { item: "release_note", status: "ok", detail: `the diff carries ${conv.kind === "changelog" ? `an entry in ${conv.dir}` : `a ${conv.kind} fragment in ${conv.dir}/`}` }
    : { item: "release_note", status: "flagged", detail: conv.kind === "changelog" ? `the contribution guide asks for an entry in ${conv.dir} (under "${conv.heading ?? "Unreleased"}") and the diff has none` : `the repo keeps ${conv.kind} release notes in ${conv.dir}/ and the diff has no fragment${conv.kind === "towncrier" && taskNumbers(task).length === 0 && towncrierNoNumberPrefix(repoDir, conv.dir, env) ? `; the task gives no issue or PR number, so add it in towncrier's orphan form ${conv.dir}/${towncrierNoNumberPrefix(repoDir, conv.dir, env)}<short-slug>.<type> (the same type and extension as the existing fragments) rather than skipping it or inventing a number` : ""}` }); // TN: a missing number is never a reason to ship no fragment
  // (b) stray, generated or unrelated files: build output (the commit filter drops it) and added files in a directory the repo has never tracked
  const added = live.filter(({ st }) => st === "A").map(({ f }) => f);
  const art = (() => { try { return [...new Set([...buildArtifacts(repoDir, added, baseSha, task), ...runOutputs(repoDir, added, baseSha, task)])]; } catch { return []; } })(); // the commit filter drops these (GB, RO)
  const trackedDirs = (() => { try { return new Set(safeGit(repoDir, ["ls-tree", "-r", "--name-only", baseSha], { maxBuffer: 256 << 20 }).split("\n").filter(Boolean).map((f) => dirname(f))); } catch { return null; } })();
  const fragDir = conv && conv.kind !== "changelog" ? `${conv.dir}/` : null;
  const stray = trackedDirs ? added.filter((f) => !art.includes(f) && !isTestFile(f) && !(fragDir && f.startsWith(fragDir)) && !trackedDirs.has(dirname(f)) && !task.includes(f) && !task.includes(basename(f))) : [];
  items.push(stray.length ? { item: "stray_files", status: "flagged", detail: `new files outside every directory the repo tracks: ${stray.slice(0, 8).join(", ")}` } : art.length ? { item: "stray_files", status: "auto", detail: `build output the commit leaves out: ${art.slice(0, 8).join(", ")}` } : { item: "stray_files", status: "ok", detail: "no generated or stray file" });
  // (c) a test that exercises the change
  items.push(src.length === 0 ? { item: "test", status: "ok", detail: "no source change" } : tests.length ? { item: "test", status: "ok", detail: `test changes: ${tests.slice(0, 5).join(", ")}` } : { item: "test", status: "flagged", detail: `source changed (${src.slice(0, 5).join(", ")}) and the diff has no test` });
  // (d) formatter conformance: a configured formatter normalizes the changed files at commit; otherwise the model matches the style config
  const fmts = (() => { try { return detectFormatters(repoDir, env); } catch { return []; } })().filter((fm) => files.some((f) => fm.exts.test(f)));
  const style = STYLE_FILES.filter((s) => existsSync(join(repoDir, s)));
  items.push(fmts.length ? { item: "format", status: "auto", detail: `${fmts.map((f) => f.tool).join(", ")} formats the changed files at commit` } : { item: "format", status: "ok", detail: style.length ? `no runnable formatter; style config: ${style.join(", ")}` : "no formatter or style config" });
  // (e) scope: edits to existing files outside every scope signal
  const out = (() => { try { return outsideScope(outputs, live); } catch { return null; } })() ?? [];
  const outside = out.filter((f) => !(conv && (f === conv.dir || f.startsWith(`${conv.dir}/`))));
  items.push(outside.length ? { item: "scope", status: "flagged", detail: `edits outside the planned scope: ${outside.slice(0, 8).join(", ")}` } : { item: "scope", status: "ok", detail: "no edit outside the planned scope" });
  if (repoConventionsOn(env) && live.length > 0) { // (i) RC: the repo's own convention checks on the change
    const hits = (() => { try { return repoConventionFlags(repoDir, baseSha, live); } catch { return []; } })();
    items.push(hits.length ? { item: "conventions", status: "flagged", detail: `the repository's own checks reject the change: ${hits.slice(0, 4).join("; ")}` } : { item: "conventions", status: "ok", detail: "no repository check or contribution rule rejects the change" });
  }
  if (docEnumOn(env) && src.length > 0) { // (h) docs that enumerate what the change extends
    const stale = (() => { try { return docEnumerations(repoDir, baseSha, live); } catch { return []; } })();
    items.push(stale.length ? { item: "docs", status: "flagged", detail: `docs that list what the change extends but not the new entry: ${stale.slice(0, 4).join("; ")}` } : { item: "docs", status: "ok", detail: "no doc lists what the change extends without the new entry" });
  }
  if (srCoverageOn(env) && src.length > 0) {
    // (f) stated cases: every case the issue states has an added test that exercises it
    const testText = (() => { try { return [...addedLines(repoDir, baseSha, live.filter(({ f }) => isTestFile(f))).values()].flat().join("\n"); } catch { return ""; } })();
    const handed = wallCasesHanded(runDir), wallRan = Array.isArray(outputs.wall?.files) && (outputs.wall!.files as unknown[]).length > 0;
    const missing = handed && wallRan ? [] : statedCases(task).filter((c) => !caseCovered(c, testText)); // WC: the Wall's sealed tests, not a token match on the model's own tests
    if (handed && wallRan) items.push({ item: "cases", status: "auto", detail: `${handed} stated case(s) were handed to the Wall as required cases; its sealed tests check them` }); else
    items.push(missing.length ? { item: "cases", status: "flagged", detail: `stated cases with no added test that exercises them: ${missing.slice(0, 5).map((c) => `[${c.kind}] ${c.text}`).join(" | ")}` } : { item: "cases", status: "ok", detail: "every stated case has an added test, or the issue states none" });
    // (g) sibling definitions: other definitions of a changed function or method that the diff leaves untouched
    const sibs = (() => { try { return siblingDefinitions(repoDir, baseSha, live); } catch { return []; } })();
    items.push(sibs.length ? { item: "siblings", status: "flagged", detail: `other definitions of a changed function the diff does not touch (check each has the same bug): ${sibs.slice(0, 6).join(", ")}` } : { item: "siblings", status: "ok", detail: "no other definition of a changed function" });
  }
  return items;
}

/** DE LOKI_E10_DOC_ENUM (default on, =0 opts out): self-check item (h). A doc beside a changed source file (a Markdown file in its directory, or a docs/ page named
 *  after its directory or file) that the diff leaves untouched and that already names at least 2 of the option keys or quoted names the source file holds on base,
 *  while the change adds a new one the doc does not name, is flagged for the review turn. The failure: a change added a secondary option to two rules and left
 *  each rule's README, which lists every other option, without it; review failed the diff on the missing docs. */
export const docEnumOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_DOC_ENUM"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
const NAME_TOKENS = (text: string): Set<string> => new Set([...text.matchAll(/['"`]([A-Za-z][\w-]{2,39})['"`]|\b([A-Za-z_][\w]{2,39})\s*:/g)].map((m) => (m[1] ?? m[2])!).filter((t) => !/^(?:true|false|null|undefined|this|type|name|value|string|number|default|function|return|const|let|var|import|export|from|https?)$/i.test(t)));
export function docEnumerations(repoDir: string, baseSha: string, live: Staged[]): string[] {
  const touched = new Set(live.map(({ f }) => f)), out: string[] = [];
  let tracked: string[] = []; try { tracked = safeGit(repoDir, ["ls-tree", "-r", "--name-only", baseSha], { maxBuffer: 256 << 20 }).split("\n").filter(Boolean); } catch { return []; }
  for (const { st, f } of live) {
    if (st !== "M" || !SRC_EXT.test(f) || isTestFile(f)) continue;
    let base = ""; try { base = safeGit(repoDir, ["show", `${baseSha}:./${f}`], { maxBuffer: 64 << 20 }); } catch { continue; }
    const baseTok = NAME_TOKENS(base), added = [...NAME_TOKENS([...addedLines(repoDir, baseSha, [{ st, f }]).values()].flat().join("\n"))].filter((t) => !baseTok.has(t));
    if (!added.length) continue;
    const dir = dirname(f), stems = new Set([basename(dir), basename(f).replace(/\.[^.]+$/, "")].filter((s) => s && s !== "." && s !== "index" && s !== "src" && s !== "lib"));
    const docs = tracked.filter((d) => /\.mdx?$/i.test(d) && !touched.has(d) && (dirname(d) === dir || (/(^|\/)docs?\//.test(d) && stems.has(basename(d).replace(/\.mdx?$/i, "")))));
    for (const d of docs) {
      let text = ""; try { text = readFileSync(join(repoDir, d), "utf8"); } catch { continue; }
      const listed = [...baseTok].filter((t) => text.includes(t));
      const missing = added.filter((t) => !text.includes(t));
      if (listed.length >= 2 && missing.length) out.push(`${d} lists ${listed.slice(0, 3).map((t) => `\`${t}\``).join(", ")} from ${f} but not the new ${missing.slice(0, 3).map((t) => `\`${t}\``).join(", ")}`);
    }
  }
  return [...new Set(out)].slice(0, 6);
}
/** SC LOKI_E10_SR_COVERAGE (default on, =0 opts out): two more self-check items. (f) Stated cases: the cases the issue states, kept to code blocks that show a
 *  result or an error and four sentence forms ("similar error when ...", "... has the same effect", "both `x` and `y`", "gets neither treatment"); a case is
 *  covered when an added test line carries one of its code tokens, and a sentence with no code token is always flagged for the review turn to cover or justify.
 *  (g) Sibling definitions: other definitions, by name, of a function or method the diff changes (an override in a subclass, a twin parser path), outside the
 *  changed files and tests. Either flag starts the self-check's one review turn. The failure: Loki fixed the headline case and missed a stated one
 *  (a "similar error when wrapping it in ..." edge, a "... has the same effect" sentence, the issue's own error reproduction)
 *  or a sibling override of the changed method in a subclass, while a stronger raw model covered them. */
export const srCoverageOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_SR_COVERAGE"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
export interface StatedCase { kind: "block" | "sentence"; text: string; tokens: string[] }
const COMMON_CALLS = new Set(["print", "println", "printf", "log", "console", "assert", "expect", "test", "it", "describe", "require", "import", "from", "def", "class", "function", "return", "new", "len", "str", "int", "list", "dict", "set", "range", "if", "for", "while", "fmt", "main", "echo", "cd", "python", "node", "npm", "pip", "cargo", "go", "use", "let", "const", "var", "self", "this"]);
const RESULT_AFTER = /^\s*(?:\S+\s+){0,3}(?:expected|actual|output|prints?|returns?|gives?|result|error|raises?|throws?)\b/i;
const ERROR_IN = /\b\w*(?:Error|Exception)\b|\bTraceback\b|\bpanicked\b|\bfailed\b|\b(?:expected|actual|output)\s*:|(?:\/\/|#)\s*(?:=>|->|→)/i;
/** The cases an issue states (see srCoverageOn), in order, at most 8. */
export function statedCases(task: string): StatedCase[] {
  const out: StatedCase[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g; let m: RegExpExecArray | null;
  while ((m = re.exec(task)) !== null) {
    const body = m[1]!, after = task.slice(m.index + m[0].length, m.index + m[0].length + 200);
    if (!ERROR_IN.test(body) && !RESULT_AFTER.test(after)) continue;
    const tokens = [...new Set([...body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)].map((x) => x[1]!).filter((n) => n.length > 2 && !COMMON_CALLS.has(n)))].slice(0, 6);
    if (tokens.length) out.push({ kind: "block", text: (body.split("\n").find((l) => tokens.some((t) => l.includes(t))) ?? body).trim().slice(0, 120), tokens });
  }
  const prose = task.replace(/```[\s\S]*?```/g, " ");
  for (const s of prose.split(/(?<=[.!?])\s+|\n{2,}/)) {
    const t = s.replace(/\s+/g, " ").trim();
    if (!(/\bsimilar\s+(?:error|issue|problem|failure|behaviou?r)\b[^.]*\bwhen\b/i.test(t) || /\bha(?:s|ve) the same effect\b/i.test(t) || (/\bboth\b[^.]{0,120}\band\b/i.test(t) && /`[^`]+`/.test(t)) || /\bgets?\s+neither\s+(?:treatment|fix|handling)\b/i.test(t))) continue;
    out.push({ kind: "sentence", text: t.slice(0, 160), tokens: [...new Set([...t.matchAll(/`([^`]+)`/g)].map((x) => x[1]!.trim()).filter((x) => x.length > 1))].slice(0, 6) });
  }
  return out.slice(0, 8);
}
/** WC LOKI_E10_WALL_CASES (default on, =0 opts out): the stated cases (statedCases) go to the Wall test writer as REQUIRED acceptance lines, one sealed test each,
 *  and the handoff is recorded in <runDir>/wall-required-cases.json (the fire marker). When the Wall then wrote tests, the self-check's stated-cases item no longer
 *  token-matches the model's own tests (which pass when they encode the model's wrong reading) and reads `auto`: the Wall's sealed tests check the cases. With no
 *  Wall run the token match stays as the fallback. */
export const wallCasesOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_WALL_CASES"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
const WALL_CASES_FILE = "wall-required-cases.json";
export function wallRequiredCases(runDir: string, task: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!wallCasesOn(env)) return [];
  const cases = statedCases(task);
  if (!cases.length) return [];
  const lines = cases.map((c, i) => `REQUIRED CASE ${i + 1} (stated in the issue; write a test that fails before the fix and passes after it): ${c.text}`);
  try { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, WALL_CASES_FILE), JSON.stringify({ cases: lines })); } catch { /* best effort: the brief still carries them */ }
  return lines;
}
export const wallCasesHanded = (runDir: string | undefined): number => { if (!runDir) return 0; try { return ((JSON.parse(readFileSync(join(runDir, WALL_CASES_FILE), "utf8")) as { cases?: unknown[] }).cases ?? []).length; } catch { return 0; } };
/** A case is covered when an added test line carries one of its tokens (whitespace-insensitive); a sentence with no code token never counts as covered. */
export function caseCovered(c: StatedCase, testText: string): boolean {
  if (!c.tokens.length) return false;
  const norm = (x: string): string => x.replace(/\s+/g, "");
  const tt = norm(testText);
  return c.tokens.some((t) => tt.includes(norm(t)));
}
const SIB_SKIP = new Set(["__init__", "__repr__", "__str__", "__eq__", "__hash__", "__lt__", "constructor", "toString", "main", "new", "default", "fmt", "setUp", "tearDown", "init", "render", "run", "get", "set", "update", "handle", "String", "Error"]);
const S = "[[:space:]]"; // POSIX classes: `git grep -E` uses the platform's ERE, where \s and \b are not portable (macOS regcomp has neither)
const DEF_RE: [RegExp, (n: string) => string][] = [
  [/\.py$/, (n) => `^${S}*(async${S}+)?def${S}+${n}${S}*\\(`],
  [/\.[cm]?[jt]sx?$/, (n) => `(function${S}+${n}([^[:alnum:]_$]|$)|^${S}*(async${S}+)?(static${S}+)?${n}${S}*\\([^)]*\\)${S}*[:{])`],
  [/\.go$/, (n) => `^func${S}+(\\([^)]*\\)${S}*)?${n}${S}*\\(`],
  [/\.rs$/, (n) => `^${S}*(pub(\\([^)]*\\))?${S}+)?(async${S}+)?fn${S}+${n}([^[:alnum:]_]|$)`],
];
/** The function or method a source line defines, or null (Python def, JS/TS function or method, Go func, Rust fn). */
function enclosingName(line: string): string | null {
  const m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line) ?? /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line) ?? /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(line) ?? /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(line)
    ?? /^\s*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/.exec(line);
  return m && !["if", "for", "while", "switch", "catch", "return"].includes(m[1]!) ? m[1]! : null;
}
/** Other definitions (file:line) of the functions the diff changes, by name, in files of the same language that the diff does not touch; tests and vendored or built
 *  paths excluded; a name with more than 5 such definitions is too common to mean anything and is dropped. */
export function siblingDefinitions(repoDir: string, baseSha: string, live: Staged[]): string[] {
  const changed = new Set(live.map(({ f }) => f)), out: string[] = [];
  for (const { st, f } of live) {
    const lang = DEF_RE.find(([re]) => re.test(f)); if (!lang || st !== "M" || isTestFile(f)) continue;
    const starts = safeGit(repoDir, ["diff", "--no-color", "-U0", baseSha, "--", f]).split("\n").map((l) => /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)?.[1]).filter((x): x is string => !!x).map(Number);
    let head: string[] = []; try { head = readFileSync(join(repoDir, f), "utf8").split("\n"); } catch { continue; }
    const names = new Set<string>();
    for (const s of starts) for (let i = Math.min(s, head.length) - 1; i >= 0; i--) { const n = enclosingName(head[i]!); if (n !== null) { if (!SIB_SKIP.has(n)) names.add(n); break; } } // the nearest definition at or above the change
    for (const n of names) {
      let hits: string[] = [];
      try { hits = safeGit(repoDir, ["grep", "-n", "-E", lang[1](n), baseSha, "--"]).split("\n").filter(Boolean).map((l) => l.replace(`${baseSha}:`, "")); } catch { hits = []; }
      const others = hits.map((l) => { const [p, ln] = l.split(":"); return { p: p!, ln: ln! }; }).filter(({ p }) => lang[0].test(p) && !changed.has(p) && !isTestFile(p) && !/(^|\/)(node_modules|vendor|dist|build|target|third_party)\//.test(p));
      if (others.length > 0 && others.length <= 5) for (const o of others) out.push(`${o.p}:${o.ln} (${n})`);
    }
  }
  return [...new Set(out)].slice(0, 10);
}

export const selfReviewWanted = (items: ReviewItem[], mode: SelfReviewMode): boolean => mode === "always" || (mode === "on" && items.some((i) => i.status === "flagged"));
const LABEL: Record<ItemKey, string> = { release_note: "release note", stray_files: "stray files", test: "test", format: "format", scope: "scope", cases: "stated cases", siblings: "sibling definitions", docs: "docs", conventions: "repo conventions" };

/** The review turn's brief: the flagged items, the rules text (capped) and the style configs. Asks for edits only where a rule is concretely broken. */
export function selfReviewBrief(repoDir: string, items: ReviewItem[]): string {
  const guide = contributionGuides(repoDir).slice(0, 6000), style = STYLE_FILES.filter((s) => existsSync(join(repoDir, s)));
  const lines = items.map((i) => `- ${LABEL[i.item]}: ${i.status === "flagged" ? `FLAGGED: ${i.detail}` : i.detail}`);
  return [
    "Pre-delivery review. Before this change goes to a maintainer, review your final diff (run `git diff` and `git status`) against the repository's own rules and fix what a maintainer would reject. Check each item:",
    "(a) release note: a changelog, changeset or news-fragment entry the rules below require, written like the existing ones;",
    "(b) stray files: remove scratch, debug, generated or unrelated files you added;",
    "(c) test: a regression test that exercises the change, in the repository's own test location and style;",
    "(d) format: the changed lines follow the formatter and lint config and the surrounding code style;",
    "(e) scope: undo any edit the task does not need (drive-by refactors, unrelated files, changed public API it did not ask for).",
    ...(items.some((i) => i.item === "cases" || i.item === "siblings") ? [
      "(f) stated cases: every case the issue states (each shown reproduction and its result or error, each \"similar ... when\", \"same effect\", \"both ... and ...\" or \"neither\" sentence) is fixed by the change and has a test that exercises it;",
      "(g) sibling definitions: each other definition of a function you changed (an override, a subclass method, a twin code path) either gets the same fix or is left alone for a reason you state.",
    ] : []),
    ...(items.some((i) => i.item === "docs") ? ["(h) docs: a doc that lists every option, method or name of what you extended also lists the new one, written like its other entries;"] : []),
    ...(items.some((i) => i.item === "conventions") ? ["(i) repo conventions: a pre-commit hook of the repository or an explicit \"never use\" / \"do not use\" rule of its contribution guide rejects a line or a file name you added; change it to what the rule allows (rename the file, rewrite the line);"] : []),
    "Deterministic checks found:", ...lines,
    "Change nothing that already follows the rules: no rewording, no reformatting of lines you did not change, no new edits beyond fixing a broken rule. If an item cannot or should not be changed, keep it and justify it.",
    `End your reply with one line per item, exactly: \`REVIEW <a|b|c|d|e${items.some((i) => i.item === "cases" || i.item === "siblings") ? "|f|g" : ""}${items.some((i) => i.item === "docs") ? "|h" : ""}${items.some((i) => i.item === "conventions") ? "|i" : ""}>: ok|fixed|justified: <short reason>\`, then LOKI_DONE.`,
    style.length ? `Style and lint config in this repository: ${style.join(", ")}.` : "",
    guide ? `Contribution rules (CONTRIBUTING and PR template, as written):\n${guide}` : "The repository has no contribution guide or PR template.",
  ].filter(Boolean).join("\n");
}

const KEY_OF: Record<string, ItemKey> = { a: "release_note", b: "stray_files", c: "test", d: "format", e: "scope", f: "cases", g: "siblings", h: "docs", i: "conventions" };
/** The REVIEW lines of the review turn's reply, by item. */
export function parseReviewLines(reply: string): Map<ItemKey, { verdict: string; reason: string }> {
  const m = new Map<ItemKey, { verdict: string; reason: string }>();
  for (const x of reply.matchAll(/^[ \t]*`?REVIEW[ \t]+([a-i])[ \t]*:[ \t]*(ok|fixed|justified)[ \t]*:?[ \t]*(.*?)`?[ \t]*$/gim)) m.set(KEY_OF[x[1]!.toLowerCase()]!, { verdict: x[2]!.toLowerCase(), reason: x[3]!.trim().slice(0, 200) });
  return m;
}
/** Final status per item: the after-turn deterministic check wins (a flag it no longer finds is fixed); a flag that persists is justified only with a stated reason. */
export function settleItems(before: ReviewItem[], after: ReviewItem[] | null, reply: string | null): ReviewItem[] {
  const said = reply ? parseReviewLines(reply) : new Map();
  return before.map((b) => {
    if (b.status !== "flagged") return b;
    const a = after?.find((x) => x.item === b.item);
    if (a && a.status !== "flagged") return { item: b.item, status: "fixed", detail: `${b.detail}; now: ${a.detail}` };
    const s = said.get(b.item);
    return s && s.verdict === "justified" && s.reason ? { item: b.item, status: "justified", detail: `${b.detail}; reviewer: ${s.reason}` } : { item: b.item, status: after ? "unresolved" : "flagged", detail: b.detail };
  });
}
/** The receipt block; {} when the knob is off or nothing was recorded. */
export type SelfReviewRecord = { mode: string; turn: string | null; items: ReviewItem[]; turn_guard?: TurnGuardRecord; finish?: FinishRecord };
export const selfReviewReceiptBlock = (implement: Record<string, unknown> | undefined): { self_review?: SelfReviewRecord } => (implement && implement["self_review"] ? { self_review: implement["self_review"] as SelfReviewRecord } : {});
/** VF LOKI_E10_VERIFIED_FINISH (acc-168, off by default until measured, =1 on): the review turn becomes a fresh finish session on the delivered diff.
 *  Its brief carries only the review instructions and items, the diff (stray build or run output the commit filter drops is left out), the pre-fix text of
 *  each modified file, and the repo's contribution rules and release-note convention: no task text, no implement transcript. The turn guard always runs on it. */
export const verifiedFinishOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_E10_VERIFIED_FINISH"] ?? "").trim());
export const VERIFIED_FINISH_MAX_TURNS = 8;
export const verifiedFinishMaxTurns = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number((env["LOKI_E10_VERIFIED_FINISH_MAX_TURNS"] ?? "").trim()); return Number.isInteger(n) && n > 0 ? n : VERIFIED_FINISH_MAX_TURNS; };
export type FinishRecord = { fired: true; iteration: string | null; brief_chars: number; diff_files: string[]; left_out: string[] };
export const FINISH_DIFF_MAX = 40_000, FINISH_FILE_MAX = 12_000, FINISH_FILES_MAX = 36_000;
export const FINISH_LEAD = "Finish pass. The change below is already applied, uncommitted, in this checkout. Do not redo, rewrite or extend the fix itself; only bring the change up to the repository's rules.";
/** The finish turn's whole brief and what went into it. */
export function verifiedFinishBrief(repoDir: string, baseSha: string, items: ReviewItem[], task = ""): { brief: string; record: Omit<FinishRecord, "fired" | "iteration"> } {
  const staged = treeStaged(repoDir, baseSha).filter((s) => !s.f.startsWith(".loki/") && !s.f.startsWith(".claude/"));
  const added = staged.filter((s) => s.st === "A").map((s) => s.f);
  const drop = (() => { try { return new Set([...buildArtifacts(repoDir, added, baseSha, task), ...runOutputs(repoDir, added, baseSha, task)]); } catch { return new Set<string>(); } })();
  const kept = staged.filter((s) => !drop.has(s.f)), tracked = kept.filter((s) => { try { safeGit(repoDir, ["cat-file", "-e", `${baseSha}:${s.f}`]); return true; } catch { return false; } });
  let diff = ""; try { diff = tracked.length ? safeGit(repoDir, ["diff", "--no-color", "--no-ext-diff", "--no-renames", baseSha, "--", ...tracked.map((s) => s.f)], { maxBuffer: 64 << 20 }) : ""; } catch { /* unreadable */ }
  for (const s of kept.filter((x) => !tracked.includes(x))) { let t = ""; try { t = readFileSync(join(repoDir, s.f), "utf8"); } catch { continue; } diff += `\n--- /dev/null\n+++ b/${s.f} (new file)\n${t.split("\n").map((l) => `+${l}`).join("\n")}\n`; }
  const pre: string[] = []; let budget = FINISH_FILES_MAX;
  for (const s of tracked.filter((x) => x.st !== "D")) { if (budget <= 0) break; let t = ""; try { t = safeGit(repoDir, ["show", `${baseSha}:${s.f}`], { maxBuffer: 64 << 20 }); } catch { continue; } const cut = t.slice(0, Math.min(FINISH_FILE_MAX, budget)); budget -= cut.length; pre.push(`=== PRE-FIX FILE: ${s.f}${cut.length < t.length ? " (cut)" : ""} ===\n${cut}`); }
  const rn = releaseNoteBrief(repoDir, kept.map((s) => s.f));
  const brief = [FINISH_LEAD, selfReviewBrief(repoDir, items), rn, `=== DIFF (against the base commit) ===\n${diff.slice(0, FINISH_DIFF_MAX)}${diff.length > FINISH_DIFF_MAX ? "\n(diff cut)" : ""}`, ...pre].filter(Boolean).join("\n\n");
  return { brief, record: { brief_chars: brief.length, diff_files: kept.map((s) => s.f), left_out: [...drop] } };
}
/** TG LOKI_E10_REVIEW_TURN_GUARD (acc-167, off by default until measured, =1 on): a finish or review turn that edits anything gets the tests of its edits rerun. A test
 * that fails after the turn and passed with the turn's edits taken back marks the turn as a regression: only that turn's paths go back to the pre-turn
 * tree (the implement diff stays), and the record names the test for the receipt. A test that also fails without the turn keeps the turn. */
export const reviewTurnGuardOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_E10_REVIEW_TURN_GUARD"] ?? "").trim());
export type TurnTestResult = "pass" | "fail" | "not_run";
export type TurnGuardRecord = { paths: string[]; ran: string[]; broke: string[]; reverted: boolean };
const sameEntry = (a: DiffEntry | undefined, b: DiffEntry | undefined): boolean => !a || !b ? a === b : a.kind === b.kind && a.mode === b.mode && a.symlinkTarget === b.symlinkTarget && (a.content && b.content ? a.content.equals(b.content) : a.content === b.content);
/** The paths whose content differs between two snapshots of the same base (a path absent from both equals base in both). */
export function turnChangedPaths(pre: DiffEntry[], post: DiffEntry[]): string[] {
  const a = new Map(pre.map((e) => [e.path, e])), b = new Map(post.map((e) => [e.path, e]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => !sameEntry(a.get(p), b.get(p))).sort();
}
/** Puts exactly `paths` back to how `snap` had them: a snapshot entry is written, a path the snapshot lacks returns to base (or is removed when base lacks it). */
export function restoreTurnPaths(root: string, base: string, snap: DiffEntry[], paths: string[]): void {
  const by = new Map(snap.map((e) => [e.path, e])), write: DiffEntry[] = [], fromBase: string[] = [];
  for (const p of paths) { const e = by.get(p); if (e) write.push(e); else { let inBase = false; try { safeGit(root, ["cat-file", "-e", `${base}:${p}`]); inBase = true; } catch { /* absent on base */ } if (inBase) fromBase.push(p); else write.push({ path: p, kind: "delete" }); } }
  applyDiff(root, write);
  if (fromBase.length) safeGit(root, ["--literal-pathspecs", "checkout", base, "--", ...fromBase]);
}
/** Runs the guard after the turn. `pick` names the tests of the turn's paths; `run` runs one. Null when the turn changed nothing. */
export async function guardReviewTurn<T extends { path: string }>(root: string, base: string, pre: DiffEntry[], pick: (paths: string[]) => T[], run: (t: T) => Promise<TurnTestResult> | TurnTestResult): Promise<TurnGuardRecord | null> {
  const post = snapshotDiff(root, base), paths = turnChangedPaths(pre, post);
  if (!paths.length) return null;
  const ran: string[] = [], failing: T[] = [];
  for (const t of pick(paths)) { const r = await run(t); ran.push(`${t.path}=${r}`); if (r === "fail") failing.push(t); }
  if (!failing.length) return { paths, ran, broke: [], reverted: false };
  restoreTurnPaths(root, base, pre, paths);
  const broke: string[] = [];
  for (const t of failing) { if (!existsSync(join(root, t.path))) continue; const r = await run(t); ran.push(`${t.path}=${r} without the turn`); if (r === "pass") broke.push(t.path); }
  if (broke.length) return { paths, ran, broke, reverted: true };
  restoreTurnPaths(root, base, post, paths);
  return { paths, ran, broke: [], reverted: false };
}
/** The receipt line for a reverted turn. */
export const turnGuardNote = (g: TurnGuardRecord | undefined): string[] => (g?.reverted ? [`review turn reverted: ${g.broke.join(", ")} passed before the turn and failed after it; the turn's edits to ${g.paths.join(", ")} were taken back and the pre-turn diff kept`] : []);
/** CR, deterministic: removes every issue or PR reference the task never gives from the release note the run added (changelog entry lines, changeset or towncrier
 *  fragment text). Runs after the review turn so a reference the model invented never ships. Returns `<path>: #N` per removal; [] when none or CR is off. */
export function stripInventedReleaseRefs(repoDir: string, baseSha: string, staged: Staged[], task: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const conv = (() => { try { return releaseNoteConvention(repoDir, env); } catch { return null; } })();
  if (!conv) return [];
  const out: string[] = [];
  for (const { st, f } of staged) {
    if (!(st === "A" || st === "M") || !(f === conv.dir || f.startsWith(`${conv.dir}/`))) continue;
    let base = ""; if (st === "M") { try { base = safeGit(repoDir, ["show", `${baseSha}:./${f}`], { maxBuffer: 64 << 20 }); } catch { base = ""; } }
    for (const n of stripInventedRefsInFile(join(repoDir, f), base, task, env)) out.push(`${f}: #${n}`);
    if (st === "A") { const r = renameInventedFragment(repoDir, conv, f, task, env); if (r) out.push(`renamed ${r}`); } // ON: an invented fragment number becomes the repo's orphan form
  }
  return out;
}
export const releaseRefsReceiptBlock = (implement: Record<string, unknown> | undefined): { changelog_refs_removed?: string[] } => (Array.isArray(implement?.["changelog_refs_removed"]) && (implement!["changelog_refs_removed"] as unknown[]).length ? { changelog_refs_removed: implement!["changelog_refs_removed"] as string[] } : {});
/** The lines each path adds against base: a diff of the working tree for a tracked path, the whole file for a new one. */
export function addedLines(repoDir: string, baseSha: string, paths: Staged[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const { st, f } of paths) {
    if (st === "A") { try { m.set(f, readFileSync(join(repoDir, f), "utf8").split("\n")); } catch { /* gone */ } continue; }
    try { m.set(f, safeGit(repoDir, ["diff", "--no-color", "-U0", baseSha, "--", f]).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))); } catch { /* unreadable */ }
  }
  return m;
}
/** The staged list against base for an uncommitted tree (index untouched: diff of the working tree plus untracked files). */
export function treeStaged(repoDir: string, baseSha: string): Staged[] {
  const out: Staged[] = [];
  try { const p = safeGit(repoDir, ["diff", "--name-status", "--no-renames", "-z", baseSha]).split("\0"); for (let i = 0; i + 1 < p.length; i += 2) if (p[i]) out.push({ st: p[i]!, f: p[i + 1]! }); } catch { /* unreadable: nothing */ }
  try { for (const f of safeGit(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) if (!out.some((x) => x.f === f)) out.push({ st: "A", f }); } catch { /* none */ }
  return out;
}
