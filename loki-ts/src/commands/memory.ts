// Port of autonomy/loki cmd_memory() -- subset for Phase 2:
// `list` / `ls` and `index` only. Other subcommands (show, consolidate,
// timeline, etc.) defer to bash via execLegacyBash.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { suggestWord } from "../cli/registry.ts";
import { BOLD, GREEN, YELLOW, CYAN, NC } from "../util/colors.ts";
import { homeLokiDir, lokiDir, REPO_ROOT } from "../util/paths.ts";
import { runInline } from "../util/python.ts";
import { redactSecrets } from "../util/redact.ts";
import { run } from "../util/shell.ts";
import { GhError, orgKnowledgeBlock, type Lesson, formatLessonList, formatLessonsForBrief, learnFromPr, learnRecent, MAX_RECENT, defaultGh, loadLessons, promoteLesson, removeLesson, retrieveLessons, approvedOnBase, approveLesson, applyProposal, readForRuns, approvalLabel } from "../util/pr_lessons.ts";
import { learningsBlock } from "../engine10/stages/implement.ts";
import { exportRepoCard, mergedCard, renderCardText } from "../e10ext/repomemory.ts";

const LEARNINGS_DIR = resolve(homeLokiDir(), "learnings");

// Count lines containing "description" -- mirrors bash `grep -c '"description"'`.
function countDescriptionLines(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    const txt = readFileSync(file, "utf-8");
    let n = 0;
    for (const line of txt.split("\n")) {
      if (line.includes('"description"')) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

export async function runMemoryList(json = false): Promise<number> {
  await mkdir(LEARNINGS_DIR, { recursive: true });

  const patterns = countDescriptionLines(resolve(LEARNINGS_DIR, "patterns.jsonl"));
  const mistakes = countDescriptionLines(resolve(LEARNINGS_DIR, "mistakes.jsonl"));
  const successes = countDescriptionLines(resolve(LEARNINGS_DIR, "successes.jsonl"));

  if (json) {
    process.stdout.write(`${JSON.stringify({ patterns, mistakes, successes, learnings_path: LEARNINGS_DIR }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${BOLD}Cross-Project Learnings${NC}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  Patterns:  ${GREEN}${patterns}${NC}\n`);
  process.stdout.write(`  Mistakes:  ${YELLOW}${mistakes}${NC}\n`);
  process.stdout.write(`  Successes: ${CYAN}${successes}${NC}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Location: ${LEARNINGS_DIR}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Use 'loki memory show <type>' to view entries\n`);
  return 0;
}

export async function runMemoryIndex(rebuild: boolean): Promise<number> {
  if (rebuild) {
    // Mirror autonomy/loki memory index rebuild: MemoryEngine.rebuild_index()
    // against the caller's .loki/memory, non-zero on failure.
    const py = `
import sys
try:
    from memory.engine import MemoryEngine
    engine = MemoryEngine(base_path='.loki/memory')
    engine.rebuild_index()
    total = (engine.get_index() or {}).get('total_memories', 0)
except Exception as e:
    print(f'Error: index rebuild failed: {type(e).__name__}: {e}', file=sys.stderr)
    sys.exit(1)
print(f'Index rebuilt: {total} memories indexed')
`.trim();
    const existing = process.env["PYTHONPATH"];
    const r = await runInline(py, {
      cwd: process.cwd(),
      env: { PYTHONPATH: existing ? `${REPO_ROOT}:${existing}` : REPO_ROOT },
    });
    process.stdout.write(r.stdout);
    if (r.exitCode !== 0) {
      process.stderr.write(r.stderr || `Error: index rebuild failed (exit ${r.exitCode})\n`);
      return r.exitCode || 1;
    }
    return 0;
  }

  // Display mode: cat .loki/memory/index.json | python3 -m json.tool
  const indexPath = resolve(lokiDir(), "memory", "index.json");
  if (!existsSync(indexPath)) {
    process.stdout.write(`No index found\n`);
    return 0;
  }
  const r = await runInline(
    `import json, sys; sys.stdout.write(json.dumps(json.load(open(${JSON.stringify(indexPath)})), indent=4) + "\\n")`,
  );
  if (r.exitCode !== 0) {
    process.stdout.write(`No index found\n`);
    return 0;
  }
  process.stdout.write(r.stdout);
  return 0;
}

export interface MemoryHit { run_id: string; date: string; file: string; line: number; text: string }

const SEARCH_USAGE = "Usage: loki memory search <text> [--json]";

const MAX_LINE_CHARS = 1024 * 1024;

// Calls onLine as each line completes, reading 64 KB chunks. A line keeps at most MAX_LINE_CHARS (the rest is dropped), so memory stays bounded. Returns false when the file holds a NUL byte (binary).
export function eachLine(abs: string, onLine: (line: string, no: number) => void): boolean {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const dec = new StringDecoder("utf8");
    let carry = "";
    let no = 0;
    const push = (piece: string): void => {
      if (carry.length < MAX_LINE_CHARS) carry += piece.length > MAX_LINE_CHARS - carry.length ? piece.slice(0, MAX_LINE_CHARS - carry.length) : piece;
    };
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      if (buf.subarray(0, n).includes(0)) return false;
      const parts = dec.write(buf.subarray(0, n)).split("\n");
      for (let i = 0; i < parts.length; i++) {
        push(parts[i] ?? "");
        if (i < parts.length - 1) { onLine(carry, ++no); carry = ""; }
      }
    }
    push(dec.end());
    if (carry !== "") onLine(carry, ++no);
    return true;
  } finally { closeSync(fd); }
}

// Case-insensitive substring search over run files, decisions and semantic memory under <root>/.loki. Nothing is read through a symlink: a symlinked .loki is refused
// (no hits), and every directory and file must resolve to its own lexical path under the real .loki. A file with more than one hard link (st_nlink > 1) is refused too.
// Printed fields pass through the shared secret redactor; a multi-line PEM private key is withheld from its BEGIN line (redacted) through its END line (never matched or printed). The Bun route covers decisions, runs and semantic memory only.
export function searchMemory(root: string, text: string): MemoryHit[] {
  const needle = text.toLowerCase();
  const hits: MemoryHit[] = [];
  let base: string;
  try {
    const lexical = resolve(root, ".loki");
    if (!lstatSync(lexical).isDirectory()) return hits;
    base = realpathSync(lexical);
  } catch { return hits; }
  const inside = (abs: string): boolean => {
    try { return realpathSync(abs) === abs; } catch { return false; }
  };
  const red = (v: string): string => redactSecrets(v);
  const scan = (abs: string, rel: string, runId: string): void => {
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1 || !inside(abs)) return;
      const date = st.mtime.toISOString().slice(0, 10);
      let inPem = false;
      eachLine(abs, (ln, no) => {
        if (inPem) {
          if (/-----END [A-Z ]*PRIVATE KEY-----/.test(ln)) inPem = false;
          return;
        }
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(ln) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(ln)) inPem = true;
        if (ln.toLowerCase().includes(needle)) hits.push({ run_id: red(runId), date, file: red(rel), line: no, text: red(ln.trim()).slice(0, 200) });
      });
    } catch { /* unreadable file: no hits */ }
  };
  const names = (dir: string): string[] => {
    try { return lstatSync(dir).isDirectory() && inside(dir) ? readdirSync(dir).sort() : []; } catch { return []; }
  };
  for (const id of names(resolve(base, "runs"))) {
    for (const f of names(resolve(base, "runs", id))) scan(resolve(base, "runs", id, f), `.loki/runs/${id}/${f}`, id);
  }
  for (const f of names(resolve(base, "decisions"))) scan(resolve(base, "decisions", f), `.loki/decisions/${f}`, "-");
  for (const f of names(resolve(base, "memory", "semantic"))) scan(resolve(base, "memory", "semantic", f), `.loki/memory/semantic/${f}`, "-");
  return hits;
}

