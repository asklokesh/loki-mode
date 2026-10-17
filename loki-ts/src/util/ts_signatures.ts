import { readFileSync } from "node:fs";
import { join } from "node:path";
// TS/JS public-signature extraction (moved from features/wall_manifest.ts, which keeps the manifest layout): a comment/literal-aware
// lexer that returns export heads with bodies, defaults and decorators masked. Pure; a file whose lexing is undecidable emits nothing.
interface Item { head: string; raw: string; end: string; body: string | null; balanced: boolean }
const REGEX_PREV = "(,=:[!&|?{;+-*%~^";
const isComment = (s: string, i: number): boolean => s[i] === "/" && (s[i + 1] === "/" || s[i + 1] === "*");

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

// True when the previous significant token before i is a comment (block, or any line holding a `//`). Shared by the pre-pass and regexEnd so a regex after a comment is ambiguous in both.
function commentBefore(s: string, i: number): boolean {
  let p = i - 1;
  while (p >= 0 && /\s/.test(s[p]!)) p--;
  if (p < 1) return false;
  if (s[p] === "/" && s[p - 1] === "*") return true;
  return s.slice(s.lastIndexOf("\n", p) + 1, p + 1).includes("//");
}

function regexEnd(s: string, i: number): number {
  if (commentBefore(s, i)) return i;
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

function stripComments(t: string): string {
  let out = "";
  for (let i = 0; i < t.length; ) {
    if (isComment(t, i)) {
      const e = t[i + 1] === "/" ? (t.indexOf("\n", i) < 0 ? t.length : t.indexOf("\n", i)) : (t.indexOf("*/", i + 2) < 0 ? t.length : t.indexOf("*/", i + 2) + 2);
      out += t[i + 1] === "/" ? "" : " ";
      i = e;
      continue;
    }
    const c = t[i]!;
    const k = c === '"' || c === "'" || c === "`" ? skipLiteral(t, i) : i;
    if (k !== i) { out += t.slice(i, k); i = k; continue; }
    out += c;
    i++;
  }
  return out;
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
        head += stripComments(src.slice(i, close + 1));
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

// Strict, fail-closed class member check on the member's own head. A call statement such as `track(X);` has parentheses, no body and no return type, so it is rejected.
function strictMember(m: Item): boolean {
  const h = m.head.trim();
  if (!MEMBER_GRAMMAR.test(h) || NOT_MEMBER.test(h)) return false;
  if (m.end !== "{" && /^[^=:<]*\(/.test(h) && !/^(?:(?:public|protected|private)\s+)?constructor\b/.test(h) && !/\)\s*:/.test(h)) return false;
  return true;
}

// Whole-file fail-closed pre-pass. True when the file cannot be lexed with certainty: a `/` that is not a
// comment and whose previous token is `)`, `]`, `}`, a word, a quote, `++`/`--` or anything else that is not a
// clear regex prefix; any backtick in jsx/tsx; an unterminated string, template, regex or comment; or brackets that do not balance. Iterative, so deep nesting cannot overflow the stack.
export function tsAmbiguous(s: string, jsx: boolean): boolean {
  const n = s.length, stack: string[] = [];
  const tpl = (from: number): number => {
    for (let j = from; j < n; ) {
      const c = s[j];
      if (c === "\\") j += 2;
      else if (c === "`") return j + 1;
      else if (c === "$" && s[j + 1] === "{") { stack.push("$"); return j + 2; }
      else j++;
    }
    return -1;
  };
  let prev = "", prev2 = "";
  const set = (c: string): void => { prev2 = prev; prev = c; };
  for (let i = 0; i < n; ) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); if (e < 0) break; i = e; continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) return true; i = e + 2; continue; }
    if (c === "`" || c === "}" && stack[stack.length - 1] === "$") {
      if (c === "`" && jsx) return true;
      if (c === "}") stack.pop();
      const e = tpl(i + 1);
      if (e < 0) return true;
      i = e; set("a");
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < n && s[j] !== c; j++) { if (s[j] === "\\") j++; else if (s[j] === "\n") return true; }
      if (j >= n) return true;
      i = j + 1; set("a");
      continue;
    }
    if (c === "/") {
      if (jsx && prev === "<") { i++; set("/"); continue; }
      if (commentBefore(s, i)) return true;
      if (prev && !"(,=:[!&|?{;+-*%~^".includes(prev)) return true;
      if ((prev === "+" || prev === "-") && prev2 === prev) return true;
      let j = i + 1, cls = false, closed = false;
      for (; j < n; j++) {
        const d = s[j]!;
        if (d === "\n") return true;
        if (d === "\\") j++;
        else if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) { closed = true; break; }
      }
      if (!closed) return true;
      i = j + 1;
      while (i < n && /[a-z]/i.test(s[i]!)) i++;
      set("a");
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      const o = stack.pop();
      if (o !== (c === ")" ? "(" : c === "]" ? "[" : "{")) return true;
    }
    set(c);
    i++;
  }
  return stack.length > 0;
}

