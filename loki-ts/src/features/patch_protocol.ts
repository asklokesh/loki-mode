// LOKI_E10_PATCH (default off): the implement stage's patch protocol on the lean path. One tool-less model call gets a
// precomputed dossier (the context pack's code, the impacted tests' conventions and the check command) and answers with
// FILE/SEARCH/REPLACE edit blocks. The harness refuses config, lockfile and Wall edits before anything touches the tree,
// applies the rest all-or-nothing, runs the targeted check itself and allows at most one compact repair call. Anything
// short of a green check restores every file it wrote, and the caller runs today's agentic session: the outcome floor is unchanged.
// New file because no module owns model-written edit blocks; implement.ts only wires it (see the stage).
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative, sep } from "node:path";
import { LOCK_RULES } from "../util/lock_ecosystems.ts";
import { WALL_FILE, taskWantsLockChange } from "../e10ext/commit_filter.ts";
import { steersRunner } from "./runner_config.ts";
import { isTestFile } from "../util/test_file_text.ts";
import { toolLessCall } from "../runner/sdk_invoker.ts";
import { run } from "../util/shell.ts";
import { withChildLedger } from "../util/child_ledger.ts";

/** Default on; LOKI_E10_PATCH=0 (or off, false, no) turns it off. Every non-green end falls back to the agentic session, so the outcome floor is today's. */
export const patchEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !["0", "off", "false", "no"].includes((env.LOKI_E10_PATCH ?? "").trim().toLowerCase());

export interface EditBlock { file: string; search: string; replace: string }
export interface ParsedReply { blocks: EditBlock[]; needs: { file: string; start?: number; end?: number }[]; conflict: string | null; alreadyDone: string | null }
export interface PatchMessage { role: "user" | "assistant"; content: string }
/** One tool-less model call. text null means the call failed (transport, refusal, truncation): the protocol falls back, never guesses. */
export interface PatchCallResult { text: string | null; usd?: number | null }
export type PatchCall = (req: { system: string; messages: PatchMessage[]; iterationId: string; signal: AbortSignal }) => Promise<PatchCallResult>;
/** The harness-run targeted check over the current tree. ran counts checks that executed; ok is true only when ran > 0 and every one passed. */
export interface PatchCheck { ok: boolean; ran: number; digest: string; names: string[] }

export const PATCH_SYSTEM = "You are Loki, an autonomous coding agent. You have no tools. Follow the task prompt exactly.";
// Fixed bytes: the per-task text follows them, so every patch brief shares one cache-stable prefix.
export const PATCH_RULES = [
  "You are the Loki 10 implement stage in patch mode. You have no tools: the harness applies your edits, runs the check named below and shows you any failure.",
  "Rules: never edit or delete an existing assertion; add a regression test in the test file the dossier names, following its conventions; write no documentation; never edit lockfiles, test-runner or compiler configs, or the read-only Wall tests (such edits are refused and nothing is applied).",
  "Reply with at most 5 lines naming the root cause and the change, then every edit block in exactly this form:",
  "FILE: <repo-relative path>\n<<<<<<< SEARCH\n<lines copied exactly from the dossier, enough to match one place>\n=======\n<replacement lines>\n>>>>>>> REPLACE",
  "An empty SEARCH section creates a new file, or appends to the end of an existing one. Read the whole function before you change it and keep its sibling branches consistent.",
  "Only if you cannot write a correct edit without more code, reply instead with up to 3 lines `NEED: <path>` or `NEED: <path>:<start>-<end>` and nothing else.",
  "Finish with exactly one line: LOKI_DONE, or LOKI_SPEC_CONFLICT: <reason>.",
].join("\n");

/** The patch brief: fixed rules, the quoted task, then the dossier (code, test conventions, the check the harness runs). */
export function buildPatchBrief(task: string, code: string, conventions: string, checkCmds: string[]): string {
  return [PATCH_RULES, `Task (untrusted, quoted verbatim):\n<<<TASK\n${task.trim()}\nTASK`, code, conventions,
    checkCmds.length ? `Check the harness runs after your edits:\n${checkCmds.join("\n")}` : "Check: the harness runs the tests of the files you change."].filter(Boolean).join("\n\n");
}