// verified_ratio is VERIFIED uses over uses with a settled verdict; null while none has settled.
function lessonJson(l: Lesson, onBase: () => Set<string>): Record<string, unknown> {
  const settled = l.uses.filter((u) => u.verdict !== null);
  const verified = settled.filter((u) => u.verdict === "VERIFIED").length;
  return { id: l.id, text: l.text, source: l.source, uses: l.uses.length, verified_ratio: settled.length ? verified / settled.length : null, ...(l.kind === "run" ? { kind: l.kind, category: l.category, seen: l.seen, subs: l.subs, files: l.files } : {}),
    ...(l.approval ? { approval: { ...l.approval, read_by_runs: readForRuns(l, onBase), status: approvalLabel(l, onBase) } } : {}) }; // R3: where a learned lesson stands
}
/** R3: the lesson ids this checkout's HEAD guidance approves, read once and only when a proposed lesson asks (util/pr_lessons.ts approvedOnBase). */
function headApprovals(): () => Set<string> {
  let ids: Set<string> | null = null;
  return () => (ids ??= approvedOnBase(process.cwd(), null));
}
const PROPOSED_NOTE = "later runs read a proposed lesson only once it is approved: see loki lessons";
const LESSONS_USAGE = "Usage: loki lessons [--json]          list the lessons, where each stands and its proposed guidance edit\n       loki lessons approve <id>     approve one so later runs read it (local to this checkout)\n       loki lessons apply <id>       write its proposed AGENTS.md line or .loki-checklist.json item for you to commit\n(also: loki memory lessons ...)";

