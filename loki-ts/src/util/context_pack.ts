// L020/L021/L022: per-language symbol spans (TS/JS, Python, Java, Kotlin, C#, Go, Rust), the small-model context pack
// (the bodies of the code that matters, inline in the implement brief under a fixed token budget) and the receipt's
// context coverage record. Deterministic, no LLM. One file owns "which code the brief shows": repomap.ts takes its
// symbols for the newer languages here, ts_signatures.ts its signatures, e10ext/context.ts the pack, seal.ts the record.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { identTokens, taskKeywords } from "./relevance.ts";
import { safeGit } from "./safe_git.ts";
import { isTestFile } from "./test_file_text.ts";

export type Lang = "ts" | "py" | "java" | "kt" | "cs" | "go" | "rs";
export interface Span { name: string; start: number; end: number; container: boolean } // 1-based, inclusive lines
export interface PackSpan { path: string; start: number; end: number; symbol: string | null; via: "named" | "match" | "callee" | "caller" }
export interface ContextPack { text: string; files: string[]; spans: PackSpan[]; tokens: number; budget_tokens: number }

/** Languages the repo map handled before L020 keep their own extractor in repomap.ts (byte-identical ranking). */
export const NEW_LANG_EXT = /\.(java|kt|kts|cs|go|rs)$/;
export function langOf(path: string): Lang | null {
  if (/\.[cm]?[jt]sx?$/.test(path)) return "ts";
  if (/\.py$/.test(path)) return "py";
  if (/\.java$/.test(path)) return "java";
  if (/\.kts?$/.test(path)) return "kt";
  if (/\.cs$/.test(path)) return "cs";
  if (/\.go$/.test(path)) return "go";
  if (/\.rs$/.test(path)) return "rs";
  return null;
}

/** A conservative token estimate (3 bytes per token; real code tokenizes nearer 3.5 to 4), so a budget held here holds for the model. */
export const estTokens = (s: string): number => Math.ceil(Buffer.byteLength(s) / 3);