function maskDefaults(sig: string): string {
  let out = "", pd = 0;
  for (let i = 0; i < sig.length; ) {
    const k = skipLiteral(sig, i);
    if (k !== i) { out += sig.slice(i, k); i = k; continue; }
    const c = sig[i]!;
    if (c === "(") pd++;
    else if (c === ")") pd--;
    else if (c === "=" && pd > 0 && sig[i + 1] !== "=" && sig[i + 1] !== ">" && !"=!<".includes(sig[i - 1] ?? " ")) {
      out = out.trimEnd() + " = ...";
      let d = 0, angle = 0, j = i + 1;
      for (; j < sig.length; ) {
        const l = skipLiteral(sig, j);
        if (l !== j) { j = l; continue; }
        const e = sig[j]!;
        if ("([{".includes(e)) d++;
        else if (")]}".includes(e)) { if (d === 0) break; d--; }
        else if (e === "<" && /[\w$]/.test(sig[j - 1] ?? "")) angle++;
        else if (e === ">" && sig[j - 1] !== "=" && angle > 0) angle--;
        else if (e === "," && d === 0 && angle === 0) break;
        j++;
      }
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// `@Name` / `@a.b` stays; `@Name(args)` (no gap before the paren) becomes `@Name(...)`. After the name or the
// group the next non-space character must not be `(`, `<`, `?`, `!`, `[` or `.`. Any other shape returns null so the caller omits the whole class or declaration.
// A reserved statement or expression keyword right after a decorator is invalid TS: fail closed (W1-S2).
const RESERVED_AFTER_DECORATOR = /^(?:if|else|for|while|do|switch|case|try|catch|finally|return|throw|with|var|let|const|function|new|delete|typeof|void|yield|await|break|continue|import|debugger|instanceof|this|super|null|true|false)(?![\w$])/;
function maskDecorators(sig: string): string | null {
  let out = "";
  // Allowlist: after a decorator only an identifier start or another @ may follow.
  const badNext = (at: number): boolean => { const r = sig.slice(at).trimStart(); return !/[A-Za-z_$@]/.test(r[0] ?? "") || RESERVED_AFTER_DECORATOR.test(r); };
  for (let i = 0; i < sig.length; ) {
    const k = skipLiteral(sig, i);
    if (k !== i) { out += sig.slice(i, k); i = k; continue; }
    if (sig[i] !== "@") { out += sig[i]; i++; continue; }
    const m = /^@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(sig.slice(i, i + 200));
    if (!m) return null;
    out += m[0];
    i += m[0].length;
    if (sig[i] === "(") { out += "(...)"; i = skipBalanced(sig, i); }
    if (badNext(i)) return null;
  }
  return out;
}

function skipBalanced(s: string, i: number): number {
  let d = 0;
  while (i < s.length) {
    const k = skipLiteral(s, i);
    if (k !== i) { i = k; continue; }
    if ("([{".includes(s[i]!)) d++;
    else if (")]}".includes(s[i]!) && --d === 0) return i + 1;
    i++;
  }
  return s.length;
}

function maskExtends(head: string): string {
  let angle = 0, depth = 0;
  for (let i = 0; i < head.length; ) {
    const k = skipLiteral(head, i);
    if (k !== i) { i = k; continue; }
    const c = head[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "<") angle++;
    else if (c === ">" && head[i - 1] !== "=") angle = Math.max(0, angle - 1);
    else if (depth === 0 && angle === 0 && /^extends\s/.test(head.slice(i)) && /\W/.test(head[i - 1] ?? " ")) {
      const from = i + 7;
      const im = /\simplements\s/.exec(head.slice(from));
      const end = im ? from + im.index : head.length;
      const expr = head.slice(from, end).trim();
      const ok = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^()]*>)?$/.test(expr);
      const tail = head.slice(end).trim();
      return `${head.slice(0, i)}extends ${ok ? expr : "..."}${tail ? ` ${tail}` : ""}`;
    }
    i++;
  }
  return head;
}

function enumSig(h: string): string | null {
  const open = h.indexOf("{");
  if (open < 0) return null;
  const close = matchingBrace(h, open);
  if (close >= h.length) return null;
  const names: string[] = [];
  let depth = 0, from = open + 1;
  const take = (to: number): void => { const nm = h.slice(from, to).split("=")[0]!.trim(); if (nm) names.push(nm); };
  for (let i = open + 1; i < close; ) {
    const k = skipLiteral(h, i);
    if (k !== i) { i = k; continue; }
    const c = h[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { take(i); from = i + 1; }
    i++;
  }
  take(close);
  return `${h.slice(0, open).trim()} { ${names.join(", ")} }`;
}

export function tsSignatures(src: string, jsx: boolean): string[] {
  const out: string[] = [];
  for (const it of items(src)) {
    const h = it.head.trim();
    if (!/^export\b/.test(h)) continue;
    const lines: string[] = [];
    if (/^export\s+(declare\s+)?enum\b/.test(h)) {
      lines.push(enumSig(h) ?? exportHead(h, it.end));
    } else if (/^export\s+(declare\s+)?(type|interface)\b|^export\s*(type\s*)?[{*]/.test(h)) {
      lines.push(exportHead(h, it.end));
    } else if (/^export\s+(default\s+)?(abstract\s+)?class\b/.test(h)) {
      const ms = jsx || !it.balanced ? [] : items(it.body ?? "");
      const sigs = ms.map((m) => (strictMember(m) ? memberSig(m.head.trim()) : null)).map((m) => (m === null ? null : maskDefaults(m)));
      const dropped = ms.some((m) => !strictMember(m)) || sigs.some((m) => m !== null && (hasTopSemi(m) || NOT_MEMBER.test(m)));
      const keep = dropped ? [] : sigs.filter((m): m is string => !!m);
      const headM = maskDecorators(exportHead(h, ""));
      const memM = keep.map(maskDecorators);
      if (headM !== null && !memM.includes(null)) lines.push(`${maskExtends(headM)} {`, ...memM.map((m) => `  ${m};`), "}");
    } else if (/^export\s+(default\s+)?@/.test(h)) {
      const dm = maskDecorators(h);
      if (dm !== null) lines.push(maskExtends(dm));
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
    if (!lines.length) continue;
    const masked = /^export\s+(declare\s+)?(type|interface|enum)\b|^export\s*(type\s*)?[{*]|^export\s+(default\s+)?(abstract\s+)?class\b/.test(h) ? lines : lines.map((l) => { const d = maskDecorators(l); return d === null ? null : maskDefaults(d); });
    if (masked.includes(null)) continue;
    const done = masked as string[];
    if (!done.some(hasTopSemi)) out.push(...done);
  }
  return out;
}

// Python def/class headers up to the colon. Nested defs inside a function are skipped; methods keep their indentation under the class.
function pySignatures(src: string): string[] {
  const lines = src.split("\n"), out: string[] = [], stack: { indent: number; cls: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:async\s+def|def|class)\s/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const isClass = /^\s*class\s/.test(lines[i]!);
    let head = lines[i]!.trimEnd();
    for (let j = i + 1; j < lines.length && (head.split("(").length !== head.split(")").length || !/:\s*(#.*)?$|:\s*\S/.test(head)) && j < i + 12; j++) head += ` ${lines[j]!.trim()}`;
    const top = stack.length === 0 || stack[stack.length - 1]!.cls;
    stack.push({ indent, cls: isClass });
    if (!top) continue;
    let colon = -1;
    for (let k = 0, d = 0; k < head.length && colon < 0; k++) {
      if ("([{".includes(head[k]!)) d++;
      else if (")]}".includes(head[k]!)) d--;
      else if (head[k] === ":" && d === 0) colon = k;
    }
    out.push(colon >= 0 ? head.slice(0, colon + 1) : head);
  }
  return out;
}

// Deterministic signature digest in the order of `files`, capped at maxBytes (whole lines only). Unreadable or ambiguous files are skipped.
export function signatureDigest(repoDir: string, files: string[], maxBytes = 4000): string {
  const out: string[] = [];
  let used = 0;
  for (const f of files) {
    let src: string;
    try { src = readFileSync(join(repoDir, f), "utf8"); } catch { continue; }
    const jsx = /\.[jt]sx$/.test(f);
    let sigs: string[] = [];
    if (/\.py$/.test(f)) sigs = pySignatures(src);
    else if (/\.[cm]?[jt]sx?$/.test(f) && !tsAmbiguous(src, jsx)) sigs = tsSignatures(src, jsx).flatMap((x) => x.split("\n"));
    if (!sigs.length) continue;
    for (const l of [f, ...sigs.map((x) => (x.startsWith(" ") ? x : `  ${x}`))]) {
      const n = Buffer.byteLength(l) + 1;
      if (used + n > maxBytes) return out.join("\n");
      out.push(l);
      used += n;
    }
  }
  return out.join("\n");
}