// "Did you mean" line for a mistyped flag, or empty when no allowed flag is close.
function flagHint(bad: string, allowed: readonly string[]): string {
  const hint = suggestWord(bad, allowed);
  return hint ? `Did you mean '${hint}'?\n` : "";
}

// Reject flags a read-only subcommand does not know instead of printing the default output.
function unknownFlag(sub: string, rest: readonly string[], allowed: readonly string[], usage: string): boolean {
  const bad = rest.find((a) => a.startsWith("-") && !allowed.includes(a) && a !== "--help" && a !== "-h");
  if (bad === undefined) return false;
  process.stderr.write(`Error: unknown flag '${bad}' for 'memory ${sub}'\n${flagHint(bad, allowed)}${usage}\n`);
  return true;
}

/** `loki knowledge`: what Loki has verified about this repository (the repo card, e10ext/repomemory.ts). `export` writes the one file a team commits. */
export function runKnowledge(argv: readonly string[]): number {
  const usage = "Usage: loki knowledge [--json]   show what Loki has verified about this repository\n       loki knowledge export     write .github/loki-repo-card.md for your team to commit\n";
  const sub = argv.find((a) => !a.startsWith("-")), bad = argv.find((a) => a.startsWith("-") && a !== "--json");
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(usage); return 0; }
  if (bad || (sub !== undefined && sub !== "show" && sub !== "export")) { process.stderr.write(`Error: unknown ${bad ? `flag '${bad}'` : `subcommand '${sub}'`} for 'knowledge'\n${usage}`); return 2; }
  if (sub === "export") {
    const r = exportRepoCard(process.cwd());
    if (!r) { process.stderr.write("Nothing to export: Loki has no verified facts about this repository yet (the card is written after an issue run).\n"); return 1; }
    process.stdout.write(`Wrote ${r.path} (${r.facts} fact${r.facts === 1 ? "" : "s"}). Loki does not commit it: review it and commit it yourself so every clone, teammate and CI job starts with it.\n${r.ignored ? `Warning: git ignores ${r.path} in this repository, so it will not travel with a clone until that ignore rule is changed.\n` : ""}`);
    return 0;
  }
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(mergedCard(process.cwd()), null, 2) + "\n"); else process.stdout.write(renderCardText(process.cwd()));
  return 0;
}

