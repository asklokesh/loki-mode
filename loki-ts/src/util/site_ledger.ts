// PROTOTYPE (proto/micro-agent-decomposition): site-ledger decomposition for small models.
// New file because no existing file owns per-site decomposition: features/decompose.ts splits a SPEC into units by write set
// (file granularity), util/conflict_resume.ts owns resume turns of the one implement session (COVERAGE_BRIEF is a model
// self-audit), and util/context_pack.ts owns which code the brief shows (this file reuses its symbolSpans).
//
// Mechanism (all deterministic except the injected `micro` call):
//   1. ledger:      the task's identifiers -> the functions it names -> every line inside them that mentions a task
//                   identifier (a "site"). Each site gets a token shape (identifiers -> I) so twins can be compared.
//   2. sibling map: inside each target function, lines that make the same call and differ only in the last argument
//                   (append(x, a) vs append(x, b)) are named to the worker, so a changed branch can match its siblings.
//   3. micro-tasks: one per target function, holding exactly that function (numbered), its sites and sibling notes,
//                   and the signatures of the other target functions. The worker returns the whole new function, a
//                   disposition per site (changed | unchanged + reason), optional imports and one test function.
//   4. coordinator: applies function replacements bottom-up per file (line numbers stay valid), adds imports.
//   5. integration: per-site closure is checked mechanically. A site claimed "changed" whose line is byte-identical in
//                   the new function, a site with no disposition, or a twin group (same shape) with mixed dispositions
//                   across ALL micro-tasks re-issues that function's micro-task once with the finding. Then the repo's
//                   own checks run. The second answer stands; anything still open is reported, never hidden.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { langOf, symbolSpans, type Lang } from "./context_pack.ts";
import { safeGit } from "./safe_git.ts";
import { isTestFile } from "./test_file_text.ts";

export interface Site { line: number; text: string; idents: string[]; shape: string }
export interface MicroTask { declared?: string[]; id: string; path: string; fn: string; start: number; end: number; lang: Lang; source: string; sites: Site[]; siblingNotes: string[] }
export interface Disposition { line: number; action: "changed" | "unchanged"; reason: string }
export interface MicroReply { fn: string | null; dispositions: Disposition[]; imports: string[]; test: string | null }
export interface Finding { task: string; line: number; kind: "no_disposition" | "claimed_change_absent" | "twin_mixed" | "parse" | "interaction_fail"; detail: string }
export type MicroCall = (brief: string, task: MicroTask) => Promise<string>;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "when", "not", "but", "from", "into", "then", "else", "return", "func", "function", "def", "var", "let", "const", "nil", "null", "true", "false", "err", "error", "string", "int", "bool", "type", "if", "ok", "self", "new", "any", "none", "None", "len", "fmt",
  "break", "continue", "case", "switch", "default", "range", "while", "elif", "pass", "raise", "throw", "try", "catch", "except", "finally", "import", "package", "export", "class", "struct", "interface", "async", "await", "yield", "lambda", "static", "public", "private", "void", "this", "super", "go", "defer", "chan", "map", "select"]);
const DECL_HEAD = /^\s*(?:export\s+)?(?:declare\s+)?(?:type|interface|class|struct|enum|const|var|let|namespace)\b/;