// ---- masking: string, char and comment contents become spaces (newlines kept), so braces and regexes see only code ----
function mask(src: string, lang: Lang): string {
  const parts: string[] = [];
  let kept = 0;
  const blank = (a: number, b: number): void => { b = Math.min(b, src.length); if (b <= a) return; parts.push(src.slice(kept, a), src.slice(a, b).replace(/[^\n]/g, " ")); kept = b; };
  const n = src.length, next = lang === "py" ? /[#"']/g : /[\/"'`]/g;
  for (let i = 0; i < n; ) {
    next.lastIndex = i;
    const hit = next.exec(src);
    if (!hit) break;
    i = hit.index;
    const c = src[i]!, d = src[i + 1];
    if (lang === "py") {
      if (c === "#") { let j = i; while (j < n && src[j] !== "\n") j++; blank(i, j); i = j; continue; }
      if (c === '"' || c === "'") {
        const triple = src.startsWith(c.repeat(3), i), q = triple ? c.repeat(3) : c;
        let j = i + q.length;
        while (j < n && !src.startsWith(q, j)) { if (src[j] === "\\") j++; else if (!triple && src[j] === "\n") break; j++; }
        blank(i + q.length, j); i = Math.min(n, j + q.length); continue;
      }
      i++; continue;
    }
    if (c === "/" && d === "/") { let j = i; while (j < n && src[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); const e = j < 0 ? n : j + 2; blank(i, e); i = e; continue; }
    if (c === '"' || c === "`" || (c === "'" && lang !== "rs")) {
      let j = i + 1;
      const raw = c === "`" || (c === '"' && src[i - 1] === "@" && lang === "cs");
      while (j < n && src[j] !== c) { if (src[j] === "\\" && !raw) j++; else if (src[j] === "\n" && !raw && lang !== "kt") break; j++; }
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === "'" && lang === "rs") { const m = /^'(?:\\.[^']*|[^\\'])'/.exec(src.slice(i, i + 12)); if (m) { blank(i + 1, i + m[0].length - 1); i += m[0].length; continue; } }
    i++;
  }
  parts.push(src.slice(kept));
  return parts.join("");
}

// ---- span extraction ----
const KW = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "await", "typeof", "super", "this", "else", "do", "try", "throw", "using", "lock", "foreach", "when", "match", "loop", "fixed", "checked", "unchecked", "yield", "sizeof", "nameof", "default", "case"]);
type Hit = { name: string; container: boolean; nested?: boolean } | null;
const TS_FN = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const TS_CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TS_TYPE = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|enum|type|namespace)\s+([A-Za-z_$][\w$]*)/;
const TS_CONST = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const TS_METHOD = /^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?#?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const JVM_TYPE = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open|inner|enum|annotation|value|readonly|ref|unsafe|new|file)\s+)*(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/;
const JVM_METHOD = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|native|sealed|partial|readonly|extern|unsafe|new|default|strictfp)\s+)*(?:<[^>]+>\s+)?([\w<>[\],.?]+(?:\s*<[^>]*>)?)\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/;
const JVM_CTOR = /^\s*(?:(?:public|private|protected|internal|static)\s+)+([A-Za-z_]\w*)\s*\(/;
const KT_FUN = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|override|open|abstract|suspend|inline|operator|infix|tailrec|external|final)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/;
const GO_FUNC = /^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\b/;
const GO_VAR = /^(?:var|const)\s+([A-Za-z_]\w*)/;
const RS_FN = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+([A-Za-z_]\w*)/;
const RS_TYPE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|mod)\s+([A-Za-z_]\w*)/;
const RS_IMPL = /^\s*(?:unsafe\s+)?impl(?:\s*<[^>]*>)?\s+(?:[\w:<>, ]+?\s+for\s+)?([A-Za-z_]\w*)/;
const RS_CONST = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/;

function braceHit(lang: Lang, line: string, inClass: string | null, inFn: boolean): Hit {
  let m: RegExpExecArray | null;
  if (lang === "ts") {
    if (inFn) return null;
    if ((m = TS_CLASS.exec(line))) return { name: m[1]!, container: true };
    if ((m = TS_FN.exec(line))) return { name: m[1]!, container: false };
    if ((m = TS_TYPE.exec(line))) return { name: m[1]!, container: false };
    if (!inClass && (m = TS_CONST.exec(line))) return { name: m[1]!, container: false };
    if (inClass && (m = TS_METHOD.exec(line)) && !KW.has(m[1]!)) return { name: m[1]!, container: false };
    return null;
  }
  if (lang === "go") {
    if ((m = GO_FUNC.exec(line))) return { name: m[1] ? `${m[1]}.${m[2]}` : m[2]!, container: false };
    if ((m = GO_TYPE.exec(line)) || (m = GO_VAR.exec(line))) return { name: m[1]!, container: false };
    return null;
  }
  if (inFn) return null;
  if (lang === "rs") {
    if ((m = RS_IMPL.exec(line)) || (m = RS_TYPE.exec(line))) return { name: m[1]!, container: /\b(impl|trait|mod)\b/.test(line) };
    if ((m = RS_FN.exec(line))) return { name: m[1]!, container: false };
    if ((m = RS_CONST.exec(line))) return { name: m[1]!, container: false };
    return null;
  }
  if ((m = JVM_TYPE.exec(line))) return { name: m[1]!, container: true };
  if (lang === "kt") { if ((m = KT_FUN.exec(line))) return { name: m[1]!, container: false }; return null; }
  if (!inClass) return null;
  if ((m = JVM_METHOD.exec(line)) && !KW.has(m[2]!) && !/^(return|new|throw|else|await|yield|case|goto|var|val)$/.test(m[1]!)) return { name: m[2]!, container: false };
  if ((m = JVM_CTOR.exec(line)) && m[1] === inClass) return { name: m[1]!, container: false };
  return null;
}