export async function runMemory(argv: readonly string[]): Promise<number> {
  if (argv.length === 0) {
    // Bare `loki memory`: the learnings summary followed by this repo's PR lessons.
    const rc = await runMemoryList();
    process.stdout.write(`\n${formatLessonList(loadLessons(process.cwd()), headApprovals())}`);
    return rc;
  }
  const sub = argv[0] ?? "list";
  switch (sub) {
    case "lessons": {
      const act = argv[1];
      if (act === "approve" || act === "apply") { // R3 approved learning: nothing here commits, pushes or posts
        const id = argv[2];
        if (!id || id.startsWith("-") || argv.length > 3) { process.stderr.write(`${LESSONS_USAGE}\n`); return 2; }
        if (act === "approve") {
          const l = approveLesson(process.cwd(), id);
          if (!l) { process.stderr.write(`Error: no such lesson '${id}'\n`); return 1; }
          process.stdout.write(`Approved ${l.id}: later runs read it (lessons reach a brief with LOKI_PR_LESSONS=1). This approval lives in this checkout's .loki; to share it with the team, run 'loki lessons apply ${l.id}' and merge the edit.\n`);
          return 0;
        }
        try {
          const r = applyProposal(process.cwd(), id);
          process.stdout.write(r.wrote ? `Wrote the proposed edit for ${id} to ${r.file}. Loki does not commit it: review it, commit it on a branch and open a PR. Once it is merged on the base branch, later runs read this lesson.\n` : `${r.file} already carries ${id}; nothing written.\n`);
          return 0;
        } catch (e) { process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
      }
      if (act !== undefined && !act.startsWith("-")) { process.stderr.write(`Error: unknown subcommand '${act}' for 'lessons'\n${LESSONS_USAGE}\n`); return 2; }
      if (unknownFlag("lessons", argv.slice(1), ["--json"], LESSONS_USAGE)) return 2;
      const lessons = loadLessons(process.cwd()), onBase = headApprovals();
      if (argv.slice(1).includes("--json")) {
        process.stdout.write(`${JSON.stringify(lessons.map((l) => lessonJson(l, onBase)), null, 2)}\n`);
        return 0;
      }
      process.stdout.write(formatLessonList(lessons, onBase));
      return 0;
    }
    case "brief": {
      // INJECT: the exact block an engine10 run injects, so `loki chat` can show it. No new retrieval.
      const bi = argv.findIndex((a, k) => k > 0 && a.startsWith("-") && a !== "--task" && a !== "--help" && a !== "-h" && argv[k - 1] !== "--task");
      if (bi > 0) { process.stderr.write(`Error: unknown flag '${argv[bi]}' for 'memory brief'\n${flagHint(argv[bi] ?? "", ["--task"])}Usage: loki memory brief [--task <text>]\n`); return 2; }
      const i = argv.indexOf("--task");
      const task = i >= 0 ? (argv[i + 1] ?? "") : "";
      if (i >= 0 && (task === "" || task.startsWith("--"))) { process.stderr.write("Usage: loki memory brief [--task <text>]\n"); return 2; }
      process.stdout.write((formatLessonsForBrief(retrieveLessons(process.cwd(), task)) + learningsBlock(process.cwd()) + orgKnowledgeBlock(process.cwd(), task)).trimStart());
      return 0;
    }
    case "search": {
      if (unknownFlag("search", argv.slice(1), ["--json"], SEARCH_USAGE)) return 2;
      const text = argv.slice(1).filter((a) => !a.startsWith("-")).join(" ").trim();
      if (!text) { process.stderr.write(`${SEARCH_USAGE}\n`); return 2; }
      const hits = searchMemory(process.cwd(), text);
      if (argv.slice(1).includes("--json")) {
        process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
        return 0;
      }
      if (hits.length === 0) process.stdout.write(`No matches for '${text}'\n`);
      for (const h of hits) process.stdout.write(`${h.run_id}  ${h.date}  ${h.file}:${h.line}: ${h.text}\n`);
      return 0;
    }
    case "promote": {
      const id = argv[1];
      if (!id) { process.stderr.write("Usage: loki memory promote <prl-id>\n"); return 2; }
      const got = promoteLesson(process.cwd(), id);
      if (!got) { process.stderr.write(`Error: no such lesson '${id}'\n`); return 1; }
      process.stdout.write(`Promoted ${got.id}: it can now appear in briefs for every repo. 'loki memory forget ${got.id}' withdraws it.\n${got.approval?.state === "proposed" ? `It is still proposed, so no run reads it anywhere until it is approved: loki lessons approve ${got.id}\n` : ""}`);
      return 0;
    }
    case "forget": {
      const id = argv[1];
      if (!id) { process.stderr.write("Usage: loki memory forget <prl-id>\n"); return 2; }
      const gone = removeLesson(process.cwd(), id);
      if (!gone) { process.stderr.write(`Error: no such lesson '${id}'\n`); return 1; }
      process.stdout.write(`Forgot ${gone.id}: ${gone.text}\n`);
      return 0;
    }
    case "list":
    case "ls":
      if (unknownFlag("list", argv.slice(1), ["--json"], "Usage: loki memory list [--json]")) return 2;
      return runMemoryList(argv.slice(1).includes("--json"));
    case "learn": {
      const usage = "Usage: loki memory learn <owner/repo#PR> | --recent N [--repo owner/repo]\n";
      if (argv[1] === "--recent") {
        const raw = argv[2] ?? "";
        const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > MAX_RECENT) { process.stderr.write(`Error: --recent needs an integer from 1 to ${MAX_RECENT}\n${usage}`); return 2; }
        try {
          let repo = argv[3] === "--repo" ? (argv[4] ?? "") : "";
          if (!repo) {
            const g = await defaultGh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
            if (g.code === 127) { process.stderr.write("Error: gh CLI not found. Install GitHub CLI (https://cli.github.com) and run `gh auth login`.\n"); return 1; }
            repo = g.stdout.trim();
          }
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { process.stderr.write(`Error: cannot determine the repo; pass --repo owner/repo\n${usage}`); return 2; }
          const rows = await learnRecent(process.cwd(), repo, n);
          for (const r of rows) process.stdout.write(`${r.pr}: ${r.error ? `error: ${r.error}` : `${r.added} added, ${r.duplicates} already known, ${r.skipped} skipped${r.reason ? ` (${r.reason})` : ""}`}\n`);
          const t = rows.reduce((a, r) => a + r.added, 0), pr = rows.reduce((a, r) => a + (r.proposed ?? 0), 0);
          process.stdout.write(`Learned from ${rows.length} merged PR(s): ${t} added${pr ? `, ${pr} proposed (${PROPOSED_NOTE})` : ""}\n`);
          return 0;
        } catch (e) {
          if (e instanceof GhError) { process.stderr.write(`Error: ${e.message}\n`); return 1; }
          throw e;
        }
      }
      if (!argv[1]) { process.stderr.write(usage); return 2; }
      try {
        const r = await learnFromPr(process.cwd(), argv[1]);
        if (r.reason) process.stdout.write(`${r.reason}\n`);
        process.stdout.write(`Learned from ${argv[1]}: ${r.added} added, ${r.duplicates} already known, ${r.skipped} skipped (empty)${r.proposed ? `; ${r.proposed} proposed (${PROPOSED_NOTE})` : ""}\n`);
        return 0;
      } catch (e) {
        if (e instanceof GhError) { process.stderr.write(`Error: ${e.message}\n`); return 1; }
        throw e;
      }
    }
    case "index":
      return runMemoryIndex(argv[1] === "rebuild");
    default: {
      // Defer all other subcommands (show, consolidate, timeline,
      // ingest, ...) to bash.
      // v7.4.2 fix (BUG-9): cap legacy bash fall-through at 1h.
      // v7.7.18a fix: `run()` does not propagate stdin, so piped input
      // (e.g. `echo '{}' | loki memory ingest --from-stdin`) was lost
      // when the Bun route fell through to bash. Use Bun.spawn directly
      // with stdin: "inherit" so piped input survives the route hop.
      const bashCmd = resolve(REPO_ROOT, "autonomy", "loki");
      const TIMEOUT_MS = 3600000;
      const proc = Bun.spawn({
        cmd: [bashCmd, "memory", ...argv],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, LOKI_LEGACY_BASH: "1" },
      });
      const killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      }, TIMEOUT_MS);
      try {
        const exitCode = await proc.exited;
        return exitCode;
      } finally {
        clearTimeout(killTimer);
      }
    }
  }
}