/** Identifiers the task names: every identifier inside backticks or fenced code, plus prose words shaped like code (CamelCase, snake_case, dotted). */
export function taskIdents(task: string): Set<string> {
  const out = new Set<string>(), add = (s: string): void => { for (const m of s.matchAll(/[A-Za-z_][\w]*/g)) if (m[0].length >= 3 && !STOP.has(m[0])) out.add(m[0]); };
  for (const m of task.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) add(m[1]!);
  for (const m of task.replace(/```[\s\S]*?```/g, " ").matchAll(/`([^`\n]+)`/g)) add(m[1]!);
  for (const m of task.matchAll(/\b(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z]+_[a-z_0-9]+)\b/g)) if (!STOP.has(m[0])) out.add(m[0]);
  return out;
}

/** Token shape: identifiers -> I, numbers -> N, strings -> S, whitespace dropped. Twins share a shape. */
export function shapeOf(line: string): string {
  return line.replace(/\/\/.*$|#.*$/, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, "S").replace(/[A-Za-z_]\w*/g, (w) => (/^(if|for|return|else|switch|case|range|func|def|while|not|and|or|in|is)$/.test(w) ? w : "I")).replace(/\b\d+\b/g, "N").replace(/\s+/g, "");
}

const isComment = (s: string): boolean => /^\s*(\/\/|#|\*|\/\*)/.test(s);

/** Sibling map: calls inside the function that differ only in their last argument. */
export function siblingNotes(lines: string[], start: number): string[] {
  const groups = new Map<string, { line: number; arg: string }[]>();
  lines.forEach((raw, k) => {
    if (isComment(raw)) return;
    const m = /^(.*\b[\w.]+\()(.*?)(\)\s*[;{]?\s*)$/.exec(raw.trim());
    if (!m) return;
    const args = m[2]!, cut = args.lastIndexOf(",");
    const key = m[1]! + (cut >= 0 ? args.slice(0, cut + 1) : "") + "·" + m[3]!.trim();
    const arg = (cut >= 0 ? args.slice(cut + 1) : args).trim();
    if (!arg) return;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ line: start + k, arg });
  });
  const notes: string[] = [];
  for (const [key, uses] of groups) {
    const args = [...new Set(uses.map((u) => u.arg))];
    if (uses.length < 2 || args.length < 2) continue;
    notes.push(`Sibling calls \`${key.replace("·", "<arg>")}\` pass different values: ${uses.map((u) => `line ${u.line} passes \`${u.arg}\``).join("; ")}. If you change one of these branches, pass what its siblings pass unless the task says the value must differ.`);
  }
  return notes;
}

/** The ledger: one micro-task per function the task names, holding every line that mentions a task identifier. */
export function buildLedger(repoDir: string, task: string, maxTasks = 6): MicroTask[] {
  const idents = taskIdents(task);
  if (!idents.size) return [];
  const words = [...idents];
  let listed = "";
  try { listed = safeGit(repoDir, ["grep", "-l", "-w", ...words.flatMap((w) => ["-e", w])]); } catch { listed = ""; } // exit 1 = no match
  const files = listed.split("\n").filter((p) => p && langOf(p) && !isTestFile(p));
  const out: MicroTask[] = [];
  for (const path of files.sort()) {
    const src = readFileSync(join(repoDir, path), "utf8"), all = src.split("\n"), lang = langOf(path)!;
    const declared = new Set(symbolSpans(path, src).map((x) => x.name.split(".").pop()!).filter((n) => idents.has(n)));
    for (const sp of symbolSpans(path, src)) {
      if (sp.container) continue;
      const short = sp.name.split(".").pop()!;
      if (!idents.has(short) || DECL_HEAD.test(all[sp.start - 1] ?? "")) continue; // functions only: a named type is context, not a worker
      const body = all.slice(sp.start - 1, sp.end), sites: Site[] = [];
      body.forEach((t, k) => {
        if (k === 0 || isComment(t)) return;
        const hit = [...new Set((t.match(/[A-Za-z_]\w*/g) ?? []).filter((w) => idents.has(w)))];
        if (hit.length) sites.push({ line: sp.start + k, text: t, idents: hit, shape: shapeOf(t) });
      });
      if (!sites.length) continue; // a named type, constructor or example with no site gets no worker
      out.push({ declared: [...declared], id: `${path}#${sp.name}`, path, fn: sp.name, start: sp.start, end: sp.end, lang, source: body.join("\n"), sites, siblingNotes: siblingNotes(body, sp.start) });
    }
  }
  return out.slice(0, maxTasks);
}

/** Twin groups: sites in different places that share a token shape, across every micro-task. */
export function twinGroups(tasks: MicroTask[]): { shape: string; members: { task: string; line: number }[] }[] {
  const g = new Map<string, { task: string; line: number }[]>();
  // A twin must name a type or function the repo declares and the task names (StatusCoder, not a local like firstArg or a bare `break`).
  for (const t of tasks) for (const s of t.sites) if (s.idents.some((w) => t.declared?.includes(w) && w !== t.fn.split(".").pop())) (g.get(s.shape) ?? g.set(s.shape, []).get(s.shape)!).push({ task: t.id, line: s.line });
  return [...g].filter(([, m]) => m.length >= 2).map(([shape, members]) => ({ shape, members }));
}

