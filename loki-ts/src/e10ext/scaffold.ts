// Zero-model scaffolding (prototype, LOKI_E10_SCAFFOLD=1): deterministic passes the machine runs on the implemented tree
// right before verify, so verify and the fix loop see their result. No model call, no network; every pass is generic
// (keyed on repo files and the diff shape, never on a task). Passes:
//   fragment:   the repo keeps release-note fragments (changesets, towncrier) and the change adds none: write one from
//               the repo's own conventions (package names from the nearest package.json, quote style from existing fragments).
//   systematic: the change rewrote >=2 lines of one shape the same way (a learned rewrite rule); an unchanged line of that same
//               shape in a changed file, whose differing identifier the task names, gets the same rewrite.
//   sibling:    detect only: inside a hunk's neighborhood, two calls of one `x = f(x, ...)` form pass different trailing
//               arguments where one site is next to the edit (raw versus normalized input); reported, never applied.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonc } from "../project_model/conventions.ts";
import { isTestFile } from "../util/test_file_text.ts";
import { safeGit } from "../util/safe_git.ts";

export const scaffoldEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_SCAFFOLD === "1";

export interface Rewrite { file: string; line: number; before: string; after: string[]; rule: string }
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
const KEYWORDS = new Set(["if", "else", "for", "while", "return", "var", "let", "const", "func", "function", "def", "class", "new", "await", "async", "in", "not", "and", "or", "switch", "case", "break", "continue", "true", "false", "nil", "null", "None", "True", "False", "this", "self", "range", "go", "defer", "try", "catch", "throw", "raise", "except", "import", "from", "type", "interface", "struct"]);
type Tok = { t: string; id: boolean };
const tokenize = (line: string): Tok[] => [...line.matchAll(/[A-Za-z_]\w*|\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|:=|==|!=|=>|->|&&|\|\||\S/g)].map((m) => ({ t: m[0], id: /^[A-Za-z_]\w*$/.test(m[0]) && !KEYWORDS.has(m[0]) }));
/** Shape: identifiers become holes numbered by first appearance, so the equality pattern between holes is part of the shape. */
function shape(toks: Tok[]): { key: string; binds: string[] } {
  const binds: string[] = [];
  const key = toks.map((k) => { if (!k.id) return k.t; let i = binds.indexOf(k.t); if (i < 0) { binds.push(k.t); i = binds.length - 1; } return `$${i}`; }).join(" ");
  return { key, binds };
}
/** An added line as a template over the removed line's binds: a bound identifier becomes $i, anything else stays literal. */
const templ = (added: string, binds: string[]): string => tokenize(added).map((k) => (k.id && binds.includes(k.t) ? `$${binds.indexOf(k.t)}` : k.t)).join(" ");

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

/** Renders one exemplar added line for a candidate: each identifier the template holds as $i becomes the candidate's bind i; spacing is the exemplar's. */
const render = (tpl: string, binds: string[], exemplar: string, exemplarBinds: string[]): string =>
  exemplar.replace(/[A-Za-z_]\w*/g, (w) => { const i = exemplarBinds.indexOf(w); return i >= 0 && tpl.split(" ").includes(`$${i}`) ? binds[i]! : w; });

const taskIdents = (task: string): Set<string> => new Set([...task.matchAll(/[A-Za-z_]\w{2,}/g)].map((m) => m[0]));

function systematic(repoDir: string, baseSha: string, changes: Change[], task: string): Rewrite[] {
  type Rule = { key: string; addedTpl: string[]; inst: { binds: string[]; added: string[]; file: string }[] };
  const rules = new Map<string, Rule>();
  const files = changes.filter(({ st, f }) => st === "M" && CODE.test(f) && !isTestFile(f)).map(({ f }) => f);
  const touched = new Map<string, Set<number>>(); // new-side line numbers each hunk wrote
  for (const f of files) {
    const set = new Set<number>(); touched.set(f, set);
    for (const h of hunks(safeGit(repoDir, ["diff", "-U0", "--no-color", baseSha, "--", f]))) {
      for (let i = 0; i < h.added.length; i++) set.add(h.newStart + i);
      if (h.removed.length !== 1 || h.added.length === 0) continue; // one line rewritten into one or more lines: a rule instance
      const s = shape(tokenize(h.removed[0]!));
      if (s.binds.length === 0) continue;
      const addedTpl = h.added.map((a) => templ(a.trim(), s.binds)), sig = `${s.key}\u0000${addedTpl.join("\u0001")}`;
      const r = rules.get(sig) ?? { key: s.key, addedTpl, inst: [] }; r.inst.push({ binds: s.binds, added: h.added, file: f }); rules.set(sig, r);
    }
  }
  const named = taskIdents(task), out: Rewrite[] = [];
  for (const r of rules.values()) {
    if (r.inst.length < 2) continue; // one instance is an edit, two of the same shape and the same rewrite are a rule
    // every literal identifier on the added side is the same across instances by construction (sig includes it); every hole
    // the added side uses must be bound by the removed side, which templ guarantees.
    for (const f of new Set(r.inst.map((i) => i.file))) {
      const lines = readFileSync(join(repoDir, f), "utf8").split("\n"), wrote = touched.get(f) ?? new Set<number>();
      for (let n = 0; n < lines.length; n++) {
        if (wrote.has(n + 1)) continue;
        const s = shape(tokenize(lines[n]!));
        if (s.key !== r.key) continue;
        // the identifiers that differ from every instance: at least one must be named in the task, and none may be the blank `_`
        const diffIdx = s.binds.map((b, i) => (r.inst.every((x) => x.binds[i] !== b) ? i : -1)).filter((i) => i >= 0);
        if (s.binds.includes("_") || !diffIdx.some((i) => named.has(s.binds[i]!))) continue;
        // every identifier that differs must flow into the rewrite; a rule that drops it (an added literal derived from the old name) is not this rule
        if (!diffIdx.every((i) => r.addedTpl.some((t) => t.split(" ").includes(`$${i}`)))) continue;
        const ex = r.inst[0]!, indent = /^\s*/.exec(lines[n]!)![0], exIndent = /^\s*/.exec(ex.added[0]!)![0];
        const after = ex.added.map((a, i) => indent + render(r.addedTpl[i]!, s.binds, a.slice(exIndent.length), ex.binds));
        out.push({ file: f, line: n + 1, before: lines[n]!, after, rule: `${r.inst.length} lines of this shape were rewritten the same way` });
      }
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

export function scaffold(repoDir: string, baseSha: string, task: string, opts: { apply?: boolean } = {}): ScaffoldResult {
  const changes = changedFiles(repoDir, baseSha);
  const res: ScaffoldResult = { fragments: [], rewrites: [], siblings: [] };
  if (changes.length === 0) return res; // nothing implemented: nothing to scaffold
  const rw = systematic(repoDir, baseSha, changes, task);
  if (opts.apply !== false && rw.length) applyRewrites(repoDir, rw);
  res.rewrites = rw;
  res.siblings = siblings(repoDir, baseSha, changes);
  for (const w of [changesetFragment, towncrierFragment]) { const f = w(repoDir, changes, task); if (f) res.fragments.push(f); }
  return res;
}
