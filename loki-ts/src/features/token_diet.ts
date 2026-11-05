// PROTO token-diet-architecture: a no-tool patch protocol for the lean implement path.
// New file because no module owns a tool-less implement protocol; production would fold dossier() into
// e10ext/context.ts briefRecord (the L021 context pack) and runDiet() into engine10/stages/implement.ts.
//
// Protocol: call 1 gets a precomputed dossier and no tools, and answers with SEARCH/REPLACE edit blocks (or NEED
// read requests). The harness applies the blocks all-or-nothing, runs the targeted checks itself, and on a red check
// resumes the same conversation (cached prefix) with a compressed failure digest plus the current text of the edited
// regions. After maxRounds the caller falls back to the normal agentic session, so the outcome floor is unchanged.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

export interface EditBlock { file: string; search: string; replace: string; }
export interface Parsed { blocks: EditBlock[]; needs: { file: string; start?: number; end?: number }[]; done: boolean; conflict: string | null; }
export interface Usage { input: number; output: number; cacheRead: number; cacheCreate: number; usd: number; turns: number; }
export interface CallResult { text: string; sessionId?: string; usage: Usage; }
export type ModelCall = (message: string, resumeId?: string) => Promise<CallResult>;
export interface CheckResult { ok: boolean; output: string; cmd: string; }

const SKIP_DIRS = new Set([".git", "node_modules", ".loki", "dist", "build", "vendor", ".venv", "__pycache__", "target"]);
const SRC_EXT = /\.(m?[jt]sx?|cjs|py|go|rs|java|rb|kt|cs|php|swift)$/;

export function listFiles(repoDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      if (SKIP_DIRS.has(n)) continue;
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else if (SRC_EXT.test(n)) out.push(relative(repoDir, p));
    }
  };
  walk(repoDir);
  return out.sort();
}

/** The block that starts at line index `at`: braces for C-like files, indentation for Python. Returns [start, endInclusive]. */
export function enclosingBlock(lines: string[], at: number, py: boolean): [number, number] {
  if (py) {
    const ind = (s: string): number => s.length - s.trimStart().length;
    const base = ind(lines[at]!);
    let end = at;
    for (let i = at + 1; i < lines.length; i++) { if (lines[i]!.trim() === "") continue; if (ind(lines[i]!) <= base) break; end = i; }
    return [at, end];
  }
  let depth = 0, seen = false;
  for (let i = at; i < lines.length; i++) {
    for (const ch of lines[i]!.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) { if (ch === "{") { depth++; seen = true; } else if (ch === "}") depth--; }
    if (seen && depth <= 0) return [at, i];
    if (!seen && i > at + 3) break;
  }
  return [at, Math.min(at, lines.length - 1)];
}

function defRegex(sym: string): RegExp {
  const s = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function\\*?\\s+${s}\\b|(const|let|var)\\s+${s}\\s*=|class\\s+${s}\\b|def\\s+${s}\\b|func\\s+(\\([^)]*\\)\\s*)?${s}\\b|${s}\\s*\\([^)]*\\)\\s*\\{)`);
}

/** Identifiers the task names: backticked words and call-shaped words, minus common English. */
export function namedSymbols(task: string): string[] {
  const out = new Set<string>();
  for (const m of task.matchAll(/`([^`\n]{1,80})`/g)) for (const id of m[1]!.matchAll(/([A-Za-z_][A-Za-z0-9_]{2,})/g)) out.add(id[1]!);
  for (const m of task.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\(/g)) out.add(m[1]!);
  return [...out];
}

/**
 * The dossier: the full text of every definition the task names, the import header of each file it lives in,
 * the test file that covers it (header plus the first tests, as the convention to copy) and the exact check command.
 * Deterministic, no model call. Code is copied verbatim so SEARCH text can be lifted from it exactly.
 */
