// D77 (W1-S1): the sealed base-tree manifest the Wall reads instead of the repo. Pure: a file list in,
// signatures-only text out. It holds the detected runner and config, the test layout, at most two style
// examples that import no module the task names, and public signatures of the named modules. Function
// and method bodies never enter the output: only text before a body's opening brace (TS) or colon (Python).
export interface ManifestFile { path: string; content: string }

export const MANIFEST_MAX_LINES = 400;
const MAX_EXAMPLES = 2;
const EXAMPLE_LINES = 40;
const MAX_LAYOUT = 60;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const norm = (s: string): string => s.replace(/\r\n?/g, "\n");
const stemOf = (p: string): string => (p.split("/").pop() ?? p).replace(/\.[^.]*$/, "");
const byPath = (a: ManifestFile, b: ManifestFile): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.content < b.content ? -1 : a.content > b.content ? 1 : 0;

interface Item { head: string; raw: string; end: string; body: string | null; balanced: boolean }

const REGEX_PREV = "(,=:[!&|?{;+-*%~^";
const isComment = (s: string, i: number): boolean => s[i] === "/" && (s[i + 1] === "/" || s[i + 1] === "*");

// Template literal starting at i (a backtick); handles nested `${ ... }` holding strings and templates.
function templateEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; ) {
    const c = s[j];
    if (c === "\\") j += 2;
    else if (c === "`") return j + 1;
    else if (c === "$" && s[j + 1] === "{") {
      let depth = 1;
      j += 2;
      while (j < s.length && depth > 0) {
        const k = skipLiteral(s, j);
        if (k !== j) { j = k; continue; }
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
    } else j++;
  }
  return s.length;
}

// Regex literal starting at i when the previous significant character allows one; else i.
function regexEnd(s: string, i: number): number {
  let p = i - 1;
  while (p >= 0 && /\s/.test(s[p]!)) p--;
  if (p >= 1 && (s[p] === "+" || s[p] === "-") && s[p - 1] === s[p]) return i;
  if (p >= 0 && !REGEX_PREV.includes(s[p]!) && !/\b(return|typeof|case|in|of|void|delete|throw)$/.test(s.slice(Math.max(0, p - 7), p + 1))) return i;
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\n") return i;
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < s.length && /[a-z]/i.test(s[j]!)) j++;
      return j;
    }
  }
  return i;
}

// Skips one string, template, regex, or comment starting at i; returns the index after it, or i when none starts here.
// A quote that finds no closing quote before a line break (JSX text such as Don't) is not a string.
function skipLiteral(s: string, i: number): number {
  const c = s[i];
  if (c === "/" && s[i + 1] === "/") { const n = s.indexOf("\n", i); return n < 0 ? s.length : n; }
  if (c === "/" && s[i + 1] === "*") { const n = s.indexOf("*/", i + 2); return n < 0 ? s.length : n + 2; }
  if (c === "/") return regexEnd(s, i);
  if (c === "`") return templateEnd(s, i);
  if (c !== '"' && c !== "'") return i;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === c) return j + 1;
    else if (s[j] === "\n") return i;
  }
  return s.length;
}

function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; ) {
    const j = skipLiteral(s, i);
    if (j !== i) { i = j; continue; }
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
    i++;
  }
  return s.length;
}

// Splits one block into top-level statements. A statement ends at `;`, after a `{...}` body, or at a line
// break before the next `export`/`import`; a bare `export {` / `type X = {` keeps scanning to the `;`.
function items(src: string): Item[] {
  const out: Item[] = [];
  let start = 0, head = "", p = 0, i = 0;
  const push = (end: string, body: string | null, stop: number, balanced = true): void => {
    if (head.trim()) out.push({ head, raw: src.slice(start, stop).trim(), end, body, balanced });
    head = ""; p = 0; start = stop;
  };
  while (i < src.length) {
    const j = skipLiteral(src, i);
    if (j !== i) {
      if (!isComment(src, i)) head += src.slice(i, j);
      i = j;
      continue;
    }
    const c = src[i]!;
    if (c === "(" || c === "[") p++;
    else if (c === ")" || c === "]") p--;
    if (c === "{" && p === 0) {
      const close = matchingBrace(src, i);
      const h = head.trim();
      const declaration = /^(export\s+)?(declare\s+)?(type|interface|enum)\b/.test(h);
      if (declaration || h === "" || /^export(\s+type)?$/.test(h) || /[:|&]$/.test(h)) {
        head += src.slice(i, close + 1);
        i = close + 1;
        if (declaration && !/^(export\s+)?(declare\s+)?type\b/.test(h)) push("", null, i);
        continue;
      }
      const body = src.slice(i + 1, close);
      const balanced = close < src.length;
      i = close + 1;
      if (src[i] === ";") i++;
      push("{", body, i, balanced);
      continue;
    }
    if (c === ";" && p === 0) { i++; push(";", null, i); continue; }
    if (c === "\n" && p === 0 && head.trim() && /^\s*(export|import)\b/.test(src.slice(i + 1, i + 40))) { push("", null, i); i++; start = i; continue; }
    head += c;
    i++;
  }
  push("", null, src.length);
  return out;
}