/** The last line of a brace-language definition starting at offset `at` of masked text `t`. */
function braceEnd(t: string, at: number, lineOf: (o: number) => number): number {
  let paren = 0;
  for (let i = at, nl = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === "(" || c === "[") paren++;
    else if (c === ")" || c === "]") paren--;
    else if (c === "{" && paren <= 0) {
      let depth = 0;
      for (let j = i; j < t.length; j++) { if (t[j] === "{") depth++; else if (t[j] === "}" && --depth === 0) return lineOf(j); }
      return lineOf(t.length - 1);
    } else if (c === ";" && paren <= 0) return lineOf(i);
    else if (c === "\n" && paren <= 0) {
      const head = t.slice(at, i).trimEnd();
      let j = i + 1;
      while (j < t.length && /\s/.test(t[j]!)) j++;
      const next = t[j];
      if (++nl > 30) return lineOf(i - 1);
      if (!/(,|\(|=|=>|->|:|\||&|<|\bextends|\bimplements|\bwhere|\bthrows)$/.test(head) && next !== "{" && next !== "." && next !== ":" && next !== "=") return lineOf(i - 1);
    }
  }
  return lineOf(t.length - 1);
}

function braceSpans(src: string, lang: Lang): Span[] {
  const t = mask(src, lang), lines = t.split("\n"), starts: number[] = [];
  for (let o = 0, k = 0; k < lines.length; k++) { starts.push(o); o += lines[k]!.length + 1; }
  const lineOf = (o: number): number => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= o) lo = mid; else hi = mid - 1; } return lo + 1; };
  const out: Span[] = [], stack: Span[] = [];
  for (let k = 0; k < lines.length; k++) {
    const ln = k + 1;
    while (stack.length && stack[stack.length - 1]!.end < ln) stack.pop();
    const top = stack[stack.length - 1];
    const cls = top?.container ? top.name.split(".").pop()! : null;
    const hit = braceHit(lang, lines[k]!, cls, !!top && !top.container);
    if (!hit) continue;
    const end = Math.max(ln, braceEnd(t, starts[k]!, lineOf));
    const span: Span = { name: top?.container && lang !== "go" ? `${top.name}.${hit.name}` : hit.name, start: ln, end, container: hit.container };
    out.push(span); stack.push(span);
  }
  return out;
}

function pySpans(src: string): Span[] {
  const lines = mask(src, "py").split("\n"), out: Span[] = [], stack: { indent: number; span: Span }[] = [];
  const indentOf = (s: string): number => s.length - s.trimStart().length;
  for (let k = 0; k < lines.length; k++) {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(lines[k]!);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    let end = k, depth = 0;
    for (let j = k; j < lines.length; j++) { for (const c of lines[j]!) { if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--; } end = j; if (depth <= 0 && /:\s*$/.test(lines[j]!)) break; }
    for (let j = end + 1; j < lines.length; j++) { const s = lines[j]!; if (s.trim() === "") continue; if (indentOf(s) <= indent) break; end = j; }
    let start = k; while (start > 0 && /^\s*@/.test(lines[start - 1]!) && indentOf(lines[start - 1]!) === indent) start--;
    const top = stack[stack.length - 1];
    if (top && !top.span.container) continue; // nested helper inside a function: the function's span holds it
    const span: Span = { name: top ? `${top.span.name}.${m[3]}` : m[3]!, start: start + 1, end: end + 1, container: m[2] === "class" };
    out.push(span); stack.push({ indent, span });
  }
  return out;
}

/** Definitions with their line ranges, innermost names qualified by their class (Class.method; Go receivers Type.Method). */
export function symbolSpans(path: string, src: string): Span[] {
  const lang = langOf(path);
  if (!lang) return [];
  try { return lang === "py" ? pySpans(src) : braceSpans(src, lang); } catch { return []; }
}

