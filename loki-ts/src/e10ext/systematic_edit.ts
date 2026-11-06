// Systematic-edit completer (on by default; LOKI_E10_SYSEDIT=0 opts out): a zero-model repair run once after a red first verify. When the change
// rewrote >=2 lines the same way (a rewrite rule learned on the changed tokens and their context), an unchanged line of an edited file that the
// rule matches gets the same rewrite. The machine keeps the completion only when a failing check then passes and nothing new fails; otherwise
// restoreRewrites puts every touched file back byte for byte. Proposals are low precision (0.216 blind, tests/min/fixtures/scaffold/recall-results
// on the proto branch), so the verify gate is the only safety. No model call, no network, never keyed on a task.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestFile } from "../util/test_file_text.ts";
import { parseDiffHunks } from "../util/secure_scan.ts";
import { safeGit } from "../util/safe_git.ts";

export const sysEditEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_SYSEDIT !== "0";

export interface Rewrite { file: string; line: number; before: string; after: string[]; rule: string }
/** What a repair wrote: the rewrites and each touched file's exact text before and after, so an undo restores the bytes. */
export interface Repair { rewrites: Rewrite[]; files: { file: string; before: string; after: string }[] }

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp)$/;

// Rule learning: each line the change rewrote is an instance (old tokens, new tokens, the common prefix and suffix around the cut). Two
// instances of one cut shape are anti-unified into a rule: tokens they share stay literal, tokens that differ become holes (identifier,
// string, number), and the matching window grows outwards from the cut while the instances agree, up to `ctx` tokens a side, pinning the
// line edge when every instance sat on it. A rule needs `minInstances` instances, a literal identifier on its matching side (an anchor)
// and every hole its new side writes bound by its old side (a name only the new side has is never invented). Unchanged lines of the
// edited files that match the old side get the new side, rendered from an exemplar's text.
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

/** One rewritten line: old tokens o, new tokens n (over the k new lines joined), and the common prefix p and suffix s. */
interface Inst { file: string; o: Tok[]; n: Tok[]; nText: string; p: number; s: number; indent: string }
type El = { lit: string } | { hole: number };
/** level lgg: the least general rule (a name every instance shares stays literal); cg: also generalizes carried names (on both sides of
 *  every instance), so only the names the change removes stay literal. */
interface Rule { left: El[]; old: El[]; right: El[]; neu: El[]; bol: boolean; eol: boolean; vals: string[][]; kinds: string[]; inst: Inst[]; level: "lgg" | "cg" }
/** ctx: context tokens a side; fanout: a rule may rewrite at most fanout x its instance count of lines (it learned from what the change
 *  did, so it may not do much more than that). Only the edited files are scanned. */
