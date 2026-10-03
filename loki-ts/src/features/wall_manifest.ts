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
const ARROW_HEAD = /^(async\s+)?(<[^>]*>\s*)?(\([^)]*\)|\w+)\s*(:\s*[^=]+?)?\s*=>/;
const norm = (s: string): string => s.replace(/\r\n?/g, "\n");
const stemOf = (p: string): string => (p.split("/").pop() ?? p).replace(/\.[^.]*$/, "");
const byPath = (a: ManifestFile, b: ManifestFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

interface Item { head: string; raw: string; end: string; body: string | null }

// Skips one string, template, or comment starting at i; returns the index after it, or i when none starts here.
function skipLiteral(s: string, i: number): number {
  const c = s[i];
  if (c === "/" && s[i + 1] === "/") { const n = s.indexOf("\n", i); return n < 0 ? s.length : n; }
  if (c === "/" && s[i + 1] === "*") { const n = s.indexOf("*/", i + 2); return n < 0 ? s.length : n + 2; }
  if (c !== '"' && c !== "'" && c !== "`") return i;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === c) return j + 1;
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
  const push = (end: string, body: string | null, stop: number): void => {
    if (head.trim()) out.push({ head, raw: src.slice(start, stop).trim(), end, body });
    head = ""; p = 0; start = stop;
  };
  while (i < src.length) {
    const j = skipLiteral(src, i);
    if (j !== i) {
      if (src[i] !== "/") head += src.slice(i, j);
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
      if (declaration || h === "" || /^export(\s+type)?$/.test(h)) {
        head += src.slice(i, close + 1);
        i = close + 1;
        if (declaration && !h.startsWith("type") && !h.includes("= ")) push("", null, i);
        continue;
      }
      const body = src.slice(i + 1, close);
      i = close + 1;
      if (src[i] === ";") i++;
      push("{", body, i);
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

// Cuts an initializer off a declaration head, keeping arrow and function-expression headers.
function memberSig(h: string): string | null {
  if (!h || /^(private|protected|#)/.test(h)) return null;
  let depth = 0;
  for (let i = 0; i < h.length; i++) {
    const c = h[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "=" && depth === 0 && !"=!<>".includes(h[i - 1] ?? " ") && h[i + 1] !== "=" && h[i + 1] !== ">") {
      const rhs = h.slice(i + 1).trim();
      if (rhs.endsWith("=>") || /^(async\s+)?function\b/.test(rhs)) return h;
      const arrow = ARROW_HEAD.exec(rhs);
      return `${h.slice(0, i).trim()}${arrow ? ` = ${arrow[0]}` : ""}`;
    }
  }
  return h;
}

function tsSignatures(src: string): string[] {
  const out: string[] = [];
  for (const it of items(src)) {
    const h = it.head.trim();
    if (!/^export\b/.test(h)) continue;
    if (/^export\s+(declare\s+)?(type|interface|enum)\b|^export\s*(type\s*)?[{*]/.test(h)) {
      out.push(it.raw);
    } else if (/^export\s+(default\s+)?(abstract\s+)?class\b/.test(h)) {
      const members = items(it.body ?? "").map((m) => memberSig(m.head.trim())).filter((m): m is string => !!m);
      out.push(`${h} {`, ...members.map((m) => `  ${m};`), "}");
    } else {
      out.push(memberSig(h) ?? h);
    }
  }
  return out;
}

// Reads one Python signature starting at lines[i]; returns text cut at the colon closing the header.
function pyHeader(lines: string[], i: number): { text: string; next: number } {
  let text = "", depth = 0;
  for (let n = i; n < lines.length; n++) {
    const line = lines[n]!;
    for (let k = 0; k < line.length; k++) {
      const c = line[k]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === ":" && depth === 0) return { text: text + line.slice(0, k + 1).trimEnd(), next: n + 1 };
    }
    text += line.trimEnd() + "\n";
  }
  return { text: text.trimEnd(), next: lines.length };
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
      const { text, next } = pyHeader(lines, i);
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
function importsNamed(path: string, content: string, stems: Set<string>): boolean {
  if ([...stems].some((s) => stemOf(path).split(/[._-]/).includes(s))) return true;
  const specs: string[] = [];
  for (const m of content.matchAll(/(?:from|import|require\()\s*["']([^"']+)["']/g)) specs.push(m[1]!);
  for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) specs.push(m[1]!);
  for (const m of content.matchAll(/^\s*import\s+([\w.,\s]+)$/gm)) specs.push(...m[1]!.split(","));
  return specs.some((s) => s.trim().replace(/\.(ts|js|py)$/, "").split(/[./\\]/).some((seg) => stems.has(seg)));
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
    out.push("", `## signatures: ${path}`, ...(path.endsWith(".py") ? pySignatures(f.content) : tsSignatures(f.content)));
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