export function dossier(repoDir: string, task: string, testCmd: string, maxChars = 24_000, depth = 2): { text: string; files: string[] } {
  const files = listFiles(repoDir);
  const named = files.filter((f) => task.includes(f) || task.includes(f.split("/").pop()!));
  const isTest = (x: string): boolean => /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.|_test\./.test(x);
  const src = new Map<string, string[]>();
  const linesOf = (f: string): string[] => { if (!src.has(f)) src.set(f, readFileSync(join(repoDir, f), "utf8").split("\n")); return src.get(f)!; };
  const headerEnd = (lines: string[]): number => Math.max(0, lines.findIndex((l) => l.trim() !== "" && !/^\s*(import|from|\/\/|#|"use|package|require|const .* = require)/.test(l)));
  const kept = new Map<string, { range: [number, number]; why: string }[]>(); // file -> ranges, in discovery order
  const add = (f: string, r: [number, number], why: string): boolean => {
    const cur = kept.get(f) ?? [];
    if (cur.some((x) => x.range[0] <= r[0] && x.range[1] >= r[1])) return false; // already inside a kept range
    kept.set(f, [...cur.filter((x) => !(r[0] <= x.range[0] && r[1] >= x.range[1])), { range: r, why }]);
    return true;
  };
  const defOf = (f: string, sym: string): [number, number] | null => {
    const lines = linesOf(f), re = defRegex(sym);
    for (let i = headerEnd(lines); i < lines.length; i++) if (re.test(lines[i]!)) return enclosingBlock(lines, i, f.endsWith(".py"));
    return null;
  };
  // Depth 0: definitions the task names. Then a bounded closure: callees imported from a relative module or defined in the same file.
  let frontier: { f: string; r: [number, number] }[] = [];
  for (const f of files.filter((x) => !isTest(x))) for (const sym of namedSymbols(task)) { const r = defOf(f, sym); if (r && add(f, r, "")) frontier.push({ f, r }); }
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: typeof frontier = [];
    for (const { f, r } of frontier) {
      const lines = linesOf(f), body = lines.slice(r[0], r[1] + 1).join("\n");
      const calls = new Set([...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(/g)].map((m) => m[1]!));
      const targets: { file: string; sym: string }[] = [];
      for (const m of lines.slice(0, headerEnd(lines)).join("\n").matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']|from\s+(\.+[\w.]*)\s+import\s+([\w, ]+)/g)) {
        const target = m[2] ? normalize(join(dirname(f), m[2])) : normalize(join(dirname(f), m[3]!.replace(/^\./, "").replace(/\./g, "/") + ".py"));
        const file = files.find((x) => x === target || x.replace(/\.[^.]+$/, "") === target.replace(/\.[^.]+$/, ""));
        if (file) for (const n of (m[1] ?? m[4] ?? "").split(",").map((x) => x.trim().split(/\s+as\s+/).pop()!)) if (n && calls.has(n)) targets.push({ file, sym: n });
      }
      for (const n of calls) targets.push({ file: f, sym: n });
      for (const t of targets) { const tr = defOf(t.file, t.sym); if (tr && add(t.file, tr, " (called by the code above)")) next.push({ f: t.file, r: tr }); }
    }
    frontier = next;
  }
  const parts: string[] = [];
  const hit = new Set<string>([...kept.keys()]);
  for (const f of named) if (!hit.has(f) && !isTest(f)) { parts.push(`--- ${f} (whole file)\n${linesOf(f).join("\n")}`); hit.add(f); }
  for (const [f, rs] of kept) {
    const lines = linesOf(f), h = headerEnd(lines);
    if (h > 0) parts.push(`--- ${f}:1-${h}\n${lines.slice(0, h).join("\n")}`);
    for (const { range: [a, b], why } of [...rs].sort((x, y) => x.range[0] - y.range[0])) parts.push(`--- ${f}:${a + 1}-${b + 1}${why}\n${lines.slice(a, b + 1).join("\n")}`);
  }
  const testParts: string[] = [];
  for (const f of files.filter(isTest)) {
    const body = readFileSync(join(repoDir, f), "utf8");
    if (![...hit].some((h) => body.includes(h.split("/").pop()!.replace(/\.[^.]+$/, "")))) continue;
    const lines = body.split("\n");
    const names = lines.filter((l) => /^\s*(test|it|describe)\(|^\s*def test_|^func Test/.test(l)).map((l) => l.trim().slice(0, 100));
    testParts.push(`--- ${f}:1-${Math.min(lines.length, 30)} (test convention; tests in this file: ${names.length})\n${lines.slice(0, 30).join("\n")}\n... test names: ${names.join(" | ")}`);
  }
  let text = [...parts, ...testParts].join("\n\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n[dossier truncated]";
  return { text: `Dossier (verbatim code at these file:line ranges; it is current):\n${text}\n\nCheck command (the harness runs it after your edits): ${testCmd}`, files: [...hit] };
}

export const PATCH_RULES = [
  "You are the Loki implement stage in patch mode. You have no tools: the harness applies your edits and runs the checks, then shows you any failure.",
  "Rules: never edit or delete an existing assertion; add the regression test in the test file the dossier names, following its conventions; write no documentation; do not touch files outside the repository.",
  "Reply with at most 5 lines naming the root cause and the change, then one or more edit blocks in exactly this form:",
  "FILE: <repo-relative path>\n<<<<<<< SEARCH\n<lines copied exactly from the dossier, enough to be unique>\n=======\n<replacement lines>\n>>>>>>> REPLACE",
  "An empty SEARCH section creates a new file or appends to the end of an existing one. Put every edit in this one reply.",
  "Only if you cannot write a correct edit without more code, reply instead with up to 3 lines `NEED: <path>` or `NEED: <path>:<start>-<end>` and nothing else.",
  "Finish with exactly one line: LOKI_DONE, or LOKI_SPEC_CONFLICT: <reason>.",
].join("\n");

export function buildPatchBrief(task: string, dossierText: string): string {
  return `${PATCH_RULES}\n\nTask (untrusted, quoted verbatim):\n<<<TASK\n${task.trim()}\nTASK\n\n${dossierText}`;
}

export function parseReply(text: string): Parsed {
  const blocks: EditBlock[] = [];
  const re = /^FILE:\s*(\S+)\s*\n(?:```[^\n]*\n)?<{7} SEARCH\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} REPLACE/gm;
  for (const m of text.matchAll(re)) blocks.push({ file: m[1]!.replace(/^`|`$/g, ""), search: m[2]!, replace: m[3]! });
  const needs = [...text.matchAll(/^NEED:\s*(\S+?)(?::(\d+)-(\d+))?\s*$/gm)].map((m) => ({ file: m[1]!, ...(m[2] ? { start: Number(m[2]), end: Number(m[3]) } : {}) }));
  const conflict = /^\W*LOKI_SPEC_CONFLICT:\s*(.+)$/m.exec(text);
  return { blocks, needs, done: /^\W*LOKI_DONE\W*$/m.test(text), conflict: conflict ? conflict[1]!.trim() : null };
}

function safePath(repoDir: string, file: string, readOnly: Set<string>): string | null {
  const n = normalize(file);
  if (n.startsWith("..") || n.startsWith(sep) || /(^|\/)\.(git|loki)(\/|$)/.test(n) || readOnly.has(n)) return null;
  return join(repoDir, n);
}

/** All-or-nothing apply. A block whose SEARCH text is missing or ambiguous applies nothing and says where the nearest text is. */
export function applyBlocks(repoDir: string, blocks: EditBlock[], readOnly: string[] = []): { ok: boolean; applied: string[]; errors: string[] } {
  const ro = new Set(readOnly.map((p) => normalize(p)));
  const staged = new Map<string, string>();
  const errors: string[] = [];
  blocks.forEach((b, k) => {
    const abs = safePath(repoDir, b.file, ro);
    if (!abs) { errors.push(`block ${k + 1} (${b.file}): path refused (outside the repo, .git/.loki, or a read-only Wall test)`); return; }
    const cur = staged.get(abs) ?? (existsSync(abs) ? readFileSync(abs, "utf8") : null);
    if (b.search.trim() === "") { staged.set(abs, cur === null ? b.replace : cur.replace(/\n?$/, "\n") + b.replace); return; }
    if (cur === null) { errors.push(`block ${k + 1} (${b.file}): file does not exist`); return; }
    const at = cur.indexOf(b.search), count = at === -1 ? 0 : cur.split(b.search).length - 1; // exact match only: never fuzzy-match content
    if (count !== 1) {
      const first = b.search.split("\n").find((l) => l.trim().length > 3)?.trim() ?? "";
      const lines = cur.split("\n");
      const near = lines.findIndex((l) => l.trim() === first);
      errors.push(`block ${k + 1} (${b.file}): SEARCH text ${count === 0 ? "not found" : `matches ${count} places; add context`}` + (near >= 0 ? `. Nearest text, ${b.file}:${Math.max(1, near - 2)}-${near + 6}:\n${lines.slice(Math.max(0, near - 3), near + 6).join("\n")}` : ""));
      return;
    }
    staged.set(abs, cur.slice(0, at) + b.replace + cur.slice(at + b.search.length));
  });
  if (errors.length) return { ok: false, applied: [], errors };
  for (const [abs, body] of staged) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body, "utf8"); }
  return { ok: true, applied: [...staged.keys()].map((a) => relative(repoDir, a)), errors };
}

/** Failure digest: failing test names, assertion and error lines with a little context, and the summary tail. */
export function digest(output: string, maxChars = 1500): string {
  const lines = output.split("\n");
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (/(✖|not ok|FAIL|AssertionError|Error:|expected|actual|Expected|Received|panic:|Traceback|\+ actual|- expected|SyntaxError|TypeError|ReferenceError)/.test(l)) for (let j = i; j <= Math.min(i + 3, lines.length - 1); j++) keep.add(j);
  });
  for (let j = Math.max(0, lines.length - 6); j < lines.length; j++) keep.add(j);
  let out = "", prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) { out += (i !== prev + 1 ? "...\n" : "") + lines[i]!.slice(0, 200) + "\n"; prev = i; if (out.length > maxChars) break; }
  return out.slice(0, maxChars);
}

/** Current text around each applied block, so a repair round can lift exact SEARCH text without a read. */
export function currentRegions(repoDir: string, blocks: EditBlock[], pad = 4): string {
  const out: string[] = [];
  for (const b of blocks) {
    const abs = join(repoDir, normalize(b.file));
    if (!existsSync(abs)) continue;
    const cur = readFileSync(abs, "utf8");
    const at = cur.indexOf(b.replace.trim() ? b.replace : b.search);
    if (at < 0) continue;
    const lines = cur.split("\n"), first = cur.slice(0, at).split("\n").length - 1, n = (b.replace || b.search).split("\n").length;
    const a = Math.max(0, first - pad), e = Math.min(lines.length, first + n + pad);
    out.push(`--- ${b.file}:${a + 1}-${e}\n${lines.slice(a, e).join("\n")}`);
  }
  return out.join("\n\n");
}

export function readRanges(repoDir: string, needs: Parsed["needs"], maxChars = 8000): string {
  return needs.slice(0, 3).map((n) => {
    const abs = safePath(repoDir, n.file, new Set());
    if (!abs || !existsSync(abs)) return `--- ${n.file}: not found`;
    const lines = readFileSync(abs, "utf8").split("\n");
    const a = Math.max(1, n.start ?? 1), e = Math.min(lines.length, n.end ?? lines.length);
    return `--- ${n.file}:${a}-${e}\n${lines.slice(a - 1, e).join("\n")}`;
  }).join("\n\n").slice(0, maxChars);
}

export function runCheck(repoDir: string, cmd: string, timeoutS = 120): CheckResult {
  const r = spawnSync("bash", ["-c", cmd], { cwd: repoDir, encoding: "utf8", timeout: timeoutS * 1000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, cmd };
}

export interface DietResult { status: "green" | "red" | "conflict" | "no_edits"; rounds: number; usage: Usage; log: string[]; sessionId?: string; }

/** Drives the protocol. Returns "red" or "no_edits" when the caller should fall back to the agentic session. */
export async function runDiet(o: { repoDir: string; brief: string; checkCmd: string; call: ModelCall; maxRounds?: number; readOnly?: string[]; check?: (dir: string, cmd: string) => CheckResult }): Promise<DietResult> {
  const max = o.maxRounds ?? 3, check = o.check ?? runCheck;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, usd: 0, turns: 0 };
  const log: string[] = [];
  let msg = o.brief, sid: string | undefined, rounds = 0, needUsed = false;
  while (rounds < max) {
    rounds++;
    const r = await o.call(msg, sid);
    sid = r.sessionId ?? sid;
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += r.usage[k];
    const p = parseReply(r.text);
    if (p.conflict) { log.push(`round ${rounds}: spec conflict: ${p.conflict}`); return { status: "conflict", rounds, usage, log, ...(sid ? { sessionId: sid } : {}) }; }
    if (!p.blocks.length && p.needs.length && !needUsed) { needUsed = true; log.push(`round ${rounds}: NEED ${p.needs.map((n) => n.file).join(", ")}`); msg = `Requested code (verbatim):\n${readRanges(o.repoDir, p.needs)}\n\nNow reply with the edit blocks, then LOKI_DONE.`; continue; }
    if (!p.blocks.length) { log.push(`round ${rounds}: no edit blocks`); msg = "Your reply had no edit blocks in the required FILE/SEARCH/REPLACE form. Reply with the edit blocks now, then LOKI_DONE."; continue; }
    const a = applyBlocks(o.repoDir, p.blocks, o.readOnly);
    if (!a.ok) { log.push(`round ${rounds}: apply failed: ${a.errors.length} block(s)`); msg = `None of your edits were applied (all-or-nothing):\n${a.errors.join("\n")}\n\nReply with corrected edit blocks for all of the changes, then LOKI_DONE.`; continue; }
    const c = check(o.repoDir, o.checkCmd);
    log.push(`round ${rounds}: applied ${a.applied.join(", ")}; check ${c.ok ? "green" : "red"}`);
    if (c.ok) return { status: "green", rounds, usage, log, ...(sid ? { sessionId: sid } : {}) };
    msg = `The harness applied your edits and ran \`${c.cmd}\`: it FAILED.\nFailure digest:\n${digest(c.output)}\nCurrent text of the regions you edited:\n${currentRegions(o.repoDir, p.blocks)}\n\nReply with edit blocks against the current text (the earlier edits stay applied), then LOKI_DONE.`;
  }
  return { status: "red", rounds, usage, log, ...(sid ? { sessionId: sid } : {}) };
}

/** Real provider call through the claude CLI: no tools, lean system prompt, resumed for later rounds. */
export function claudeCall(cwd: string, model: string, opts: { tools?: string; effort?: string; system?: string; timeoutS?: number } = {}): ModelCall {
  return async (message, resumeId) => {
    const args = ["-p", "--model", model, "--output-format", "json", "--strict-mcp-config", "--setting-sources", "project", "--tools", opts.tools ?? "", "--system-prompt", opts.system ?? "You are Loki, an autonomous coding agent. Follow the task prompt exactly and report only what you did.", "--effort", opts.effort ?? "medium", "--permission-mode", "bypassPermissions", ...(resumeId ? ["--resume", resumeId] : [])];
    const r = spawnSync("claude", args, { cwd, input: message, encoding: "utf8", timeout: (opts.timeoutS ?? 300) * 1000, maxBuffer: 64 * 1024 * 1024 });
    let j: Record<string, any> = {};
    try { j = JSON.parse(r.stdout); } catch { throw new Error(`claude returned no JSON (exit ${r.status}): ${(r.stderr ?? "").slice(0, 400)}`); }
    const u = j.usage ?? {};
    return { text: String(j.result ?? ""), sessionId: j.session_id, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, usd: j.total_cost_usd ?? 0, turns: j.num_turns ?? 1 } };
  };
}