export function microBrief(task: string, t: MicroTask, others: MicroTask[], twins: ReturnType<typeof twinGroups>, findings: Finding[] = []): string {
  const numbered = t.source.split("\n").map((l, k) => `${String(t.start + k).padStart(5)}| ${l}`).join("\n");
  const myTwins = twins.filter((g) => g.members.some((m) => m.task === t.id)).map((g) => `- ${g.members.map((m) => (m.task === t.id ? `line ${m.line}` : `${m.task} line ${m.line}`)).join(", ")} have the same code shape; treat them alike unless the task says otherwise.`);
  return [
    "You are one worker in a team. You change exactly ONE function. Other workers own the other functions listed below.",
    `Task (the whole issue; the code quoted in it is a hint, the function below is the truth):\n${task.trim()}`,
    `Your function: ${t.fn} in ${t.path}, lines ${t.start}-${t.end}:\n${numbered}`,
    `Sites you must decide, one by one (every line of your function that mentions a name from the task):\n${t.sites.map((s) => `- line ${s.line}: ${s.text.trim()}`).join("\n") || "- none"}`,
    ...(t.siblingNotes.length ? [`Sibling branches:\n${t.siblingNotes.map((n) => "- " + n).join("\n")}`] : []),
    ...(myTwins.length ? [`Same-shape sites (here and in other workers' functions):\n${myTwins.join("\n")}`] : []),
    ...(others.length ? [`Other functions (read-only, owned by other workers): ${others.map((o) => `${o.fn} (${o.path})`).join(", ")}`] : []),
    ...(findings.length ? [`An integration check rejected your previous answer:\n${findings.map((f) => `- line ${f.line}: ${f.detail}`).join("\n")}\nFix these. If a site truly must stay as it is, say why.`] : []),
    [
      "Reply in exactly this format and nothing else:",
      "```" + t.lang,
      "<the complete new function, from its first line to its closing line; you may add a new helper function after it>",
      "```",
      "SITE <line>: changed - <why>   or   SITE <line>: unchanged - <why>   (one line per site above)",
      "IMPORT <import path>   (only if your new code needs an import the file lacks; else omit)",
      "```test",
      "<one new test function for the bug, in the repo's test style, using only exported or same-package names>",
      "```",
    ].join("\n"),
  ].join("\n\n");
}

export function parseReply(text: string, lang: Lang): MicroReply {
  const fence = (tag: string): string | null => { const m = new RegExp("```" + tag + "[^\\n]*\\n([\\s\\S]*?)```").exec(text); return m ? m[1]!.replace(/\n$/, "") : null; };
  const fn = fence(lang === "ts" ? "(?:ts|typescript|js)" : lang === "py" ? "(?:py|python)" : lang);
  const dispositions: Disposition[] = [];
  for (const m of text.matchAll(/^SITE\s+(\d+)\s*:\s*(changed|unchanged)\s*[-:]?\s*(.*)$/gim)) dispositions.push({ line: Number(m[1]), action: m[2]!.toLowerCase() as Disposition["action"], reason: m[3]!.trim() });
  const imports = [...text.matchAll(/^IMPORT\s+"?([^"\s]+)"?\s*$/gm)].map((m) => m[1]!);
  return { fn, dispositions, imports, test: fence("test") };
}

/** Mechanical per-site closure over every reply. */
export function integrationFindings(tasks: MicroTask[], replies: Map<string, MicroReply>): Finding[] {
  const out: Finding[] = [];
  const disp = new Map<string, Disposition>();
  for (const t of tasks) {
    const r = replies.get(t.id);
    if (!r?.fn) { out.push({ task: t.id, line: t.start, kind: "parse", detail: "no complete function in the reply" }); continue; }
    const newLines = new Set(r.fn.split("\n").map((l) => l.trim()));
    for (const s of t.sites) {
      const d = r.dispositions.find((x) => x.line === s.line);
      if (!d) { out.push({ task: t.id, line: s.line, kind: "no_disposition", detail: `no SITE decision for \`${s.text.trim()}\`` }); continue; }
      disp.set(`${t.id}:${s.line}`, d);
      if (d.action === "changed" && newLines.has(s.text.trim())) out.push({ task: t.id, line: s.line, kind: "claimed_change_absent", detail: `you said changed, but \`${s.text.trim()}\` is still in your function unchanged` });
    }
  }
  for (const g of twinGroups(tasks)) {
    const ds = g.members.map((m) => ({ m, d: disp.get(`${m.task}:${m.line}`) }));
    const changed = ds.filter((x) => x.d?.action === "changed"), kept = ds.filter((x) => x.d?.action === "unchanged");
    if (!changed.length || !kept.length) continue;
    for (const k of kept) out.push({ task: k.m.task, line: k.m.line, kind: "twin_mixed", detail: `same code shape as ${changed.map((c) => `${c.m.task} line ${c.m.line}`).join(", ")}, which was changed (${changed[0]!.d!.reason}); this one was left as is (${k.d!.reason}). Change it the same way, or give the reason it must differ.` });
  }
  return out;
}