const CONVENTION_HEAD_LINES = 30, CONVENTION_MAX_FILES = 3, CONVENTION_MAX_CHARS = 6000;
const TEST_NAME = /^\s*(?:test|it|describe)(?:\.\w+)?\(|^\s*def test_|^func Test|^\s*#\[test\]/;
/** Each impacted test file's head and its test names: the convention to copy, and the text an append or a SEARCH anchors on. */
export function testConventions(repoDir: string, testPaths: string[]): string {
  const out: string[] = [];
  for (const rel of testPaths.slice(0, CONVENTION_MAX_FILES)) {
    let lines: string[];
    try { lines = readFileSync(join(repoDir, rel), "utf8").split("\n"); } catch { continue; }
    const names = lines.filter((l) => TEST_NAME.test(l)).map((l) => l.trim().slice(0, 100));
    out.push(`--- ${rel}:1-${Math.min(lines.length, CONVENTION_HEAD_LINES)} (test convention; ${lines.length} lines, ${names.length} tests)\n${lines.slice(0, CONVENTION_HEAD_LINES).join("\n")}${names.length ? `\n... test names: ${names.join(" | ")}` : ""}`);
  }
  const text = out.join("\n\n");
  return text ? `Tests to extend (heads verbatim):\n${text.slice(0, CONVENTION_MAX_CHARS)}` : "";
}

export function parseReply(text: string): ParsedReply {
  const blocks: EditBlock[] = [];
  const re = /^FILE:\s*`?([^\s`]+)`?\s*\n(?:```[^\n]*\n)?<{7} SEARCH\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} REPLACE/gm;
  for (const m of text.matchAll(re)) blocks.push({ file: m[1]!, search: m[2]!, replace: m[3]! });
  const needs = [...text.matchAll(/^NEED:\s*`?([^\s`:]+)`?(?::(\d+)-(\d+))?\s*$/gm)].map((m) => ({ file: m[1]!, ...(m[2] ? { start: Number(m[2]), end: Number(m[3]) } : {}) }));
  const conflict = /^\W*LOKI_SPEC_CONFLICT:\s*(.+)$/m.exec(text), already = /^\W*LOKI_ALREADY_DONE:\s*(.+)$/m.exec(text);
  return { blocks, needs, conflict: conflict ? conflict[1]!.trim() : null, alreadyDone: already ? already[1]!.trim() : null };
}

const LOCKFILES = new Set(LOCK_RULES.flatMap((r) => r.locks).concat(["go.sum"]));
export interface ApplyRules { repoDir: string; readOnly: string[]; task: string }
/** Why an edit to `rel` is refused before it is applied, or null. before/after are the file's text without and with the edit (null: absent). */
export function refusal(rules: ApplyRules, rel: string, before: string | null, after: string): string | null {
  const n = normalize(rel);
  if (n.startsWith("..") || n.startsWith(sep) || /^[A-Za-z]:/.test(n) || !contained(rules.repoDir, n)) return "outside the repository";
  if (/(^|\/)\.(git|loki)(\/|$)/.test(n)) return "inside .git or .loki";
  if (WALL_FILE.test(n) || rules.readOnly.includes(n)) return "a read-only Wall test";
  if (LOCKFILES.has(basename(n)) && !taskWantsLockChange(rules.task, n)) return "a lockfile the task does not ask to change";
  if (steersRunner(n, before ?? "", after)) return "a test-runner or compiler config (it steers how tests run)";
  return null;
}

/** Realpath containment: the target, or for a file still to be created its deepest existing ancestor, must resolve to exactly its own path under the repo's realpath. Any symlink on the way (pointing out of the repo or back into it) is refused, so a write lands only where its path says. */
export function contained(repoDir: string, rel: string): boolean {
  try {
    const root = realpathSync(repoDir);
    let p = join(root, rel);
    for (;;) {
      let exists = false;
      try { lstatSync(p); exists = true; } catch { /* not there yet */ }
      if (exists) { const r = realpathSync(p); return r === p && (r === root || r.startsWith(root + sep)); }
      const up = dirname(p);
      if (up === p) return false;
      p = up;
    }
  } catch { return false; } // unreadable or a dangling link: fail closed
}

export interface ApplyResult { ok: boolean; applied: string[]; errors: string[]; refused: string[]; noop: string[] }
/** Originals of every file the protocol wrote (null: it did not exist), so a fallback restores the tree byte-identical. */
export type Originals = Map<string, string | null>;

/** All-or-nothing apply. SEARCH must match exactly once (never fuzzy). A refused path, a miss, an ambiguous match or an edit that changes nothing applies nothing. */
export function applyBlocks(rules: ApplyRules, blocks: EditBlock[], originals: Originals): ApplyResult {
  const staged = new Map<string, string>(), before = new Map<string, string | null>();
  const errors: string[] = [], refused: string[] = [], noop: string[] = [];
  const read = (rel: string): string | null => { const abs = join(rules.repoDir, rel); return existsSync(abs) ? readFileSync(abs, "utf8") : null; };
  blocks.forEach((b, k) => {
    const rel = normalize(b.file).replace(/^\.\//, "");
    if (!before.has(rel)) before.set(rel, rel.startsWith("..") || rel.startsWith(sep) ? null : read(rel));
    const cur = staged.get(rel) ?? before.get(rel) ?? null;
    let next: string;
    if (b.search.trim() === "") next = cur === null ? b.replace : cur.replace(/\n?$/, "\n") + b.replace;
    else if (cur === null) { errors.push(`block ${k + 1} (${b.file}): the file does not exist`); return; }
    else {
      const count = cur.split(b.search).length - 1;
      if (count !== 1) {
        const lines = cur.split("\n"), trimmed = lines.map((l) => l.trim()), probe = b.search.split("\n").map((l) => l.trim()).find((l) => l.length > 3 && trimmed.includes(l)), near = probe === undefined ? -1 : trimmed.indexOf(probe); // the first SEARCH line that exists verbatim anchors the hint
        errors.push(`block ${k + 1} (${b.file}): SEARCH text ${count === 0 ? "not found" : `matches ${count} places; add context`}` + (near >= 0 ? `. Nearest text, ${b.file}:${Math.max(1, near - 2)}-${near + 6}:\n${lines.slice(Math.max(0, near - 3), near + 6).join("\n")}` : ""));
        return;
      }
      const at = cur.indexOf(b.search);
      next = cur.slice(0, at) + b.replace + cur.slice(at + b.search.length);
    }
    if (next === cur) { noop.push(`block ${k + 1} (${b.file}): the edit leaves the file byte-identical (claimed change absent)`); return; }
    staged.set(rel, next);
  });
  for (const [rel, body] of staged) { const why = refusal(rules, rel, before.get(rel) ?? null, body); if (why) refused.push(`${rel}: refused, ${why}`); }
  if (errors.length || refused.length || noop.length) return { ok: false, applied: [], errors, refused, noop };
  for (const rel of staged.keys()) if (!originals.has(rel)) originals.set(rel, before.get(rel) ?? null); // every original is recorded before the first write, so any later throw can be undone
  const written: string[] = [];
  try {
    for (const [rel, body] of staged) { const abs = join(rules.repoDir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body, "utf8"); written.push(rel); }
  } catch (e) { // a mid-write failure (EEXIST on a file used as a directory, EACCES): nothing of this reply stays
    for (const rel of [...staged.keys()]) { const b = before.get(rel) ?? null, abs = join(rules.repoDir, rel); try { if (b === null) { if (written.includes(rel)) rmSync(abs, { force: true }); } else writeFileSync(abs, b, "utf8"); } catch { /* the caller's restore retries */ } }
    return { ok: false, applied: [], errors: [`the edits could not be written: ${(e as Error).message.split("\n")[0]}`], refused, noop };
  }
  return { ok: true, applied: [...staged.keys()], errors, refused, noop };
}

/** Puts every file the protocol wrote back as it was (a file it created is removed). Returns the paths restored. */
export function restoreOriginals(repoDir: string, originals: Originals): string[] {
  const out: string[] = [];
  for (const [rel, body] of originals) {
    const abs = join(repoDir, rel);
    try { if (body === null) rmSync(abs, { force: true }); else writeFileSync(abs, body, "utf8"); out.push(rel); } catch { /* best effort; verify judges the tree it finds */ }
  }
  originals.clear();
  return out;
}

/** The current text around each applied block, so a repair reply can lift exact SEARCH text without a read. */
export function currentRegions(repoDir: string, blocks: EditBlock[], pad = 4, maxChars = 6000): string {
  const out: string[] = [];
  for (const b of blocks) {
    const abs = join(repoDir, normalize(b.file));
    if (!existsSync(abs)) continue;
    const cur = readFileSync(abs, "utf8"), probe = b.replace.trim() ? b.replace : b.search, at = probe ? cur.indexOf(probe) : -1;
    if (at < 0) continue;
    const lines = cur.split("\n"), first = cur.slice(0, at).split("\n").length - 1, n = probe.split("\n").length;
    const a = Math.max(0, first - pad), e = Math.min(lines.length, first + n + pad);
    out.push(`--- ${b.file}:${a + 1}-${e}\n${lines.slice(a, e).join("\n")}`);
  }
  return out.join("\n\n").slice(0, maxChars);
}

function readRanges(rules: ApplyRules, needs: ParsedReply["needs"], maxChars = 8000): string {
  return needs.slice(0, 3).map((n) => {
    const rel = normalize(n.file);
    if (refusal({ ...rules, readOnly: [] }, rel, null, "") === "outside the repository" || !existsSync(join(rules.repoDir, rel))) return `--- ${n.file}: not found`;
    const lines = readFileSync(join(rules.repoDir, rel), "utf8").split("\n");
    const a = Math.max(1, n.start ?? 1), e = Math.min(lines.length, n.end ?? lines.length);
    return `--- ${rel}:${a}-${e}\n${lines.slice(a - 1, e).join("\n")}`;
  }).join("\n\n").slice(0, maxChars);
}

export const DIGEST_MAX_CHARS = 1500;
/** The receipt's patch line: whether the patch protocol finished the implement stage (green), handed it to the agentic session (fallback) or threw (error), with its own seconds and dollars. Lets a scored run measure the fallback rate. */
export interface PatchReceipt { outcome: "green" | "fallback" | "error"; status: string; calls: number; seconds: number | null; usd: number | null }
export function patchReceipt(p: unknown): PatchReceipt | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>, status = typeof r["status"] === "string" ? r["status"] : "";
  if (!status) return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { outcome: status === "green" ? "green" : status === "error" ? "error" : "fallback", status, calls: num(r["calls"]) ?? 0, seconds: num(r["seconds"]), usd: num(r["usd"]) };
}
export type PatchStatus = "green" | "red" | "no_edits" | "rejected" | "conflict" | "already_done" | "call_failed" | "aborted" | "error";
export interface PatchOutcome { status: PatchStatus; calls: number; applied: string[]; refused: string[]; restored: string[]; log: string[]; usd: number | null; check?: string[] }
export interface PatchDeps {
  rules: ApplyRules; brief: string; iterationId: string; signal: AbortSignal;
  call: PatchCall; check: (applied: string[]) => Promise<PatchCheck>;
  record?: (call: number, prompt: string, reply: string | null) => void; // the run dir keeps each call's prompt and reply (debugging, the receipt's evidence)
}

/**
 * At most two calls: the patch, then one repair (a NEED answer, a rejected or missed edit, a claimed change that is
 * absent, or a red check). Green only when the harness-run check ran and passed; any other end restores the tree.
 */
export async function runPatchProtocol(d: PatchDeps): Promise<PatchOutcome> {
  const originals: Originals = new Map(), log: string[] = [], messages: PatchMessage[] = [{ role: "user", content: d.brief }];
  const applied = new Set<string>(), refusedAll: string[] = [];
  let usd: number | null = 0, calls = 0, lastCheck: string[] | undefined, greenSnap: Originals | null = null, greenApplied = new Set<string>(); // greenSnap: the green tree's text of each file, kept while the test-only repair runs
  const end = (status: PatchStatus): PatchOutcome => {
    const restored = status === "green" ? [] : restoreOriginals(d.rules.repoDir, originals);
    return { status, calls, applied: status === "green" ? [...applied] : [], refused: refusedAll, restored, log, usd, ...(lastCheck ? { check: lastCheck } : {}) };
  };
  try { return await rounds(); } catch (e) { log.push(`error: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}`); return end("error"); } // the floor: any throw restores every written file and the caller runs the agentic session
  async function rounds(): Promise<PatchOutcome> {
  for (let round = 1; round <= 2; round++) {
    if (d.signal.aborted) return end("aborted");
    calls++;
    const r = await d.call({ system: PATCH_SYSTEM, messages, iterationId: round === 1 ? d.iterationId : `${d.iterationId}-r`, signal: d.signal });
    try { d.record?.(round, flattenMessages(messages), r.text); } catch { /* best effort */ }
    usd = usd === null || r.usd === undefined || r.usd === null ? null : usd + r.usd;
    if (r.text === null) { log.push(`call ${round}: failed`); return end("call_failed"); }
    messages.push({ role: "assistant", content: r.text });
    const p = parseReply(r.text);
    const repair = (why: string, body: string): void => { log.push(`call ${round}: ${why}`); messages.push({ role: "user", content: body }); };
    const keepGreen = (why: string): PatchOutcome => { log.push(`call ${round}: ${why}; kept the green tree without a new test`); for (const [rel, body] of greenSnap!) { if (body === null) rmSync(join(d.rules.repoDir, rel), { force: true }); else writeFileSync(join(d.rules.repoDir, rel), body, "utf8"); if (!greenApplied.has(rel)) { applied.delete(rel); if (originals.get(rel) === body) originals.delete(rel); } } return end("green"); };
    if (greenSnap && !p.blocks.length) return keepGreen("no test edit");
    if (!p.blocks.length) {
      if (p.conflict) { log.push(`call ${round}: spec conflict: ${p.conflict.slice(0, 200)}`); return end("conflict"); } // the agentic session owns conflict handling (correction, Wall referee)
      if (p.alreadyDone) { log.push(`call ${round}: already done`); return end("already_done"); } // the agentic session owns the already-done challenge
      if (p.needs.length) { repair(`NEED ${p.needs.map((n) => n.file).join(", ")}`, `Requested code (verbatim):\n${readRanges(d.rules, p.needs)}\n\nNow reply with every edit block, then LOKI_DONE.`); continue; }
      repair("no edit blocks", "Your reply had no edit blocks in the FILE/SEARCH/REPLACE form. Reply with every edit block now, then LOKI_DONE."); continue;
    }
    if (greenSnap) for (const b of p.blocks) { const rel = normalize(b.file).replace(/^\.\//, ""); if (!greenSnap.has(rel)) greenSnap.set(rel, existsSync(join(d.rules.repoDir, rel)) && !rel.startsWith("..") ? readFileSync(join(d.rules.repoDir, rel), "utf8") : null); }
    const a = applyBlocks(d.rules, p.blocks, originals);
    refusedAll.push(...a.refused);
    if (greenSnap && !a.ok) return keepGreen("test edit rejected");
    if (!a.ok) { repair(`rejected: ${[...a.refused, ...a.errors, ...a.noop].length} problem(s)`, `None of your edits were applied (all-or-nothing):\n${[...a.refused, ...a.errors, ...a.noop].join("\n")}\n\nReply with corrected edit blocks for all of the changes (leave out refused files), then LOKI_DONE.`); continue; }
    for (const f of a.applied) applied.add(f);
    const c = await d.check([...applied]);
    lastCheck = c.names;
    log.push(`call ${round}: applied ${a.applied.join(", ")}; check ${c.ok ? "green" : c.ran ? "red" : "did not run"}`);
    if (c.ok && (greenSnap || appliedTests([...applied]).length || round === 2)) return end("green");
    if (c.ok) { greenSnap = new Map(); greenApplied = new Set(applied); repair("green without a regression test", `The check passed, but your edits add no regression test. Add one test case to the test file the dossier names that fails on the original code and passes with your fix. Reply with edit blocks for the test only, then LOKI_DONE.`); continue; } // the one repair call: a test, never a weaker tree
    if (greenSnap) return keepGreen("the new test is red");
    if (!c.ran) return end("red"); // fail closed: a check that cannot run is never green, and a repair cannot make it run
    repair("red check", `The harness applied your edits and ran the check: it FAILED.\nFailure digest:\n${c.digest.slice(0, DIGEST_MAX_CHARS)}\nCurrent text of the regions you edited:\n${currentRegions(d.rules.repoDir, p.blocks)}\n\nReply with edit blocks against the current text (your earlier edits stay applied), then LOKI_DONE.`);
  }
  const last = messages[messages.length - 1]!;
  return end(last.role === "user" && /^None of your edits/.test(last.content) ? "rejected" : last.role === "user" && /^The harness applied/.test(last.content) ? "red" : "no_edits");
  }
}

/** Repo-relative paths of `applied` that are test files (their checks run even when the test map does not list them yet). */
export const appliedTests = (applied: string[]): string[] => applied.filter((f) => isTestFile(f));
export const relTo = (repoDir: string, p: string): string => (p.startsWith(`${repoDir}/`) ? relative(repoDir, p) : p);

/** One turn of history flattened into a single prompt: the tool-less primitive takes one prompt, so a repair carries the brief, the earlier reply and the harness's message. */
export function flattenMessages(messages: PatchMessage[]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages.map((m, i) => i === 0 ? m.content : m.role === "assistant" ? `Your earlier reply:\n<<<REPLY\n${m.content.trim()}\nREPLY` : `Harness:\n${m.content}`).join("\n\n");
}
export const PATCH_MAX_TOKENS = 8000;
/** The production call: runner/sdk_invoker.ts toolLessCall (PR0), thinking off, priced into the run's child ledger under phase "implement-patch". */
export function patchCallFor(model: string, lokiDir: string, timeoutMs = 180_000, env: NodeJS.ProcessEnv = process.env): PatchCall {
  if (env.LOKI_E10_INVOKER === "cli") return async ({ system, messages, signal }) => { // the CLI invoker (tests/min e2e stub, legacy installs): `claude -p` with no tools, priced by withChildLedger
    try {
      const r = await withChildLedger(run, lokiDir, "implement-patch", model)([env.LOKI_CLAUDE_CLI || "claude", "-p", flattenMessages(messages), "--output-format", "json", "--tools", "", "--model", model, "--system-prompt", system, "--strict-mcp-config", "--setting-sources", "project"], { timeoutMs, group: true, signal });
      const j = JSON.parse(r.stdout) as { result?: unknown; is_error?: boolean; total_cost_usd?: number };
      return { text: r.exitCode === 0 && !j.is_error && typeof j.result === "string" ? j.result : null, usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null };
    } catch { return { text: null, usd: null }; }
  };
  return async ({ system, messages }) => {
    const r = await toolLessCall({ model, system, prompt: flattenMessages(messages), maxTokens: PATCH_MAX_TOKENS, thinking: "off", timeoutMs, ledger: { lokiDir, phase: "implement-patch" } });
    return { text: r.outcome.kind === "ok" ? r.outcome.value : null, usd: r.usd };
  };
}