interface SystematicOpts { ctx: number; minInstances: number; affix: boolean; fanout: number }
const DEFAULTS: SystematicOpts = { ctx: 2, minInstances: 2, affix: true, fanout: 1 };

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
function admissible(m: Match, o: SystematicOpts): boolean {
  const { rule: r, bind } = m;
  if (bind.some((b, h) => b === "_" && r.kinds[h] === "id")) return false; // binds the blank identifier
  if (o.affix) for (let h = 0; h < bind.length; h++) { // a hole whose values share a 3+ char prefix or suffix is that family of names
    if (r.kinds[h] !== "id" || bind[h] === undefined || r.vals[h]!.every((v) => v === r.vals[h]![0])) continue;
    const pre = commonAffix(r.vals[h]!, false), suf = commonAffix(r.vals[h]!, true);
    if ((pre.length >= 3 && !bind[h]!.startsWith(pre)) || (suf.length >= 3 && !bind[h]!.endsWith(suf))) return false;
  }
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
export function systematicRewrites(repoDir: string, baseSha: string): Rewrite[] {
  const o = DEFAULTS;
  const files = safeGit(repoDir, ["-c", "core.quotePath=false", "diff", "--diff-filter=M", "--no-renames", "--name-only", "-z", baseSha, "--"]).split("\0").filter((f) => f && !f.startsWith(".loki/") && CODE.test(f) && !isTestFile(f));
  const wrote = new Map<string, Set<number>>(), xs: Inst[] = [];
  for (const f of files) {
    const set = new Set<number>(); wrote.set(f, set);
    for (const h of parseDiffHunks(safeGit(repoDir, ["diff", "-U0", "--no-color", baseSha, "--", f])).get(f) ?? []) { // reused: secure_scan's -U0 parser (new-file line numbers, removed text)
      for (const a of h.added) set.add(a.line);
      if (h.removed.length === 0 || h.added.length === 0) continue;
      const added = h.added.map((a) => a.text);
      const pairs: [string, string[]][] = h.removed.length === added.length ? h.removed.map((r, i) => [r, [added[i]!]]) : h.removed.length === 1 ? [[h.removed[0]!, added]] : [];
      for (const [r, a] of pairs) { if (isCommentLine(r, isPy(f))) continue; const x = instOf(f, r, a); if (x) xs.push(x); }
    }
  }
  const rules = learnRules(xs, o);
  if (rules.length === 0) return [];
  const scan = new Map<string, Rule[]>();
  for (const r of rules) for (const f of new Set(r.inst.map((x) => x.file))) scan.set(f, [...(scan.get(f) ?? []), r]);
  // Every rule's matches first: its fan-out (distinct lines it would rewrite) decides whether it may rewrite any of them.
  type Hit = { f: string; n: number; line: string; py: boolean; byRule: Map<Rule, Match[]> };
  const hits: Hit[] = [], fan = new Map<Rule, number>();
  for (const [f, rs] of scan) {
    let text: string; try { text = readFileSync(join(repoDir, f), "utf8"); } catch { continue; }
    const lines = text.split("\n"), w = wrote.get(f) ?? new Set<number>(), py = isPy(f);
    for (let n = 0; n < lines.length; n++) {
      if (w.has(n + 1) || isCommentLine(lines[n]!, py)) continue;
      const toks = tokenize([lines[n]!], py), byRule = new Map<Rule, Match[]>();
      for (const r of rs) {
        const ms: Match[] = [];
        for (let i = 0; i < toks.length; i++) { const m = matchAt(r, toks, i); if (m && admissible(m, o)) { ms.push(m); i += r.left.length + r.old.length + r.right.length - 1; } }
        if (ms.length) { byRule.set(r, ms); fan.set(r, (fan.get(r) ?? 0) + 1); }
      }
      if (byRule.size) hits.push({ f, n, line: lines[n]!, py, byRule });
    }
  }
  const out: Rewrite[] = [];
  for (const h of hits) {
    // the most specific rule that matched this line and passes the fan-out guard
    const ranked = [...h.byRule.keys()].sort((a, b) => specificity(b) - specificity(a) || b.inst.length - a.inst.length);
    for (const r of ranked) {
      const matches = fan.get(r)!;
      if (matches > o.fanout * r.inst.length) continue;
      let after = h.line;
      for (const m of [...h.byRule.get(r)!].reverse()) after = renderOne(after, tokenize([after], h.py), m); // right to left, so earlier offsets stay valid
      if (after === h.line) continue;
      out.push({ file: h.f, line: h.n + 1, before: h.line, after: after.split("\n"), rule: `${r.inst.length} lines were rewritten this way; the rule matches ${matches} unchanged line(s)` });
      break;
    }
  }
  return out;
}

/** Writes the systematic completions (none: nothing touched). Returns what it wrote, with every touched file's exact text before and after. */
export function repairRewrites(repoDir: string, baseSha: string): Repair {
  const rewrites = systematicRewrites(repoDir, baseSha), byFile = new Map<string, Rewrite[]>(), files: Repair["files"] = [];
  for (const r of rewrites) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  for (const [f, list] of byFile) {
    let before: string; try { before = readFileSync(join(repoDir, f), "utf8"); } catch { continue; }
    const lines = before.split("\n");
    for (const r of [...list].sort((a, b) => b.line - a.line)) if (lines[r.line - 1] === r.before) lines.splice(r.line - 1, 1, ...r.after);
    const after = lines.join("\n");
    if (after !== before) { writeFileSync(join(repoDir, f), after); files.push({ file: f, before, after }); }
  }
  return { rewrites: rewrites.filter((r) => files.some((x) => x.file === r.file)), files };
}
/** Puts every file the repair touched back to its exact earlier bytes. A file edited since (it no longer reads as the repair left it) is left alone. */
export function restoreRewrites(repoDir: string, rep: Repair): string[] {
  const restored: string[] = [];
  for (const x of rep.files) {
    try { if (readFileSync(join(repoDir, x.file), "utf8") !== x.after) continue; writeFileSync(join(repoDir, x.file), x.before); restored.push(x.file); } catch { /* unreadable: nothing to restore */ }
  }
  return restored;
}
