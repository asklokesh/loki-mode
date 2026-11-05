// Zero-model scaffolding (prototype, LOKI_E10_SCAFFOLD=1): deterministic passes the machine runs on the implemented tree
// right before verify, so verify and the fix loop see their result. No model call, no network; every pass is generic
// (keyed on repo files and the diff shape, never on a task). Passes:
//   fragment:   the repo keeps release-note fragments (changesets, towncrier) and the change adds none: write one from
//               the repo's own conventions (package names from the nearest package.json, quote style from existing fragments).
//   systematic: the change rewrote >=2 lines the same way (a rewrite rule learned on the changed tokens and their context); an
//               unchanged line of an edited file that the rule matches gets the same rewrite. The machine runs it as a repair after a
//               red first verify and keeps it only when a failing test or check then passes and nothing new fails.
//   sibling:    detect only: inside a hunk's neighborhood, two calls of one `x = f(x, ...)` form pass different trailing
//               arguments where one site is next to the edit (raw versus normalized input); reported, never applied.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonc } from "../project_model/conventions.ts";
import { isTestFile } from "../util/test_file_text.ts";
import { safeGit } from "../util/safe_git.ts";

export const scaffoldEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_SCAFFOLD === "1";
/** The systematic-edit pass has its own knob (off by default even with LOKI_E10_SCAFFOLD=1): it rewrites code, the fragment writer only adds a file. */
export const systematicEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_SCAFFOLD_SYSTEMATIC === "1";

export interface RewriteEvidence { rule: string; level: "lgg" | "cg"; instances: number; matches: number; matches_home: number; home: boolean; specificity: number }
export interface Rewrite { file: string; line: number; before: string; after: string[]; rule: string; evidence?: RewriteEvidence }
export interface SiblingNote { file: string; edited_line: number; other_line: number; edited: string; other: string }
export interface ScaffoldResult { fragments: string[]; rewrites: Rewrite[]; siblings: SiblingNote[] }

type Change = { st: string; f: string };
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp)$/;