// Length of an arrow-function head (through `=>`) at the start of s, or -1. One forward pass, no backtracking.
function arrowHeadLen(s: string): number {
  const n = s.length;
  let i = 0;
  const ws = (): void => { while (i < n && /\s/.test(s[i]!)) i++; };
  if (/^async\s/.test(s)) { i = 5; ws(); }
  if (s[i] === "<") {
    let d = 0;
    for (; i < n; i++) {
      if (s[i] === "=" && s[i + 1] === ">") i++;
      else if (s[i] === "<") d++;
      else if (s[i] === ">" && --d === 0) { i++; break; }
    }
    if (d !== 0) return -1;
    ws();
  }
  if (s[i] === "(") {
    let d = 0;
    for (; i < n; ) {
      const k = skipLiteral(s, i);
      if (k !== i) { i = k; continue; }
      if (s[i] === "(") d++;
      else if (s[i] === ")" && --d === 0) { i++; break; }
      i++;
    }
    if (d !== 0) return -1;
  } else {
    const st = i;
    while (i < n && /[\w$]/.test(s[i]!)) i++;
    if (i === st) return -1;
  }
  ws();
  if (s[i] === "=" && s[i + 1] === ">") return i + 2;
  if (s[i] !== ":") return -1;
  let d = 0;
  for (i++; i < n; ) {
    const k = skipLiteral(s, i);
    if (k !== i) { i = k; continue; }
    const c = s[i]!;
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
    else if (d === 0 && c === "=") return s[i + 1] === ">" ? i + 2 : -1;
    else if (d === 0 && c === ";") return -1;
    i++;
  }
  return -1;
}