function addImports(src: string, lang: Lang, imports: string[]): string {
  let s = src;
  for (const imp of imports) {
    if (lang === "go") {
      if (new RegExp(`"${imp.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`).test(s)) continue;
      s = /^import \(\n/m.test(s) ? s.replace(/^import \(\n/m, `import (\n\t"${imp}"\n`) : s.replace(/^(package \w+\n)/m, `$1\nimport "${imp}"\n`);
    } else if (lang === "py") { if (!new RegExp(`^import ${imp}\\b`, "m").test(s)) s = `import ${imp}\n` + s; }
  }
  return s;
}

// Go stdlib packages a worker's new code commonly reaches for; a used-but-unimported one is added (no goimports dependency).
const GO_STD = ["errors", "fmt", "strings", "bytes", "reflect", "strconv", "io", "os", "sort", "slices", "testing"];
function goStdImports(src: string): string[] {
  const body = src.replace(/^import\s*\([\s\S]*?\)|^import\s+"[^"]*"/gm, "");
  return GO_STD.filter((p) => new RegExp(`\\b${p}\\.[A-Z]`).test(body));
}

/** Coordinator apply: replacements bottom-up per file, imports, one test per task appended to the sibling test file (Go `_test.go`). */
export function applyReplies(repoDir: string, tasks: MicroTask[], replies: Map<string, MicroReply>): string[] {
  const byFile = new Map<string, MicroTask[]>();
  for (const t of tasks) (byFile.get(t.path) ?? byFile.set(t.path, []).get(t.path)!).push(t);
  const touched: string[] = [];
  for (const [path, ts] of byFile) {
    const abs = join(repoDir, path);
    let lines = readFileSync(abs, "utf8").split("\n");
    const imports: string[] = [];
    for (const t of [...ts].sort((a, b) => b.start - a.start)) {
      const r = replies.get(t.id);
      if (!r?.fn) continue;
      lines = [...lines.slice(0, t.start - 1), ...r.fn.split("\n"), ...lines.slice(t.end)];
      imports.push(...r.imports);
    }
    const joined = lines.join("\n");
    writeFileSync(abs, addImports(joined, ts[0]!.lang, ts[0]!.lang === "go" ? [...imports, ...goStdImports(joined)] : imports)); touched.push(path);
    const tests = ts.map((t) => replies.get(t.id)?.test).filter((x): x is string => !!x);
    if (tests.length && ts[0]!.lang === "go") {
      const tp = abs.replace(/\.go$/, "_test.go");
      const head = existsSync(tp) ? readFileSync(tp, "utf8") : `package ${/^package (\w+)/m.exec(lines.join("\n"))?.[1] ?? "main"}\n\nimport "testing"\n`;
      const merged = head.replace(/\n*$/, "\n\n") + tests.join("\n\n") + "\n";
      writeFileSync(tp, addImports(merged, "go", goStdImports(merged))); touched.push(tp.slice(repoDir.length + 1));
    }
  }
  return touched;
}

/** Same-function twin pairs: two sites of one shape inside ONE function, whose order and overlap a per-site test never exercises. */
export function interactionPairs(tasks: MicroTask[]): { task: MicroTask; a: Site; b: Site }[] {
  const out: { task: MicroTask; a: Site; b: Site }[] = [];
  for (const g of twinGroups(tasks)) {
    const byTask = new Map<string, number[]>();
    for (const m of g.members) (byTask.get(m.task) ?? byTask.set(m.task, []).get(m.task)!).push(m.line);
    for (const [id, ls] of byTask) { const t = tasks.find((x) => x.id === id)!; for (let i = 1; i < ls.length; i++) out.push({ task: t, a: t.sites.find((s) => s.line === ls[0])!, b: t.sites.find((s) => s.line === ls[i])! }); }
  }
  return out;
}

/** One test-writer micro-task per same-function twin pair: a single input that reaches BOTH sites, so order and overlap are tested. */
export function interactionBrief(task: string, p: { task: MicroTask; a: Site; b: Site }, newFn: string): string {
  return [
    "You write ONE test. Another worker already changed the function below. Per-site tests already exist; yours must cover the case where ONE input could match BOTH of these two sites, so the order of the checks and their overlap decide the result.",
    `Task:\n${task.trim()}`,
    `Changed function ${p.task.fn} in ${p.task.path}:\n${newFn}`,
    `The two sites (original lines): \`${p.a.text.trim()}\` and \`${p.b.text.trim()}\`.`,
    "Build an input that satisfies both (for example a value of the second kind that also contains or wraps a value of the first kind, or the reverse) and assert the behavior the TASK asks for, including any output, not what the code does now.",
    "Reply with exactly one ```test fence holding one test function in the repo's test style, using only same-package names.",
  ].join("\n\n");
}

export interface LedgerOpts { maxRetries?: number; check?: () => { ok: boolean; out: string } }
export interface LedgerRun { tasks: MicroTask[]; rounds: number; calls: number; findings: Finding[]; residual: Finding[]; touched: string[]; interaction?: { pairs: number; first_ok: boolean | null; final_ok: boolean | null } }

/** The deterministic coordinator: ledger -> micro-tasks -> integration check -> at most one re-issue per flagged task. */
export async function runLedger(repoDir: string, task: string, micro: MicroCall, maxRetriesOrOpts: number | LedgerOpts = 1): Promise<LedgerRun> {
  const opts: LedgerOpts = typeof maxRetriesOrOpts === "number" ? { maxRetries: maxRetriesOrOpts } : maxRetriesOrOpts, maxRetries = opts.maxRetries ?? 1;
  const tasks = buildLedger(repoDir, task), twins = twinGroups(tasks), replies = new Map<string, MicroReply>();
  let calls = 0;
  const ask = async (t: MicroTask, f: Finding[] = []): Promise<void> => { calls++; replies.set(t.id, parseReply(await micro(microBrief(task, t, tasks.filter((o) => o !== t), twins, f), t), t.lang)); };
  await Promise.all(tasks.map((t) => ask(t)));
  const first = integrationFindings(tasks, replies);
  let residual = first, rounds = 1;
  for (let i = 0; i < maxRetries && residual.length; i++) {
    const flagged = tasks.filter((t) => residual.some((f) => f.task === t.id));
    await Promise.all(flagged.map((t) => ask(t, residual.filter((f) => f.task === t.id))));
    rounds++;
    residual = integrationFindings(tasks, replies); // the second answer stands; what is still open is reported, never dropped
  }
  const base = new Map(tasks.map((t) => [t.path, readFileSync(join(repoDir, t.path), "utf8")]));
  const testPath = (t: MicroTask): string => join(repoDir, t.path.replace(/\.go$/, "_test.go"));
  const baseTests = new Map(tasks.map((t) => [testPath(t), existsSync(testPath(t)) ? readFileSync(testPath(t), "utf8") : null]));
  let touched = tasks.length ? applyReplies(repoDir, tasks, replies) : [];
  // Integration step 2 (opt-in, needs the repo's own check): pairwise interaction tests for same-function twins.
  const pairs = opts.check && maxRetries > 0 ? interactionPairs(tasks).filter((p) => replies.get(p.task.id)?.fn) : [];
  let interaction: LedgerRun["interaction"];
  if (pairs.length && opts.check) {
    const pairTests: { t: MicroTask; test: string }[] = [];
    for (const p of pairs) {
      calls++;
      const test = parseReply(await micro(interactionBrief(task, p, replies.get(p.task.id)!.fn!), { ...p.task, id: p.task.id + "#pair" }), p.task.lang).test;
      if (test) pairTests.push({ t: p.task, test });
    }
    const appendPairTests = (): void => { for (const { t, test } of pairTests) { const tp = testPath(t); const cur = existsSync(tp) ? readFileSync(tp, "utf8") : `package ${/^package (\w+)/m.exec(base.get(t.path)!)?.[1] ?? "main"}\n`; const merged = cur.replace(/\n*$/, "\n\n") + test + "\n"; writeFileSync(tp, addImports(merged, "go", goStdImports(merged))); } };
    appendPairTests();
    const c1 = opts.check();
    interaction = { pairs: pairs.length, first_ok: c1.ok, final_ok: c1.ok };
    if (!c1.ok) {
      const owners = [...new Set(pairs.map((p) => p.task))];
      for (const t of owners) residual.push({ task: t.id, line: t.start, kind: "interaction_fail", detail: `a test where one input reaches two same-shape sites fails on your function:\n${c1.out.slice(-1200)}\nReorder or narrow the checks so the task's behavior holds for that input; keep every site's own fix.` });
      await Promise.all(owners.map((t) => ask(t, residual.filter((f) => f.task === t.id))));
      rounds++;
      for (const [p, src] of base) writeFileSync(join(repoDir, p), src);
      for (const [p, src] of baseTests) if (src !== null) writeFileSync(p, src);
      touched = applyReplies(repoDir, tasks, replies); appendPairTests();
      const c2 = opts.check(); interaction.final_ok = c2.ok;
      residual = [...integrationFindings(tasks, replies), ...(c2.ok ? [] : owners.map((t) => ({ task: t.id, line: t.start, kind: "interaction_fail" as const, detail: c2.out.slice(-400) })))];
    }
  }
  return { tasks, rounds, calls, findings: first, residual, touched, ...(interaction ? { interaction } : {}) };
}