function changedFiles(repoDir: string, baseSha: string): Change[] {
  const tracked = safeGit(repoDir, ["diff", "--name-status", "--no-renames", "-z", baseSha, "--"]).split("\0");
  const out: Change[] = [];
  for (let i = 0; i + 1 < tracked.length; i += 2) if (tracked[i]) out.push({ st: tracked[i]!, f: tracked[i + 1]! });
  for (const f of safeGit(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) if (f) out.push({ st: "A", f });
  return out.filter(({ f }) => !f.startsWith(".loki/"));
}

/** First meaningful line of the task: a title. Strips markdown heading marks, a "Title:" label and a trailing issue ref. */
export function taskTitle(task: string): string {
  const line = task.split("\n").map((l) => l.trim()).find((l) => l && !/^(<<<|TASK$|Task \(untrusted)/.test(l)) ?? "";
  return line.replace(/^#+\s*/, "").replace(/^(title|issue)\s*:\s*/i, "").replace(/\s*\(#\d+\)\s*$/, "").slice(0, 200).trim();
}

// ---------- pass 1: release-note fragment ----------
function nearestPackage(repoDir: string, file: string): { name: string; private: boolean } | null {
  for (let d = dirname(file); ; d = dirname(d)) {
    const p = join(repoDir, d === "." ? "" : d, "package.json");
    if (existsSync(p)) {
      try { const j = JSON.parse(readFileSync(p, "utf8")) as { name?: unknown; private?: unknown }; return typeof j.name === "string" ? { name: j.name, private: j.private === true } : null; } catch { return null; }
    }
    if (d === "." || d === "/" || d === "") return null;
  }
}

const slug = (s: string): string => s.toLowerCase().replace(/[`'"]/g, "").split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6).join("-") || "change";

function changesetFragment(repoDir: string, changes: Change[], task: string): string | null {
  const dir = join(repoDir, ".changeset"), cfgPath = join(dir, "config.json");
  if (!existsSync(cfgPath)) return null;
  if (changes.some(({ st, f }) => st !== "D" && /^\.changeset\/[^/]+\.md$/.test(f) && !/README\.md$/i.test(f))) return null; // the change already carries one
  let cfg: { ignore?: unknown } = {};
  try { cfg = (parseJsonc(readFileSync(cfgPath, "utf8")) ?? {}) as { ignore?: unknown }; } catch { /* default config */ }
  const ignore = Array.isArray(cfg.ignore) ? cfg.ignore.map(String) : [];
  const names = new Set<string>();
  for (const { st, f } of changes) {
    if (st === "D" || !CODE.test(f) || isTestFile(f) || f.startsWith(".changeset/")) continue;
    const pkg = nearestPackage(repoDir, f);
    if (pkg && !pkg.private && !ignore.includes(pkg.name)) names.add(pkg.name);
  }
  if (names.size === 0) return null;
  // the repo's own quote style, read from its newest existing fragment; single quotes are the changesets CLI default
  let quote = "'";
  try {
    const ex = readdirSync(dir).filter((n) => n.endsWith(".md") && !/^README\.md$/i.test(n)).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    const m = ex ? /^---\s*\n\s*(["'])/.exec(readFileSync(join(dir, ex.n), "utf8")) : null; if (m) quote = m[1]!;
  } catch { /* keep default */ }
  const title = taskTitle(task), bump = /^(feat|feature)\b/i.test(title) ? "minor" : "patch";
  let name = `${slug(title)}.md`; for (let i = 2; existsSync(join(dir, name)); i++) name = `${slug(title)}-${i}.md`;
  const body = `---\n${[...names].sort().map((n) => `${quote}${n}${quote}: ${bump}`).join("\n")}\n---\n\n${title.replace(/\s+$/, "")}${/[.!?]$/.test(title) ? "" : "."}\n`;
  writeFileSync(join(dir, name), body);
  return `.changeset/${name}`;
}

function towncrierFragment(repoDir: string, changes: Change[], task: string): string | null {
  const pp = join(repoDir, "pyproject.toml"), tc = join(repoDir, "towncrier.toml");
  const src = existsSync(tc) ? readFileSync(tc, "utf8") : existsSync(pp) ? readFileSync(pp, "utf8") : "";
  if (!/\[tool\.towncrier\]/.test(src)) return null;
  const dirRel = /^\s*directory\s*=\s*["']([^"']+)["']/m.exec(src)?.[1] ?? "newsfragments";
  if (changes.some(({ st, f }) => st !== "D" && f.startsWith(`${dirRel.replace(/\/$/, "")}/`))) return null;
  if (!changes.some(({ st, f }) => st !== "D" && CODE.test(f) && !isTestFile(f))) return null;
  const issue = /(?:^|[\s(])#(\d+)\b/.exec(task)?.[1]; if (!issue) return null; // towncrier names fragments by issue; no number, no guess
  const types = [...src.matchAll(/directory\s*=\s*["'](\w+)["']/g)].map((m) => m[1]!).filter((t) => t !== dirRel);
  const kind = /^(feat|feature|add)\b/i.test(taskTitle(task)) ? (types.find((t) => /feat/.test(t)) ?? "feature") : (types.find((t) => /bug|fix/.test(t)) ?? "bugfix");
  const name = `${issue}.${kind}.md`, abs = join(repoDir, dirRel, name);
  if (existsSync(abs) || !existsSync(join(repoDir, dirRel))) return null;
  writeFileSync(abs, `${taskTitle(task)}\n`);
  return `${dirRel}/${name}`;
}

// ---------- pass 2: systematic-edit completion ----------
// A rule is learned on the changed part of a line, not the whole line. Each rewritten line (an n-to-n hunk pairs line i with
// line i; a 1-to-k hunk is one rewrite into k lines) is cut to the tokens between its common prefix and common suffix. Cuts
// with the same token kinds are anti-unified: a token every instance shares stays literal, an identifier, string or number
// that differs becomes a hole (one hole per tuple of values, so the equality pattern between holes is learned). Context grows
// outwards from the cut while the instances agree, up to `ctx` tokens a side, and pins the line edge when every instance sat
// on it. A rule needs `minInstances` instances, a literal identifier on its matching side (an anchor) and every hole its new
// side writes bound by its old side (a name only the new side has is never invented). Unchanged lines of the edited files and,
// with scope "dir", of their same-directory siblings that match the old side get the new side, rendered from an exemplar's text.
const KEYWORDS = new Set(["if", "else", "elif", "for", "while", "return", "var", "let", "const", "func", "function", "def", "class", "new", "await", "async", "in", "is", "not", "and", "or", "switch", "case", "default", "break", "continue", "true", "false", "nil", "null", "undefined", "None", "True", "False", "this", "self", "range", "go", "defer", "try", "catch", "finally", "throw", "raise", "except", "import", "from", "export", "type", "interface", "struct", "map", "chan", "select", "yield", "lambda", "pass", "with", "as", "typeof", "instanceof", "void", "delete", "do", "of"]);
const IDENT = /^[A-Za-z_$][\w$]*$/;
const TOKEN_REST = String.raw`[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`[^`\\n]*`" + String.raw`|===|!==|\*\*|:=|==|!=|<=|>=|=>|->|&&|\|\||\?\?|\?\.|\.\.\.|\S`;
const TOKEN_C = new RegExp(String.raw`\/\/.*|\/\*.*?\*\/|` + TOKEN_REST, "g"), TOKEN_PY = new RegExp("#.*|" + TOKEN_REST, "g");
interface Tok { t: string; k: string; s: number; e: number } // k: kind; an identifier, string or number may become a hole, any other token is matched literally
const kindOf = (t: string): string => (IDENT.test(t) ? (KEYWORDS.has(t) ? `w:${t}` : "id") : /^["'`]/.test(t) ? "str" : /^\d/.test(t) ? "num" : `p:${t}`);
const isPy = (file: string): boolean => file.endsWith(".py");
/** Tokens of one or more lines (joined by "\n"; offsets index the joined text). A comment ends a line's tokens. */
function tokenize(lines: string[], py: boolean): Tok[] {
  const out: Tok[] = []; let base = 0;
  for (const line of lines) {
    for (const m of line.matchAll(py ? TOKEN_PY : TOKEN_C)) {
      const t = m[0];
      if ((py && t.startsWith("#")) || (!py && t.startsWith("//"))) break;
      if (!py && t.startsWith("/*")) continue;
      out.push({ t, k: kindOf(t), s: base + m.index!, e: base + m.index! + t.length });
    }
    base += line.length + 1;
  }
  return out;
}
const isCommentLine = (l: string, py: boolean): boolean => (py ? /^\s*#/ : /^\s*(\/\/|\/\*|\*)/).test(l);

type Hunk = { oldStart: number; removed: string[]; newStart: number; added: string[] };
function hunks(diff: string): Hunk[] {
  const out: Hunk[] = []; let cur: Hunk | null = null;
  for (const l of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { cur = { oldStart: +h[1]!, removed: [], newStart: +h[2]!, added: [] }; out.push(cur); continue; }
    if (!cur || l.startsWith("---") || l.startsWith("+++")) continue;
    if (l.startsWith("-")) cur.removed.push(l.slice(1)); else if (l.startsWith("+")) cur.added.push(l.slice(1));
  }
  return out;
}

/** One rewritten line: old tokens o, new tokens n (over the k new lines joined), and the common prefix p and suffix s. */
interface Inst { file: string; o: Tok[]; n: Tok[]; nText: string; p: number; s: number; indent: string }
type El = { lit: string } | { hole: number };
/** level lgg: the least general rule (a name every instance shares stays literal); cg: also generalizes carried names (on both sides of
 *  every instance), so only the names the change removes stay literal. */
interface Rule { left: El[]; old: El[]; right: El[]; neu: El[]; bol: boolean; eol: boolean; vals: string[][]; kinds: string[]; inst: Inst[]; level: "lgg" | "cg" }
/** ctx: context tokens a side; scope: scan the edited files only, or also their same-directory siblings; fanout: a rule may rewrite at
 *  most fanout x its instance count of lines (it learned from what the change did, so it may not do much more than that); diag:
 *  return every candidate with its evidence, unguarded (the recall probe sweeps guards offline). */
export interface SystematicOpts { ctx: number; scope: "file" | "dir"; minInstances: number; affix: boolean; taskNames: boolean; fanout: number; diag: boolean }
export const SYSTEMATIC_DEFAULTS: SystematicOpts = { ctx: 2, scope: "file", minInstances: 2, affix: true, taskNames: false, fanout: 1, diag: false };

function instOf(file: string, oldLine: string, newLines: string[]): Inst | null {
  const py = isPy(file), o = tokenize([oldLine], py), n = tokenize(newLines, py);
  let p = 0; while (p < o.length && p < n.length && o[p]!.t === n[p]!.t) p++;
  let s = 0; while (s < o.length - p && s < n.length - p && o[o.length - 1 - s]!.t === n[n.length - 1 - s]!.t) s++;
  if (p === o.length && p === n.length) return null; // whitespace or comment only
  return { file, o, n, nText: newLines.join("\n"), p, s, indent: /^\s*/.exec(oldLine)![0] };
}
const cutKinds = (x: Inst): string => `${x.o.slice(x.p, x.o.length - x.s).map((t) => t.k).join(" ")}\u0001${x.n.slice(x.p, x.n.length - x.s).map((t) => t.k).join(" ")}`;

/** The most specific rule every instance fits (cg: with carried names generalized), or null when they do not share one: kinds differ,
 *  or the new side writes a name the matched window does not bind. */
function antiUnify(xs: Inst[], ctx: number, level: "lgg" | "cg" = "lgg"): Rule | null {
  const holes = new Map<string, number>(), vals: string[][] = [], kinds: string[] = [];
  const carried = (t: string): boolean => xs.every((x) => x.o.some((o) => o.t === t) && x.n.some((n) => n.t === t));
  const el = (ts: Tok[]): El | null => {
    if (ts.every((t) => t.t === ts[0]!.t) && !(level === "cg" && ts[0]!.k === "id" && carried(ts[0]!.t))) return { lit: ts[0]!.t };
    const k = ts[0]!.k;
    if (!(k === "id" || k === "str" || k === "num") || ts.some((t) => t.k !== k)) return null;
    const key = ts.map((t) => t.t).join("\u0000");
    let h = holes.get(key);
    if (h === undefined) { h = vals.length; holes.set(key, h); vals.push(ts.map((t) => t.t)); kinds.push(k); }
    return { hole: h };
  };
  const x0 = xs[0]!, oLen = x0.o.length - x0.p - x0.s, nLen = x0.n.length - x0.p - x0.s;
  const old: El[] = [];
  for (let j = 0; j < oLen; j++) { const e = el(xs.map((x) => x.o[x.p + j]!)); if (!e) return null; old.push(e); }
  const left: El[] = [], right: El[] = [];
  let bol = false, eol = false;
  for (let d = 1; ; d++) {
    if (xs.every((x) => x.p - d < 0)) { bol = true; break; }
    if (d > ctx || xs.some((x) => x.p - d < 0)) break;
    const e = el(xs.map((x) => x.o[x.p - d]!)); if (!e) break; left.unshift(e);
  }
  for (let d = 0; ; d++) {
    if (xs.every((x) => x.o.length - x.s + d >= x.o.length)) { eol = true; break; }
    if (d >= ctx || xs.some((x) => x.o.length - x.s + d >= x.o.length)) break;
    const e = el(xs.map((x) => x.o[x.o.length - x.s + d]!)); if (!e) break; right.push(e);
  }
  const neu: El[] = [], windowLits = new Set([...left, ...old, ...right].flatMap((e) => ("lit" in e ? [e.lit] : [])));
  for (let j = 0; j < nLen; j++) {
    const ts = xs.map((x) => x.n[x.p + j]!), h = holes.get(ts.map((t) => t.t).join("\u0000"));
    if (h !== undefined) { neu.push({ hole: h }); continue; }
    if (!ts.every((t) => t.t === ts[0]!.t)) return null; // the new side writes a per-site name its old side does not bind: an invention, not a rule
    // a name the new side carries over from the old line must be one the window matched, or another site would get this site's name
    if (ts[0]!.k === "id" && xs.every((x) => x.o.some((o) => o.t === ts[0]!.t)) && !windowLits.has(ts[0]!.t)) return null;
    neu.push({ lit: ts[0]!.t });
  }
  return { left, old, right, neu, bol, eol, vals, kinds, inst: xs, level };
}
/** A rule must name something: a literal identifier on the side it matches. A rule of holes and punctuation matches anything. */
const anchored = (r: Rule): boolean => [...r.left, ...r.old, ...r.right].some((e) => "lit" in e && IDENT.test(e.lit) && !KEYWORDS.has(e.lit));

const ruleKey = (r: Rule): string => JSON.stringify([r.left, r.old, r.right, r.neu, r.bol, r.eol]);
/** Literal tokens on the matching side: an identifier counts 2, any other token 1. More is more specific. */
const specificity = (r: Rule): number => [...r.left, ...r.old, ...r.right].reduce((n, e) => n + ("lit" in e ? (IDENT.test(e.lit) ? 2 : 1) : 0), 0);
const MAX_GROUP = 40; // instances per cut shape considered for pairing (a mass edit holds hundreds of one shape)
/** One rule per pair of instances of a cut shape: a pair with matching surroundings keeps its long context, a pair from different
 *  surroundings yields a general rule. Each rule then counts every instance it reproduces exactly; the fan-out guard decides later. */
function learnRules(xs: Inst[], o: SystematicOpts): Rule[] {
  const groups = new Map<string, Inst[]>();
  for (const x of xs) groups.set(cutKinds(x), [...(groups.get(cutKinds(x)) ?? []), x]);
  const out = new Map<string, Rule>();
  for (const all of groups.values()) {
    const g = all.slice(0, MAX_GROUP);
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) for (const level of ["lgg", "cg"] as const) {
      const u = antiUnify([g[i]!, g[j]!], o.ctx, level);
      if (!u || !anchored(u)) continue;
      const key = ruleKey(u);
      if (out.has(key)) continue;
      const inst = g.filter((x) => { if (x === g[i] || x === g[j]) return true; const v = antiUnify([g[i]!, g[j]!, x], o.ctx, level); return v !== null && ruleKey(v) === key; });
      if (inst.length >= o.minInstances) out.set(key, { ...u, inst });
    }
  }
  return [...out.values()];
}

const commonAffix = (vs: string[], end: boolean): string => {
  let a = vs[0] ?? "";
  for (const v of vs) { let i = 0; while (i < a.length && i < v.length && (end ? a[a.length - 1 - i] === v[v.length - 1 - i] : a[i] === v[i])) i++; a = end ? a.slice(a.length - i) : a.slice(0, i); }
  return a;
};
const taskIdents = (task: string): Set<string> => new Set([...task.matchAll(/[A-Za-z_]\w{2,}/g)].map((m) => m[0]));

interface Match { rule: Rule; bind: string[]; r0: number; r1: number }
function matchAt(r: Rule, toks: Tok[], i: number): Match | null {
  const win = [...r.left, ...r.old, ...r.right];
  if (i + win.length > toks.length || (r.bol && i !== 0) || (r.eol && i + win.length !== toks.length) || win.length === 0) return null;
  const bind: string[] = [];
  for (let j = 0; j < win.length; j++) {
    const e = win[j]!, t = toks[i + j]!;
    if ("lit" in e) { if (t.t !== e.lit) return null; continue; }
    if (t.k !== r.kinds[e.hole]) return null;
    if (bind[e.hole] === undefined) bind[e.hole] = t.t; else if (bind[e.hole] !== t.t) return null;
  }
  return { rule: r, bind, r0: i + r.left.length, r1: i + r.left.length + r.old.length };
}
function admissible(m: Match, o: SystematicOpts, named: Set<string>): boolean {
  const { rule: r, bind } = m;
  if (bind.some((b, h) => b === "_" && r.kinds[h] === "id")) return false; // binds the blank identifier
  if (o.affix) for (let h = 0; h < bind.length; h++) { // a hole whose values share a 3+ char prefix or suffix is that family of names
    if (r.kinds[h] !== "id" || bind[h] === undefined || r.vals[h]!.every((v) => v === r.vals[h]![0])) continue;
    const pre = commonAffix(r.vals[h]!, false), suf = commonAffix(r.vals[h]!, true);
    if ((pre.length >= 3 && !bind[h]!.startsWith(pre)) || (suf.length >= 3 && !bind[h]!.endsWith(suf))) return false;
  }
  if (o.taskNames) { const diff = bind.filter((b, h) => b !== undefined && !r.vals[h]!.includes(b)); if (diff.length && !diff.some((b) => named.has(b))) return false; }
  return true;
}

/** The exemplar's new text from `from` to `to` (offsets in its joined new lines) with each new-side hole replaced by the candidate's binding. */
function fill(ex: Inst, r: Rule, bind: string[], from: number, to: number): string {
  let out = ex.nText.slice(from, to);
  for (let j = r.neu.length - 1; j >= 0; j--) {
    const e = r.neu[j]!, t = ex.n[ex.p + j]!;
    if (!("hole" in e) || t.s < from || t.e > to) continue;
    out = out.slice(0, t.s - from) + bind[e.hole]! + out.slice(t.e - from);
  }
  return out;
}
/** The candidate line with one match rewritten; the candidate keeps its own whitespace around the cut, a multi-line new side takes its indentation. */
function renderOne(line: string, toks: Tok[], m: Match): string {
  const r = m.rule, ex = r.inst.find((x) => (m.r0 > 0) === (x.p > 0)) ?? r.inst[0]!, k = r.neu.length;
  const indent = /^\s*/.exec(line)![0], reindent = (s: string): string => s.split(`\n${ex.indent}`).join(`\n${indent}`);
  if (m.r1 > m.r0) { // the old side is replaced (or deleted)
    if (k === 0) {
      const [a, b] = m.r0 > 0 ? [toks[m.r0 - 1]!.e, toks[m.r1 - 1]!.e] : [toks[m.r0]!.s, m.r1 < toks.length ? toks[m.r1]!.s : toks[m.r1 - 1]!.e];
      return line.slice(0, a) + line.slice(b);
    }
    const t = reindent(fill(ex, r, m.bind, ex.n[ex.p]!.s, ex.n[ex.p + k - 1]!.e));
    return line.slice(0, toks[m.r0]!.s) + t + line.slice(toks[m.r1 - 1]!.e);
  }
  if (k === 0) return line; // nothing to insert
  if (m.r0 > 0 && ex.p > 0) { const at = toks[m.r0 - 1]!.e; return line.slice(0, at) + reindent(fill(ex, r, m.bind, ex.n[ex.p - 1]!.e, ex.n[ex.p + k - 1]!.e)) + line.slice(at); }
  const at = toks[m.r0]?.s ?? line.length, end = ex.p + k < ex.n.length ? ex.n[ex.p + k]!.s : ex.n[ex.p + k - 1]!.e;
  return line.slice(0, at) + reindent(fill(ex, r, m.bind, ex.n[ex.p]!.s, end)) + line.slice(at);
}

/** Lines the change rewrote the same way at >= minInstances places; the other places of that shape, rewritten. Dry: never writes. */
export function systematicRewrites(repoDir: string, baseSha: string, task: string, opts: Partial<SystematicOpts> = {}, changes: Change[] = changedFiles(repoDir, baseSha)): Rewrite[] {
  const o = { ...SYSTEMATIC_DEFAULTS, ...opts };
  const files = changes.filter(({ st, f }) => st === "M" && CODE.test(f) && !isTestFile(f)).map(({ f }) => f);
  const wrote = new Map<string, Set<number>>(), xs: Inst[] = [];
  for (const f of files) {
    const set = new Set<number>(); wrote.set(f, set);
    for (const h of hunks(safeGit(repoDir, ["diff", "-U0", "--no-color", baseSha, "--", f]))) {
      for (let i = 0; i < h.added.length; i++) set.add(h.newStart + i);
      if (h.removed.length === 0 || h.added.length === 0) continue;
      const pairs: [string, string[]][] = h.removed.length === h.added.length ? h.removed.map((r, i) => [r, [h.added[i]!]]) : h.removed.length === 1 ? [[h.removed[0]!, h.added]] : [];
      for (const [r, a] of pairs) { if (isCommentLine(r, isPy(f))) continue; const x = instOf(f, r, a); if (x) xs.push(x); }
    }
  }
  const rules = learnRules(xs, o);
  if (rules.length === 0) return [];
  const named = taskIdents(task);
  const scan = new Map<string, Rule[]>(), home = new Map<Rule, Set<string>>(), listed = new Map<string, string[]>();
  for (const r of rules) {
    const fs = new Set(r.inst.map((x) => x.file)); home.set(r, new Set(fs));
    if (o.scope === "dir") for (const f of [...fs]) {
      const dir = dirname(f), ext = /\.[^.]+$/.exec(f)![0];
      if (!listed.has(dir)) listed.set(dir, safeGit(repoDir, ["ls-files", "-z", "--", dir === "." ? "." : dir]).split("\0").filter((g) => g && dirname(g) === dir && !isTestFile(g)));
      for (const g of listed.get(dir)!) if (g.endsWith(ext)) fs.add(g);
    }
    for (const f of fs) scan.set(f, [...(scan.get(f) ?? []), r]);
  }
  // Every rule's matches first: its fan-out (distinct lines it would rewrite) decides whether it may rewrite any of them.
  type Hit = { f: string; n: number; line: string; py: boolean; byRule: Map<Rule, Match[]> };
  const hits: Hit[] = [], fan = new Map<Rule, number>(), fanHome = new Map<Rule, number>();
  for (const [f, rs] of scan) {
    let text: string; try { text = readFileSync(join(repoDir, f), "utf8"); } catch { continue; }
    const lines = text.split("\n"), w = wrote.get(f) ?? new Set<number>(), py = isPy(f);
    for (let n = 0; n < lines.length; n++) {
      if (w.has(n + 1) || isCommentLine(lines[n]!, py)) continue;
      const toks = tokenize([lines[n]!], py), byRule = new Map<Rule, Match[]>();
      for (const r of rs) {
        const ms: Match[] = [];
        for (let i = 0; i < toks.length; i++) { const m = matchAt(r, toks, i); if (m && admissible(m, o, named)) { ms.push(m); i += r.left.length + r.old.length + r.right.length - 1; } }
        if (ms.length) { byRule.set(r, ms); fan.set(r, (fan.get(r) ?? 0) + 1); if (home.get(r)!.has(f)) fanHome.set(r, (fanHome.get(r) ?? 0) + 1); }
      }
      if (byRule.size) hits.push({ f, n, line: lines[n]!, py, byRule });
    }
  }
  const out: Rewrite[] = [];
  for (const h of hits) {
    // the most specific rule that matched this line and passes the fan-out guard (diag: every rule, unguarded, one rewrite each)
    const ranked = [...h.byRule.keys()].sort((a, b) => specificity(b) - specificity(a) || b.inst.length - a.inst.length);
    for (const r of ranked) {
      const evidence = { rule: ruleKey(r), level: r.level, instances: r.inst.length, matches: fan.get(r)!, matches_home: fanHome.get(r) ?? 0, home: home.get(r)!.has(h.f), specificity: specificity(r) };
      if (!o.diag && evidence.matches > o.fanout * evidence.instances) continue;
      let after = h.line;
      for (const m of [...h.byRule.get(r)!].reverse()) after = renderOne(after, tokenize([after], h.py), m); // right to left, so earlier offsets stay valid
      if (after === h.line) continue;
      out.push({ file: h.f, line: h.n + 1, before: h.line, after: after.split("\n"), rule: `${r.inst.length} lines were rewritten this way; the rule matches ${evidence.matches} unchanged line(s)`, ...(o.diag ? { evidence } : {}) });
      if (!o.diag) break;
    }
  }
  return out;
}

function applyRewrites(repoDir: string, rw: Rewrite[]): void {
  const byFile = new Map<string, Rewrite[]>();
  for (const r of rw) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  for (const [f, list] of byFile) {
    const lines = readFileSync(join(repoDir, f), "utf8").split("\n");
    for (const r of [...list].sort((a, b) => b.line - a.line)) if (lines[r.line - 1] === r.before) lines.splice(r.line - 1, 1, ...r.after);
    writeFileSync(join(repoDir, f), lines.join("\n"));
  }
}
/** Restores each applied rewrite's original line (top down, so a rewrite above has already shrunk back). Returns the rewrites restored;
 *  one whose lines no longer read as written (something edited them since) is left alone. */
export function undoRewrites(repoDir: string, rw: Rewrite[]): Rewrite[] {
  const done: Rewrite[] = [], byFile = new Map<string, Rewrite[]>();
  for (const r of rw) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  for (const [f, list] of byFile) {
    let lines: string[]; try { lines = readFileSync(join(repoDir, f), "utf8").split("\n"); } catch { continue; }
    let shift = 0; // lines added above by rewrites that are still applied (a skipped one keeps its extra lines)
    for (const r of [...list].sort((a, b) => a.line - b.line)) {
      const at = r.line - 1 + shift;
      if (r.after.every((l, i) => lines[at + i] === l)) { lines.splice(at, r.after.length, r.before); done.push(r); } else shift += r.after.length - 1;
    }
    writeFileSync(join(repoDir, f), lines.join("\n"));
  }
  return done;
}
/** The machine's zero-model repair after a red first verify: proposes the systematic completions and writes them. The machine keeps them only
 *  when a failing test or check now passes and nothing new fails (undoRewrites otherwise). */
export function repairRewrites(repoDir: string, baseSha: string, task: string): Rewrite[] {
  const rw = systematicRewrites(repoDir, baseSha, task);
  if (rw.length) applyRewrites(repoDir, rw);
  return rw;
}

// ---------- pass 3: sibling-argument consistency (detect only) ----------
function siblings(repoDir: string, baseSha: string, changes: Change[]): SiblingNote[] {
  const out: SiblingNote[] = [];
  // `acc = f(acc, ARG)` (Go append) or `acc.push|append|add(ARG)`: an accumulation site, keyed by accumulator and callee
  const site = (l: string): { key: string; arg: string } | null => {
    const a = /^\s*([\w.]+)\s*(?:=|:=)\s*([\w.]+)\(\s*\1\s*,\s*(.+?)\)\s*;?\s*$/.exec(l); if (a) return { key: `${a[1]}=${a[2]}`, arg: a[3]!.trim() };
    const b = /^\s*([\w.]+)\.(push|append|add)\(\s*(.+?)\)\s*;?\s*$/.exec(l); return b ? { key: `${b[1]}.${b[2]}`, arg: b[3]!.trim() } : null;
  };
  for (const { st, f } of changes) {
    if (st !== "M" || !CODE.test(f) || isTestFile(f)) continue;
    const lines = readFileSync(join(repoDir, f), "utf8").split("\n");
    for (const h of hunks(safeGit(repoDir, ["diff", "-U0", "--no-color", baseSha, "--", f]))) {
      const lo = Math.max(0, h.newStart - 1 - 2), hi = Math.min(lines.length, h.newStart - 1 + Math.max(h.added.length, 1) + 2);
      for (let e = lo; e < hi; e++) {
        const a = site(lines[e]!); if (!a || !/^[A-Za-z_]\w*$/.test(a.arg)) continue;
        // the edited site passes a local derived from an expression: find that derivation above it
        let rhs: string | null = null;
        for (let k = e - 1; k >= Math.max(0, e - 60) && rhs === null; k--) { const m = new RegExp(`^\\s*(?:(?:const|let|var)\\s+)?${a.arg}\\s*(?::=|=)\\s*(.+?)\\s*;?\\s*$`).exec(lines[k]!); if (m) rhs = m[1]!; }
        if (!rhs) continue;
        for (let o = Math.max(0, e - 40); o < Math.min(lines.length, e + 40); o++) {
          const b = o === e ? null : site(lines[o]!);
          // the sibling passes the raw input the edited site's local was derived from (normalized versus raw)
          if (b && b.key === a.key && b.arg !== a.arg && rhs !== b.arg && rhs.includes(b.arg) && !out.some((x) => x.file === f && x.edited_line === e + 1 && x.other_line === o + 1)) out.push({ file: f, edited_line: e + 1, other_line: o + 1, edited: lines[e]!.trim(), other: lines[o]!.trim() });
        }
      }
    }
  }
  return out;
}

export function scaffold(repoDir: string, baseSha: string, task: string, opts: { apply?: boolean; systematic?: boolean } = {}): ScaffoldResult {
  const changes = changedFiles(repoDir, baseSha);
  const res: ScaffoldResult = { fragments: [], rewrites: [], siblings: [] };
  if (changes.length === 0) return res; // nothing implemented: nothing to scaffold
  const rw = opts.systematic === true ? systematicRewrites(repoDir, baseSha, task, {}, changes) : []; // the machine runs the systematic pass as a repair after verify (repairRewrites); the fixture driver asks for it here
  if (opts.apply !== false && rw.length) applyRewrites(repoDir, rw);
  res.rewrites = rw;
  res.siblings = siblings(repoDir, baseSha, changes);
  for (const w of [changesetFragment, towncrierFragment]) { const f = w(repoDir, changes, task); if (f) res.fragments.push(f); }
  return res;
}