const MAX_SCAN_BYTES = 256_000;
function readHead(absPath: string): string | null {
  let fd = -1;
  try { const buf = Buffer.allocUnsafe(MAX_SCAN_BYTES); fd = openSync(absPath, "r"); return buf.toString("utf8", 0, readSync(fd, buf, 0, MAX_SCAN_BYTES, 0)); } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ } }
}

/** L020: repo map symbols for Java, Kotlin, C#, Go and Rust files (classes, methods as Class.method, functions). */
export function langSymbols(absPath: string, max = 300): string[] {
  const src = readHead(absPath);
  return src === null ? [] : [...new Set(symbolSpans(absPath, src).map((s) => s.name))].slice(0, max);
}

/** L020: one signature line per definition (the head up to its body), methods indented under their type. */
export function langSignatures(path: string, src: string): string[] {
  const lines = src.split("\n");
  return symbolSpans(path, src).map((s) => `${s.name.includes(".") ? "    " : ""}${lines[s.start - 1]!.trim().replace(/\s*\{.*$/, "").slice(0, 200)}`);
}

// ---- L021: the context pack ----
export const PACK_BUDGET_TOKENS = 6000;
const SMALL_FILE_BYTES = 3200; // a relevant file this small is shown whole (imports and constants included)
const MAX_PACK_FILES = 8;
const MAX_CALLEE_LINES = 120; // a callee longer than this is named by signature, not inlined
const MAX_IDENTS_PER_HOP = 200;

/** The pack is for small executors: haiku or sonnet. LOKI_E10_CONTEXT_PACK=0 turns it off, =1 turns it on for any model. */
export function packEnabled(model: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["LOKI_E10_CONTEXT_PACK"];
  if (v === "0") return false;
  if (v === "1") return true;
  return /haiku|sonnet/i.test(model ?? "");
}

interface Unit { path: string; start: number; end: number; symbol: string | null; via: PackSpan["via"]; score: number; order: number }

