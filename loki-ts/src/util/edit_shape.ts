// E2: the edit-shape scan. A pure module over (a -U0 diff, a reader for the edited tree) that lists the places a fix
// probably did not finish. Deterministic, no model, no git, no history (a benchmark checkout has none). Three rules, each
// justified by how defects repeat, not by any test outcome:
//   sibling:    the same call in the same function, in a different branch, passes the same other arguments but a different
//               variable (or, on an accumulation call, only when the edited argument is a local derived from the sibling's). Branches of one function normally feed their callee from one source; an edit that moved one branch
//               to another source (raw input against normalized input) left the others on the old one, or the reverse.
//   residual:   an unchanged line holds the exact pattern (a type assertion, an `as` cast, an instanceof/isinstance check or
//               a call with the same arguments) that the diff just removed from a rewritten line. A defect in a pattern is
//               usually written wherever the pattern is.
//   precedence: a strict type check was widened in place to a broader one (errors.As, isinstance, instanceof). The broad
//               check matches everything the strict one did and more, so branch order decides which behavior values that
//               already matched keep; the strict branches must stay first.
// Output is a short list for a resume prompt that asks the model to decide per site; a false site costs one look, so the
// rules prefer silence: common idioms, literal-only differences and straight-line sequences never fire.
import { langOf, symbolSpans, type Lang, type Span } from "./context_pack.ts";
import { parseDiffHunks, type DiffHunk } from "./secure_scan.ts";
import { isTestFile } from "./test_file_text.ts";
import { escapeRegex } from "./regex_escape.ts";

export interface EditSite { rule: "sibling" | "residual" | "precedence"; path: string; line: number; text: string; why: string; /** precedence only: the other checks in the same function that held their own branch before the change */ others?: { line: number; kind: string }[] }
export interface EditShapeOpts {
  /** Other files of the edited file's package (repo-relative), scanned for residual sites. Default: the edited file only. */
  packageFiles?: (path: string) => string[];
  /** Most sites returned (default 6). */
  max?: number;
}