// Cuts an initializer off a declaration head, keeping arrow and function-expression headers.
function memberSig(h: string): string | null {
  if (!h || /^(private|protected|#)/.test(h)) return null;
  let depth = 0, angle = 0;
  for (let i = 0; i < h.length; i++) {
    const c = h[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "<") angle++;
    else if (depth === 0 && c === ">" && h[i - 1] !== "=" && angle > 0) angle--;
    else if (c === "=" && depth === 0 && angle === 0 && !"=!<".includes(h[i - 1] ?? " ") && h[i + 1] !== "=" && h[i + 1] !== ">") {
      const rhs = h.slice(i + 1).trim();
      if (rhs.endsWith("=>") || /^(async\s+)?function\b/.test(rhs)) return h;
      const len = arrowHeadLen(rhs);
      return `${h.slice(0, i).trim()}${len > 0 ? ` = ${rhs.slice(0, len)}` : ""}`;
    }
  }
  return h;
}

// Splits `export let a = 1, b = 2` into its declarators at top-level commas.
function splitDeclarators(h: string): string[] {
  const parts: string[] = [];
  let depth = 0, angle = 0, init = false, from = 0;
  for (let i = 0; i < h.length; ) {
    const k = skipLiteral(h, i);
    if (k !== i) { i = k; continue; }
    const c = h[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && !init && c === "<") angle++;
    else if (depth === 0 && !init && c === ">" && h[i - 1] !== "=") angle = Math.max(0, angle - 1);
    else if (depth === 0 && angle === 0 && !init && c === "=" && h[i + 1] !== "=" && h[i + 1] !== ">" && !"=!<".includes(h[i - 1] ?? " ")) {
      init = true;
      const rest = h.slice(i + 1);
      const len = arrowHeadLen(rest.trimStart());
      if (len > 0) { i += 1 + (rest.length - rest.trimStart().length) + len; continue; }
    } else if (depth === 0 && angle === 0 && c === ",") { parts.push(h.slice(from, i)); from = i + 1; init = false; }
    i++;
  }
  parts.push(h.slice(from));
  return parts;
}

// The export's own head: stops at `;`, or at a line break once the statement is complete. Linear: each
// line break looks only at the last non-blank character region and the next non-blank character.
function exportHead(h: string, end: string): string {
  let depth = 0, last = -1, nn = -1;
  const star = /^export\s*(type\s*)?\*/.test(h.slice(0, 40));
  for (let i = 0; i < h.length; ) {
    const k = skipLiteral(h, i);
    if (k !== i) { last = k - 1; i = k; continue; }
    const c = h[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === ";") return h.slice(0, i + 1);
    else if (depth === 0 && c === "\n" && last >= 0) {
      if (nn < i) { nn = i; while (nn < h.length && /\s/.test(h[nn]!)) nn++; }
      const tail = h.slice(Math.max(0, last - 300), last + 1);
      const next = h.slice(nn, nn + 12);
      const open = /[=|&,<(:?.+\-*/]$|=>$|\b(from|as|extends|keyof|typeof|type)$/.test(tail) || /^(from\b|extends\b|as\b|[|&?:.,=])/.test(next);
      if (!open && (!star || /\bfrom\s*(["'])[^"']*\1$/.test(tail))) return h.slice(0, last + 1);
    }
    if (!/\s/.test(c)) last = i;
    i++;
  }
  return h.trimEnd() + (end === ";" ? ";" : "");
}

// True when a `;` at bracket depth 0 is followed by more text: a sign the statement scan desynced.
function hasTopSemi(line: string): boolean {
  let depth = 0;
  for (let i = 0; i < line.length; ) {
    const k = skipLiteral(line, i);
    if (k !== i) { i = k; continue; }
    const c = line[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth <= 0 && line.slice(i + 1).trim()) return true;
    i++;
  }
  return false;
}

const MODS = "(?:(?:public|private|protected|static|readonly|abstract|async|get|set|declare|override)\\s+)*";
const MEMBER_GRAMMAR = new RegExp(`^(?:@[\\w$.]+(?:\\([^)]*\\))?\\s*)*${MODS}\\*?\\s*(?:[A-Za-z_$][\\w$]*|#[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])\\s*[?!]?\\s*(?:[(<:=]|$)`);
const NOT_MEMBER = /^(return|const|let|var|if|else|for|while|do|switch|case|default|throw|try|catch|finally|new|await|yield|break|continue|import|export|function|delete|typeof|void)\b/;

// Strict, fail-closed class member check on the member's own head. A call statement such as `track(X);`
// has parentheses, no body and no return type, so it is rejected.
function strictMember(m: Item): boolean {
  const h = m.head.trim();
  if (!MEMBER_GRAMMAR.test(h) || NOT_MEMBER.test(h)) return false;
  if (m.end !== "{" && /^[^=:<]*\(/.test(h) && !/^(?:(?:public|protected|private)\s+)?constructor\b/.test(h) && !/\)\s*:/.test(h)) return false;
  return true;
}

function tsSignatures(src: string, jsx: boolean): string[] {
  const out: string[] = [];
  for (const it of items(src)) {
    const h = it.head.trim();
    if (!/^export\b/.test(h)) continue;
    const lines: string[] = [];
    if (/^export\s+(declare\s+)?(type|interface|enum)\b|^export\s*(type\s*)?[{*]/.test(h)) {
      lines.push(exportHead(h, it.end));
    } else if (/^export\s+(default\s+)?(abstract\s+)?class\b/.test(h)) {
      const ms = jsx || !it.balanced ? [] : items(it.body ?? "");
      const sigs = ms.map((m) => (strictMember(m) ? memberSig(m.head.trim()) : null));
      const dropped = ms.some((m) => !strictMember(m)) || sigs.some((m) => m !== null && (hasTopSemi(m) || NOT_MEMBER.test(m)));
      const keep = dropped ? [] : sigs.filter((m): m is string => !!m);
      lines.push(`${exportHead(h, "")} {`, ...keep.map((m) => `  ${m};`), "}");
    } else if (/^export\s+default\s/.test(h)) {
      const rest = h.replace(/^export\s+default\s+/, "");
      const len = arrowHeadLen(rest);
      if (len > 0) lines.push(`export default ${rest.slice(0, len)}`);
      else if (/^(async\s+)?function\b/.test(rest)) lines.push(memberSig(h) ?? h);
      else lines.push(/^[\w$.]+$/.test(rest) ? h : "export default ...");
    } else if (/^export\s+(const|let|var)\b/.test(h)) {
      lines.push(splitDeclarators(h).map((p) => memberSig(p.trim()) ?? p.trim()).join(", "));
    } else {
      lines.push(memberSig(h) ?? h);
    }
    if (!lines.some(hasTopSemi)) out.push(...lines);
  }
  return out;
}

const PY_HEADER_MAX_LINES = 50;

// Reads one Python signature starting at lines[i]; returns text cut at the colon closing the header, or
// null (fail closed) when strings or brackets do not close within the header or 50 lines.
function pyHeader(lines: string[], i: number): { text: string; next: number } | null {
  const src = lines.slice(i, i + PY_HEADER_MAX_LINES).join("\n");
  let depth = 0;
  for (let k = 0; k < src.length; k++) {
    const c = src[k]!;
    if (c === '"' || c === "'") {
      const q = src.startsWith(c.repeat(3), k) ? c.repeat(3) : c;
      let j = k + q.length;
      for (; j < src.length; j++) {
        if (src[j] === "\\") j++;
        else if (src.startsWith(q, j)) break;
        else if (q.length === 1 && src[j] === "\n") return null;
      }
      if (j >= src.length) return null;
      k = j + q.length - 1;
      continue;
    }
    if (c === "#") { while (k < src.length && src[k] !== "\n") k++; k--; continue; }
    if (c === "\\" && src[k + 1] === "\n") { k++; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ":" && depth === 0) {
      const raw = src.slice(0, k + 1);
      return { text: raw.split("\n").map((l) => l.trimEnd()).join("\n"), next: i + raw.split("\n").length };
    } else if (c === "\n" && depth <= 0) return null;
  }
  return null;
}

function pySignatures(src: string): string[] {
  const lines = norm(src).split("\n");
  const out: string[] = [];
  let pending: string[] = [], inClass = false, inTriple = false;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    const startedInTriple = inTriple;
    if ((line.match(/"""|'''/g) ?? []).length % 2 === 1) inTriple = !inTriple;
    if (startedInTriple || !line.trim()) { i++; continue; }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) inClass = false;
    const top: boolean = indent === 0;
    const member: boolean = inClass && indent === 4;
    if ((top || member) && line.trim().startsWith("@")) { pending.push(line.trimEnd()); i++; continue; }
    const m = /^\s*(?:async\s+)?(def|class)\s+(\w+)/.exec(line);
    if ((top || member) && m) {
      const hdr = pyHeader(lines, i);
      if (!hdr) { pending = []; i++; continue; }
      const { text, next } = hdr;
      const name = m[2]!;
      const isPublic: boolean = !name.startsWith("_") || (m[1] === "def" && member && /^__\w+__$/.test(name));
      if (isPublic) out.push(...pending, text);
      if (top && m[1] === "class") inClass = isPublic;
      pending = [];
      for (let k = i + 1; k < next; k++) inTriple = inTriple !== ((lines[k]!.match(/"""|'''/g) ?? []).length % 2 === 1);
      i = next;
      continue;
    }
    pending = [];
    const c = top ? /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/.exec(line) : null;
    if (c) out.push(`${c[1]} = ...`);
    i++;
  }
  return out;
}

function packageRunner(content: string): string | null {
  try {
    const pkg = JSON.parse(content) as { scripts?: { test?: string }; devDependencies?: Record<string, string> };
    const test = pkg.scripts?.test ?? "";
    const dev = Object.keys(pkg.devDependencies ?? {});
    const named = ["vitest", "jest", "mocha"].find((n) => test.includes(n) || dev.includes(n));
    return test.includes("bun test") ? "bun test" : (named ?? (test || null));
  } catch { return null; }
}

function pytestSection(content: string, header: RegExp): string[] {
  const lines = norm(content).split("\n");
  const at = lines.findIndex((l) => header.test(l));
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const stop = rest.findIndex((l) => /^\s*\[/.test(l));
  return [lines[at]!, ...(stop < 0 ? rest : rest.slice(0, stop))].filter((l) => l.trim());
}

function runnerSection(files: ManifestFile[]): string[] {
  const out: string[] = [];
  const get = (re: RegExp): ManifestFile[] => files.filter((f) => re.test(f.path));
  const pkg = get(/^package\.json$/)[0];
  const js = pkg ? packageRunner(pkg.content) : null;
  if (js) out.push(`runner: ${js}`, "config: package.json (scripts.test only)");
  for (const f of get(/^(bunfig\.toml|(vitest|jest)\.config\.[cm]?[jt]s)$/)) out.push(`config: ${f.path}`, ...norm(f.content).split("\n").slice(0, 20));
  const py = [
    ...get(/^pytest\.ini$/).map((f) => ({ f, lines: norm(f.content).split("\n").filter((l) => l.trim()) })),
    ...get(/^pyproject\.toml$/).map((f) => ({ f, lines: pytestSection(f.content, /^\[tool\.pytest/) })),
    ...get(/^(setup\.cfg|tox\.ini)$/).map((f) => ({ f, lines: pytestSection(f.content, /^\[(tool:)?pytest\]/) })),
  ].filter((x) => x.lines.length);
  if (py.length || get(/(^|\/)test_[^/]*\.py$/).length) out.push("runner: pytest");
  for (const { f, lines } of py) out.push(`config: ${f.path}`, ...lines.slice(0, 20));
  if (get(/^go\.mod$/).length) out.push("runner: go test", "config: go.mod");
  if (get(/^Cargo\.toml$/).length) out.push("runner: cargo test", "config: Cargo.toml");
  return out.length ? out : ["runner: none detected"];
}

// True when a test file imports a module whose stem matches one the task names.
function importsNamed(path: string, raw: string, stems: Set<string>): boolean {
  const content = raw.replace(/\\\n[ \t]*/g, " ");
  if ([...stems].some((s) => stemOf(path).split(/[._-]/).includes(s))) return true;
  const specs: string[] = [];
  for (const m of content.matchAll(/\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g)) specs.push(m[1]!);
  const names = (list: string): string[] => list.split(",").map((n) => n.replace(/#.*$/gm, "").trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
  for (const m of content.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]*(?:\(([^)]*)\)|([^\n]*))/gm)) specs.push(m[1]!, ...names(m[2] ?? m[3] ?? ""));
  for (const m of content.matchAll(/^[ \t]*import[ \t]+([\w.,\t ]+)$/gm)) specs.push(...names(m[1]!));
  return specs.some((s) => s.trim().replace(/\.(ts|js|py)$/, "").split(/[./\\]/).some((seg) => stems.has(seg)));
}

function safeTs(content: string, path: string): string[] {
  try { return tsSignatures(content, /\.[jt]sx$/.test(path)); } catch { return []; }
}

export function buildWallManifest(files: readonly ManifestFile[], taskModules: readonly string[]): string {
  const all = [...files].sort(byPath).map((f) => ({ path: f.path.replace(/^\.\//, ""), content: norm(f.content) }));
  const mods = [...new Set(taskModules.map((m) => m.replace(/^\.\//, "")))].sort();
  const stems = new Set(mods.map(stemOf));
  const tests = all.filter((f) => TEST_PATH.test(f.path));
  const out: string[] = ["# wall manifest (D77): signatures only, from the base tree", "", "## runner", ...runnerSection(all)];
  out.push("", "## test layout", ...tests.slice(0, MAX_LAYOUT).map((f) => f.path));
  if (tests.length > MAX_LAYOUT) out.push(`... ${tests.length - MAX_LAYOUT} more test files`);
  for (const path of mods) {
    const f = all.find((x) => x.path === path);
    if (!f) continue;
    out.push("", `## signatures: ${path}`, ...(path.endsWith(".py") ? pySignatures(f.content) : safeTs(f.content, path)));
  }
  out.push("", "## style examples");
  for (const f of tests.filter((t) => !importsNamed(t.path, t.content, stems)).slice(0, MAX_EXAMPLES)) {
    out.push(`--- example: ${f.path}`, ...f.content.split("\n").slice(0, EXAMPLE_LINES));
  }
  const lines = out.join("\n").split("\n");
  if (lines.length <= MANIFEST_MAX_LINES) return lines.join("\n");
  const keep = MANIFEST_MAX_LINES - 1;
  return [...lines.slice(0, keep), `... truncated: ${lines.length - keep} lines omitted`].join("\n");
}