function taskIdentifiers(task: string): Set<string> {
  const out = new Set<string>();
  for (const raw of task.match(/[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*/g) ?? []) {
    if (raw.length < 3) continue;
    out.add(raw.toLowerCase());
    for (const part of raw.split(".")) if (part.length >= 3) out.add(part.toLowerCase());
  }
  return out;
}

/**
 * The bodies of the code that matters, in file:line form, under budgetTokens. Order of preference: whole small files and
 * definitions the task names or whose names share the task's words (from the brief's ranked files), then the definitions
 * those bodies call (one and two hops, through the repo map's symbols), then the callers of the named definitions.
 */
export function contextPack(repoDir: string, task: string, files: string[], symbolIndex: { path: string; symbols: string[] }[] = [], budgetTokens = PACK_BUDGET_TOKENS): ContextPack | null {
  const ids = taskIdentifiers(task), words = new Set(taskKeywords(task));
  const texts = new Map<string, string[]>(), spansOf = new Map<string, Span[]>();
  const load = (p: string): boolean => {
    if (texts.has(p)) return true;
    if (!langOf(p) || /^([/~]|[A-Za-z]:[\\/])/.test(p) || p.split(/[\\/]/).includes("..")) return false;
    let src: string;
    try { src = readFileSync(join(repoDir, p), "utf8"); } catch { return false; }
    if (src.length > MAX_SCAN_BYTES || src.includes("\u0000")) return false;
    texts.set(p, src.split("\n")); spansOf.set(p, symbolSpans(p, src));
    return true;
  };
  const leaf = (n: string): string => n.split(".").pop()!;
  // Rare task words count more than common ones: inverse document frequency over the repo map's path and symbol tokens.
  const tokenSets = symbolIndex.map((e) => new Set([...identTokens(e.path), ...e.symbols.flatMap(identTokens)]));
  const df = new Map<string, number>();
  for (const s of tokenSets) for (const w of words) if (s.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string): number => Math.log((tokenSets.length + 1) / ((df.get(w) ?? 0) + 1)) + 0.1;
  const scoreName = (n: string): number => {
    const l = leaf(n).toLowerCase();
    let s = ids.has(n.toLowerCase()) || (l.length >= 3 && ids.has(l)) ? 10 : 0;
    for (const w of new Set(identTokens(leaf(n)))) if (words.has(w)) s += 1 + idf(w);
    return s;
  };
  const scoreBody = (lines: string[], s: Span): number => { // distinct rare task words the body uses, damped for long bodies
    const toks = new Set(identTokens(lines.slice(s.start - 1, s.end).join("\n")));
    let sc = 0;
    for (const w of words) if (toks.has(w)) sc += idf(w);
    return sc / Math.max(1, Math.log2((s.end - s.start + 1) / 8));
  };
  // Candidate files: the brief's own ranking first, then the files whose path and symbols carry the rarest task words.
  const byIdf = symbolIndex.map((e, i) => {
    const segs = e.path.split("/"), stem = new Set(identTokens(segs[segs.length - 1]!.replace(/\.[^.]+$/, ""))), syms = new Set(e.symbols.flatMap(identTokens)), dirs = new Set(segs.slice(0, -1).flatMap(identTokens));
    let sc = 0;
    for (const w of words) sc += stem.has(w) ? 3 * idf(w) : syms.has(w) ? 2 * idf(w) : dirs.has(w) ? idf(w) : 0;
    return { path: e.path, sc, i };
  }).filter((x) => x.sc > 0 && !isTestFile(x.path)).sort((a, b) => b.sc - a.sc || a.i - b.i).map((x) => x.path);
  const units: Unit[] = [];
  let order = 0;
  const ranked = [...new Set([...files.slice(0, 4), ...byIdf.slice(0, 6), ...files.slice(4)])].filter(load).slice(0, MAX_PACK_FILES);
  ranked.forEach((p, i) => {
    const lines = texts.get(p)!, spans = spansOf.get(p)!, bonus = (MAX_PACK_FILES - i) * 0.25;
    const named = [...ids].some((x) => x.includes("/") || x.includes(".") ? p.endsWith(x) : false);
    const best = Math.max(0, ...spans.map((s) => scoreName(s.name)));
    if (Buffer.byteLength(lines.join("\n")) <= SMALL_FILE_BYTES) { units.push({ path: p, start: 1, end: lines.length, symbol: null, via: best >= 10 || named ? "named" : "match", score: best + bonus + 1, order: order++ }); return; }
    for (const s of spans) {
      const nm = scoreName(s.name), sc = 2 * nm + scoreBody(lines, s);
      if (sc <= 0 || (s.container && spans.some((o) => o !== s && o.start >= s.start && o.end <= s.end && scoreName(o.name) > 0))) continue;
      if (s.container && s.end - s.start > MAX_CALLEE_LINES) continue; // a large class is reached through its methods
      units.push({ path: p, start: s.start, end: s.end, symbol: s.name, via: nm >= 10 ? "named" : "match", score: sc + bonus, order: order++ });
    }
  });
  if (!units.length) return null;
  units.sort((a, b) => b.score - a.score || a.order - b.order);
  const top = units[0]!.score;
  units.splice(0, units.length, ...units.filter((u) => u.symbol === null || u.score >= top * 0.3)); // weak matches spend no budget

  const chosen: Unit[] = [];
  const budgetBytes = budgetTokens * 3;
  const HEADER = "Code that matters (current contents at these file:line ranges; edit them directly and read other files only when needed):";
  let used = Buffer.byteLength(HEADER) + 1;
  const covered = (u: Unit): boolean => chosen.some((c) => c.path === u.path && c.start <= u.start && c.end >= u.end);
  const cost = (u: Unit): number => Buffer.byteLength(`--- ${u.path}:${u.start}-${u.end}\n${texts.get(u.path)!.slice(u.start - 1, u.end).join("\n")}\n`) + 1;
  const take = (u: Unit): boolean => {
    if (covered(u)) return false;
    const c = cost(u);
    if (used + c > budgetBytes) return false;
    for (let i = chosen.length - 1; i >= 0; i--) { const x = chosen[i]!; if (x.path === u.path && x.start >= u.start && x.end <= u.end) { used -= cost(x); chosen.splice(i, 1); } }
    chosen.push(u); used += c;
    return true;
  };
  for (const u of units) take(u);
  if (!chosen.length) return null; // nothing fits the budget: no pack, never an empty header

  // Callees, two hops: identifiers in chosen bodies resolved to definitions in the same file or in the repo map.
  const index = new Map<string, string[]>(); // symbol leaf -> repo map paths, in map order
  for (const e of symbolIndex) for (const s of e.symbols) { const l = leaf(s), v = index.get(l) ?? []; if (!v.includes(e.path)) { v.push(e.path); index.set(l, v); } }
  const defsFor = (name: string, from: string): { path: string; span: Span }[] => {
    const out: { path: string; span: Span }[] = [];
    const pick = (p: string): void => { for (const s of spansOf.get(p) ?? []) if (leaf(s.name) === name && !s.container && s.end - s.start < MAX_CALLEE_LINES) out.push({ path: p, span: s }); };
    pick(from); // a same-file definition wins
    if (!out.length) for (const p of (index.get(name) ?? []).slice(0, 2)) if (load(p)) pick(p);
    return out.slice(0, 2);
  };
  const seen = new Set<string>();
  for (let hop = 0; hop < 2; hop++) {
    const idents: { w: string; from: string }[] = [];
    for (const c of [...chosen]) for (const w of texts.get(c.path)!.slice(c.start - 1, c.end).join("\n").match(/[A-Za-z_]\w{2,}/g) ?? []) if (!seen.has(`${c.path}\0${w}`) && !KW.has(w)) { seen.add(`${c.path}\0${w}`); idents.push({ w, from: c.path }); }
    let added = 0;
    for (const { w, from } of idents.slice(0, MAX_IDENTS_PER_HOP)) for (const d of defsFor(w, from)) if (take({ path: d.path, start: d.span.start, end: d.span.end, symbol: d.span.name, via: "callee", score: 0, order: order++ })) added++;
    if (!added) break;
  }

  // Callers of the definitions the task names: the enclosing definition of each `git grep -w` hit, five files at most.
  for (const u of chosen.filter((c) => c.via === "named" && c.symbol)) {
    let out = "";
    try { out = safeGit(repoDir, ["grep", "-n", "-w", "-I", "--", leaf(u.symbol!)], { stdio: ["ignore", "pipe", "ignore"] }); } catch { continue; }
    const hits = out.split("\n").map((l) => /^(.*?):(\d+):/.exec(l)).filter((m): m is RegExpExecArray => !!m && m[1] !== u.path && !isTestFile(m[1]!));
    for (const m of hits.slice(0, 5)) {
      if (!load(m[1]!)) continue;
      const line = Number(m[2]);
      const encl = spansOf.get(m[1]!)!.filter((s) => !s.container && s.start <= line && s.end >= line).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (encl) take({ path: m[1]!, start: encl.start, end: encl.end, symbol: encl.name, via: "caller", score: 0, order: order++ });
    }
  }

  const fileOrder = [...new Set(chosen.map((c) => c.path))];
  const sorted = [...chosen].sort((a, b) => fileOrder.indexOf(a.path) - fileOrder.indexOf(b.path) || a.start - b.start);
  const text = [HEADER, ...sorted.map((u) => `--- ${u.path}:${u.start}-${u.end}\n${texts.get(u.path)!.slice(u.start - 1, u.end).join("\n")}`)].join("\n");
  return { text, files: fileOrder, spans: sorted.map(({ path, start, end, symbol, via }) => ({ path, start, end, symbol, via })), tokens: estTokens(text), budget_tokens: budgetTokens };
}

// ---- L022: did the brief cover the code that changed? ----
export interface ContextCoverage { brief_files: number; changed_files: number; covered_files: number; context_recall: number | null; context_precision: number | null; reads_before_first_edit: number | null; pack_tokens?: number }

/**
 * context_recall: changed pre-existing non-test files that the brief named, over changed pre-existing non-test files.
 * context_precision: the same numerator over the brief's file count. reads_before_first_edit: from the implement
 * session's result-cost record (runner/sdk_stream_parser.ts). nameStatus is `git diff --name-status -z` split on NUL.
 */
export function contextCoverage(implement: Record<string, unknown> | undefined, nameStatus: readonly string[], repoDir: string): ContextCoverage | null {
  const brief = implement?.["brief_files"];
  if (!Array.isArray(brief)) return null;
  const briefSet = new Set(brief.filter((x): x is string => typeof x === "string"));
  const changed: string[] = [];
  for (let i = 0; i + 1 < nameStatus.length; i += 2) if (/^[MDT]$/.test(nameStatus[i]!.trim().split(" ").pop() ?? "") && !isTestFile(nameStatus[i + 1]!) && !nameStatus[i + 1]!.startsWith(".loki/")) changed.push(nameStatus[i + 1]!);
  const hit = changed.filter((f) => briefSet.has(f)).length;
  let reads: number | null = null;
  const iter = Array.isArray(implement?.["iteration_ids"]) ? (implement!["iteration_ids"] as unknown[])[0] : undefined;
  if (typeof iter === "string" && /^[\w.-]+$/.test(iter)) {
    try { const r = JSON.parse(readFileSync(join(repoDir, ".loki", "metrics", `result-cost-${iter}.json`), "utf8")) as Record<string, unknown>; if (typeof r["reads_before_first_edit"] === "number") reads = r["reads_before_first_edit"]; } catch { /* no record: not measured */ }
  }
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  const pack = implement?.["context_pack"] as { tokens?: unknown } | undefined;
  return {
    brief_files: briefSet.size, changed_files: changed.length, covered_files: hit,
    context_recall: changed.length ? round(hit / changed.length) : null,
    context_precision: briefSet.size ? round(hit / briefSet.size) : null,
    reads_before_first_edit: reads,
    ...(typeof pack?.tokens === "number" ? { pack_tokens: pack.tokens } : {}),
  };
}
export const contextCoverageBlock = (implement: Record<string, unknown> | undefined, nameStatus: readonly string[], repoDir: string): { context?: ContextCoverage } => { const c = contextCoverage(implement, nameStatus, repoDir); return c ? { context: c } : {}; };

/** L022: median context_recall over the last `last` sealed runs (receipt.json, by modification time) that measured it. */
export function contextRecallMedian(runsDir: string, last = 20): { median: number | null; n: number; runs_considered: number } {
  let sealed: { mtime: number; recall: unknown }[] = [];
  try {
    for (const id of readdirSync(runsDir)) {
      const p = join(runsDir, id, "receipt.json");
      try { const r = JSON.parse(readFileSync(p, "utf8")) as { context?: { context_recall?: unknown } }; sealed.push({ mtime: statSync(p).mtimeMs, recall: r.context?.context_recall }); } catch { /* not sealed */ }
    }
  } catch { /* no runs yet */ }
  sealed = sealed.sort((a, b) => a.mtime - b.mtime).slice(-last);
  const xs = sealed.map((s) => s.recall).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  const mid = xs.length >> 1;
  const median = !xs.length ? null : xs.length % 2 ? xs[mid]! : Math.round(((xs[mid - 1]! + xs[mid]!) / 2) * 1000) / 1000;
  return { median, n: xs.length, runs_considered: sealed.length };
}