export const EDIT_SHAPE_PROMPT = "Edit-shape check (a heuristic; some sites may be false): decide for each listed site whether it has the same defect as the code you changed; leave it alone if not.";
const COMMON_LIMIT = 6; // a pattern on more unchanged lines than this is an idiom of the file, not a repeated defect
const PER_RULE_CAP = 3;
const NEAR = 30; // lines: branch siblings farther away than this are other code in a long function, not the edited site's branches
const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "func", "def", "function", "catch", "with", "elif", "else", "select", "case", "go", "defer", "await", "typeof", "sizeof", "new", "throw", "raise", "assert", "print", "len", "cap", "make", "range", "not", "and", "or", "in", "is", "lambda", "super", "this", "self", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "isinstance", "type", "String", "Number", "Boolean", "Array", "Object", "Error", "panic", "recover"]);
const NOISY_CALLEE = /^(?:fmt|log|logger|logging|console|t|b|assert|expect|require|os\.Stderr)\./;
const GO_BUILTIN_T = new Set(["string", "int", "int64", "int32", "uint", "bool", "error", "float64", "float32", "byte", "rune", "any", "interface{}", "map[string]interface{}", "[]interface{}", "[]string"]);
const TS_PLAIN_T = new Set(["const", "string", "number", "boolean", "unknown", "never"]);
const LITERAL_ARG = /^(?:["'`\d]|-?\d|true$|false$|nil$|null$|None$|undefined$|True$|False$)/;
const ACCUM = /^(?:append|[\w.]+\.(?:push|append|add))$/; // accumulation sites take different data by nature: only derivation evidence makes them siblings
// Utility callees take whatever data the line has: a different argument there is no divergence unless derivation says so.
const GENERIC = /(?:^|\.)(?:join|resolve|test|exec|match|get|set|has|at|dirname|basename|relative|slice|map|filter|includes|startsWith|endsWith|replace|split|trim|stat|exists|existsSync|readFileSync|lstatSync|open|read|write|isArray|String|Number|Math\.\w+|Path|len|min|max|str|int|abs|get_|Sprintf|Join|Contains|HasPrefix)$/;
const SELF_ARG = /^(?:self|this|ctx|t)$/;
const compactWs = (s: string): string => s.trim().replace(/\s+/g, " ");
const indentOf = (s: string): number => s.length - s.trimStart().length;
const isComment = (s: string): boolean => /^\s*(?:\/\/|#|\/\*|\*)/.test(s);
const isDecl = (s: string): boolean => /^\s*(?:export\s+)?(?:async\s+)?(?:def|func|function|class|fn|interface|type)\b/.test(s);

/** Same-length mask of string literal bodies, so parens and commas inside strings never read as code. */
function maskStrings(s: string): string {
  return s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, (m) => m[0] + "_".repeat(m.length - 2) + m[m.length - 1]);
}

interface Call { callee: string; args: string[] }
/** Every call on one line (nested calls included), with its top-level arguments as written. Declarations yield nothing. */
function callsIn(line: string): Call[] {
  if (isComment(line) || isDecl(line)) return [];
  const masked = maskStrings(line);
  const out: Call[] = [];
  for (const m of masked.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(/g)) {
    const callee = m[1]!;
    if (KEYWORDS.has(callee) || NOISY_CALLEE.test(callee)) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0, end = -1;
    for (let i = open; i < masked.length; i++) {
      const c = masked[i]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c) && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    const args: string[] = [];
    let d = 0, from = open + 1;
    for (let i = open + 1; i <= end; i++) {
      const c = masked[i]!;
      if ("([{".includes(c)) d++;
      else if (")]}".includes(c) && i < end) d--;
      if ((c === "," && d === 0) || i === end) { const a = compactWs(line.slice(from, i)); if (a !== "" || i !== end) args.push(a); from = i + 1; }
    }
    out.push({ callee, args });
  }
  return out;
}

const variableLike = (a: string): boolean => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\]|\([^()]*\))*$/.test(a) && !LITERAL_ARG.test(a) && !SELF_ARG.test(a);

function enclosing(spans: Span[], line: number): Span | null {
  let best: Span | null = null;
  for (const s of spans) if (!s.container && s.start <= line && line <= s.end && (!best || s.start >= best.start)) best = s;
  return best;
}

/** The edited argument is a local whose definition above it (in the function) reads the sibling argument: normalized versus raw input. */
function derivedFrom(lines: string[], fn: Span, at: number, edited: string, sibling: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(edited)) return false;
  const def = new RegExp(`^\\s*(?:(?:const|let|var)\\s+)?${escapeRegex(edited)}\\s*(?::=|=)\\s*(.+?)\\s*;?\\s*$`), uses = new RegExp(`(?<![\\w$])${escapeRegex(sibling)}(?![\\w$])`);
  for (let k = at - 1; k >= Math.max(fn.start, at - 60); k--) { const m = def.exec(lines[k - 1] ?? ""); if (m) return uses.test(m[1]!); }
  return false;
}

/** Rule 1. */
function siblingSites(path: string, lines: string[], spans: Span[], added: Set<number>, hunks: DiffHunk[], covered: Set<number>): EditSite[] {
  const out: EditSite[] = [];
  for (const h of hunks) for (const a of h.added) {
    const fn = enclosing(spans, a.line);
    if (!fn) continue;
    for (const c of callsIn(a.text)) {
      if (c.args.length === 0) continue;
      let identical = false;
      const sibs: { line: number; pos: number; arg: string; derived: boolean }[] = [];
      for (let n = fn.start; n <= fn.end; n++) {
        if (n === a.line || added.has(n)) continue;
        for (const s of callsIn(lines[n - 1] ?? "")) {
          if (s.callee !== c.callee || s.args.length !== c.args.length) continue;
          const diff = c.args.map((x, i) => (x === s.args[i] ? -1 : i)).filter((i) => i >= 0);
          if (diff.length === 0) { identical = true; continue; }
          if (diff.length !== 1 || !variableLike(c.args[diff[0]!]!) || !variableLike(s.args[diff[0]!]!)) continue;
          // Different branches, not a straight-line sequence: a line less indented than both calls lies between them.
          const lo = Math.min(n, a.line), hi = Math.max(n, a.line), need = Math.min(indentOf(lines[n - 1] ?? ""), indentOf(a.text));
          let split = false;
          for (let k = lo + 1; k < hi && !split; k++) { const t = lines[k - 1] ?? ""; if (t.trim() !== "" && indentOf(t) < need) split = true; }
          const derived = derivedFrom(lines, fn, a.line, c.args[diff[0]!]!, s.args[diff[0]!]!);
          if (derived || (split && !ACCUM.test(c.callee) && !GENERIC.test(c.callee) && Math.abs(n - a.line) <= NEAR)) sibs.push({ line: n, pos: diff[0]!, arg: s.args[diff[0]!]!, derived });
        }
      }
      if (identical || sibs.length === 0 || (!sibs.some((x) => x.derived) && new Set(sibs.map((x) => x.line)).size < 2)) continue; // without derivation evidence one sibling is a coincidence, two agreeing ones are a pattern
      if (new Set(sibs.map((s) => `${s.pos}\u0000${s.arg}`)).size !== 1) continue; // the siblings disagree among themselves: no consensus to diverge from
      const s0 = sibs[0]!;
      for (const s of sibs) covered.add(s.line); // the sibling site already names these lines; the residual scan must not list them again
      out.push({ rule: "sibling", path, line: a.line, text: compactWs(a.text), why: `passes \`${c.args[s0.pos]}\` to ${c.callee} where the same call at ${[...new Set(sibs.map((s) => s.line))].join(", ")} in this function passes \`${s0.arg}\`` });
    }
  }
  return out;
}

interface Frag { key: string; re: RegExp; label: string }
/** The patterns a hunk removed (and did not write back), as regexes over a line. */
function fragmentsOf(h: DiffHunk, lang: Lang | null): Frag[] {
  const addedText = h.added.map((a) => a.text).join("\n");
  const out = new Map<string, Frag>();
  const put = (key: string, src: string, label: string): void => {
    if (out.has(key)) return;
    const re = new RegExp(src);
    if (!re.test(addedText)) out.set(key, { key, re, label });
  };
  for (const raw of h.removed) {
    if (isComment(raw)) continue;
    const line = maskStrings(raw);
    if (lang === "go") for (const m of line.matchAll(/\.\(\s*(\*?[A-Za-z_][\w.]*)\s*\)/g)) { const t = m[1]!; if (t !== "type" && !GO_BUILTIN_T.has(t.replace(/^\*/, ""))) put(`as:${t}`, `\\.\\(\\s*${escapeRegex(t)}\\s*\\)`, `.(${t})`); }
    if (lang === "ts") {
      for (const m of line.matchAll(/\bas\s+([A-Za-z_$][\w$.]*(?:<[^>]*>)?)/g)) { const t = m[1]!; if (!TS_PLAIN_T.has(t)) put(`cast:${t}`, `\\bas\\s+${escapeRegex(t)}(?![\\w$])`, `as ${t}`); }
      for (const m of line.matchAll(/\binstanceof\s+([A-Za-z_$][\w$.]*)/g)) put(`inst:${m[1]}`, `\\binstanceof\\s+${escapeRegex(m[1]!)}(?![\\w$])`, `instanceof ${m[1]}`);
    }
    if (lang === "py") for (const m of line.matchAll(/\bisinstance\(\s*[^,()]+,\s*([A-Za-z_][\w.]*)\s*\)/g)) put(`isi:${m[1]}`, `\\bisinstance\\(\\s*[^,()]+,\\s*${escapeRegex(m[1]!)}\\s*\\)`, `isinstance(_, ${m[1]})`);
    for (const c of callsIn(raw)) {
      if (c.args.length === 0 || !c.args.some(variableLike)) continue; // all-literal calls are constants, not shared data flow
      const body = c.args.map((a) => escapeRegex(a).replace(/\s+/g, "\\s*")).join("\\s*,\\s*");
      put(`call:${c.callee}(${c.args.join(",")})`, `(?<![\\w$.])${escapeRegex(c.callee)}\\(\\s*${body}\\s*\\)`, `${c.callee}(${c.args.join(", ")})`);
    }
  }
  return [...out.values()];
}

/** Rule 2. */
function residualSites(path: string, hunks: DiffHunk[], added: Set<number>, covered: Set<number>, scan: { path: string; lines: string[] }[], lang: Lang | null): EditSite[] {
  const out: EditSite[] = [];
  for (const h of hunks) {
    if (h.added.length === 0 || h.removed.length === 0) continue; // a rewrite has both halves; a pure add or delete names no replaced pattern
    for (const f of fragmentsOf(h, lang)) {
      const hits: { path: string; line: number; text: string }[] = [];
      for (const file of scan) {
        const skipTests = isTestFile(file.path) && !isTestFile(path);
        if (skipTests) continue;
        file.lines.forEach((t, i) => { if (file.path === path && (added.has(i + 1) || covered.has(i + 1))) return; if (!isComment(t) && f.re.test(t)) hits.push({ path: file.path, line: i + 1, text: compactWs(t) }); });
      }
      if (hits.length === 0 || hits.length > COMMON_LIMIT) continue;
      for (const hit of hits.slice(0, PER_RULE_CAP)) out.push({ rule: "residual", ...hit, why: `still contains \`${f.label}\`, which this change replaced elsewhere` });
    }
  }
  return out;
}

const STRICT: Record<string, RegExp[]> = {
  go: [/\.\(\s*\*?[A-Za-z_][\w.]*\s*\)/],
  py: [/\btype\(\s*[^()]+\)\s*(?:is|==)\s*[A-Za-z_]/, /\.__class__\s*(?:is|==)\s*[A-Za-z_]/],
  ts: [/\.constructor\s*===?\s*[A-Za-z_$]/],
};
const BROAD: Record<string, RegExp> = { go: /\berrors\.(?:As|Is)\(/, py: /\bisinstance\(/, ts: /\binstanceof\b/ };
const BROAD_NAME: Record<string, string> = { go: "errors.As", py: "isinstance", ts: "instanceof" };

// F3: a type check moved to an ANCESTOR of its type (isinstance(x, A) to isinstance(x, B) or instanceof A to instanceof B, where the scanned code declares `class A(B)` or
// `class A extends B`, directly or through up to 3 levels) and an exact comparison widened to a membership test (== or === to includes / in). A move to an unrelated or unknown type is no widening.
const TYPE_ARG: Record<string, RegExp> = { py: /\bisinstance\(\s*[^,()]+,\s*\(?\s*([A-Za-z_][\w.]*)/, ts: /\binstanceof\s+([A-Za-z_$][\w$.]*)/ };
const EXACT_EQ = /([A-Za-z_$][\w$.]*)\s*===?\s*(?:["'`][^"'`]*["'`]|-?\d)/, MEMBER: Record<string, RegExp> = { py: /\bin\s+[[({A-Za-z_]/, ts: /\.includes\(/, go: /\b(?:strings|slices)\.Contains\(/ };
/** The other type or value checks inside the same function span as `line` (unchanged lines only): each held its own branch before the change. */
function otherChecks(lines: string[], spans: Span[], line: number, added: Set<number>, lang: Lang): { line: number; kind: string }[] {
  const span = spans.filter((sp) => !sp.container && sp.start <= line && line <= sp.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  if (!span) return [];
  const pats: RegExp[] = lang === "go" ? [/\.\(\s*(\*?[A-Za-z_][\w.]*)\s*\)/g, /^\s*case\s+(\*?[A-Z][\w.]*(?:\s*,\s*\*?[A-Z][\w.]*)*)\s*:/g] : lang === "py" ? [/\bisinstance\(\s*[^,()]+,\s*\(?\s*([A-Za-z_][\w.]*)/g] : [/\binstanceof\s+([A-Za-z_$][\w$.]*)/g];
  const out: { line: number; kind: string }[] = [], seen = new Set<string>();
  for (let i = span.start; i <= span.end; i++) {
    if (i === line || added.has(i)) continue;
    const t = lines[i - 1] ?? ""; if (isComment(t)) continue;
    for (const re of pats) for (const m of maskStrings(t).matchAll(re)) for (const k of m[1]!.split(/\s*,\s*/)) { const kind = k.trim(); if (kind && kind !== "type" && !seen.has(kind)) { seen.add(kind); out.push({ line: i, kind }); } }
  }
  return out.slice(0, 6);
}
/** Rule 3. */
/** The ancestors of a class the scanned files declare (Python `class A(B, C)`, TS/JS `class A extends B`), up to 3 levels. */
function ancestorsOf(name: string, texts: string[], lang: Lang): Set<string> {
  const out = new Set<string>(); let frontier = [name];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: string[] = [];
    for (const n of frontier) for (const t of texts) {
      const re = lang === "py" ? new RegExp(`^\\s*class\\s+${escapeRegex(n)}\\s*\\(([^)]*)\\)`, "gm") : new RegExp(`\\bclass\\s+${escapeRegex(n)}\\b[^{]*?\\bextends\\s+([A-Za-z_$][\\w$.]*)`, "g");
      for (const m of t.matchAll(re)) for (const b of m[1]!.split(",").map((x) => x.trim().split(".").pop()!.replace(/\[.*$/, "")).filter(Boolean)) if (!out.has(b)) { out.add(b); next.push(b); }
    }
    frontier = next;
  }
  return out;
}
function precedenceSites(path: string, hunks: DiffHunk[], lang: Lang | null, lines: string[] = [], spans: Span[] = [], added: Set<number> = new Set(), texts: string[] = []): EditSite[] {
  if (lang !== "go" && lang !== "py" && lang !== "ts") return [];
  const out: EditSite[] = [];
  const push = (line: number, text: string, why: string): void => { const others = lines.length ? otherChecks(lines, spans, line, added, lang) : []; out.push({ rule: "precedence", path, line, text: compactWs(text), why, ...(others.length ? { others } : {}) }); };
  for (const h of hunks) {
    const strictLine = h.removed.find((r) => !isComment(r) && STRICT[lang]!.some((re) => re.test(maskStrings(r))) && !BROAD[lang]!.test(r));
    const broad = h.added.find((a) => !isComment(a.text) && BROAD[lang]!.test(a.text));
    if (strictLine && broad && !h.removed.some((r) => BROAD[lang]!.test(r))) { push(broad.line, broad.text, `a strict type check (\`${compactWs(strictLine).slice(0, 60)}\`) became ${BROAD_NAME[lang]!}, which also matches subtypes or wrapped values; keep strict exact-type checks first and put errors.As or isinstance fallbacks after them`); continue; }
    const ta = TYPE_ARG[lang];
    if (ta) {
      const r = h.removed.map((x) => ta.exec(maskStrings(x))?.[1]).find(Boolean), a = h.added.find((x) => !isComment(x.text) && ta.test(maskStrings(x.text)));
      const at = a ? ta.exec(maskStrings(a.text))?.[1] : undefined;
      if (r && a && at && at !== r && ancestorsOf(r.split(".").pop()!, texts, lang).has(at.split(".").pop()!)) { push(a.line, a.text, `the type check moved from ${r} to its ancestor ${at}, which also matches values that took another branch`); continue; }
    }
    const eq = h.removed.map((x) => EXACT_EQ.exec(maskStrings(x))?.[1]).find(Boolean), mem = h.added.find((x) => !isComment(x.text) && MEMBER[lang]!.test(maskStrings(x.text)) && !!eq && x.text.includes(eq.split(".").pop()!));
    if (eq && mem && !h.removed.some((x) => MEMBER[lang]!.test(maskStrings(x)))) push(mem.line, mem.text, `an exact comparison on ${eq} became a membership test, which also matches values that took another branch`);
  }
  return out;
}

/** The sites a diff leaves worth a second look. `diff` is `git diff -U0` (base to edited tree); `readFile` reads the edited tree. */
export function editShapeSites(diff: string, readFile: (path: string) => string | null, opts: EditShapeOpts = {}): EditSite[] {
  const all: EditSite[] = [];
  for (const [path, hunks] of parseDiffHunks(diff)) {
    const lang = langOf(path);
    const src = readFile(path);
    if (src === null || hunks.length === 0) continue;
    const lines = src.split("\n");
    const added = new Set(hunks.flatMap((h) => h.added.map((a) => a.line)));
    const scan = [{ path, lines }];
    for (const p of opts.packageFiles?.(path) ?? []) { if (p === path || langOf(p) !== lang) continue; const t = readFile(p); if (t !== null) scan.push({ path: p, lines: t.split("\n") }); }
    all.push(...precedenceSites(path, hunks, lang, lines, symbolSpans(path, src), added, scan.map((f) => f.lines.join("\n"))));
    const covered = new Set<number>();
    if (lang) all.push(...siblingSites(path, lines, symbolSpans(path, src), added, hunks, covered));
    all.push(...residualSites(path, hunks, added, covered, scan, lang));
  }
  const seen = new Set<string>(), out: EditSite[] = [];
  for (const s of all) { const k = `${s.path}:${s.line}`; if (!seen.has(k)) { seen.add(k); out.push(s); } }
  return out.slice(0, opts.max ?? 6);
}

/** The resume-prompt block for a site list, or null when there is nothing to ask. */
export function editShapeBrief(sites: EditSite[]): string | null {
  if (sites.length === 0) return null;
  return `${EDIT_SHAPE_PROMPT}\n${sites.map((s) => `- ${s.path}:${s.line} (${s.rule}) ${s.why}: ${s.text.slice(0, 120)}`).join("\n")}`;
}

/** F3 LOKI_E10_PRECEDENCE_CHECK (default on, =0 opts out): after a clean implement, a precedence site whose function still holds other type or value checks gets one follow-up resume
 *  ("-pr") naming each of those inputs and requiring it still takes its own branch. The failure it targets: an exact type assertion widened to an unwrapping check and placed ahead
 *  of an existing assertion branch, so values that matched both now take the broad branch; correct fixes keep the exact checks first. Deterministic from the diff; $0 when nothing fires. */
export const precedenceCheckEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PRECEDENCE_CHECK"] ?? "").trim());
/** The follow-up brief for precedence sites that carry other checks; null when none does. */
export function precedenceBrief(sites: EditSite[]): string | null {
  const live = sites.filter((s) => s.rule === "precedence" && s.others?.length);
  if (!live.length) return null;
  return ["Your change widened a type or value check. Before it, each input listed under a site took its own branch; make every one of them still take that branch (keep the exact checks first, or exclude them from the broad one), and add a test case for each that would fail if it took the broad branch instead.",
    ...live.map((s) => `- ${s.path}:${s.line}: ${s.why}. Inputs that had their own branch: ${s.others!.map((o) => `${o.kind} (line ${o.line})`).join(", ")}`)].join("\n");
}
