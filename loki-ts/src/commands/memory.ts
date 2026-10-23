// Port of autonomy/loki:cmd_memory (line 12943) -- subset for Phase 2:
// `list` / `ls` and `index` only. Other subcommands (show, consolidate,
// timeline, etc.) defer to bash via execLegacyBash.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { suggestWord } from "../cli/registry.ts";
import { BOLD, GREEN, YELLOW, CYAN, NC } from "../util/colors.ts";
import { homeLokiDir, lokiDir, REPO_ROOT } from "../util/paths.ts";
import { runInline } from "../util/python.ts";
import { run } from "../util/shell.ts";
import { GhError, type Lesson, formatLessonList, formatLessonsForBrief, learnFromPr, learnRecent, MAX_RECENT, defaultGh, loadLessons, promoteLesson, removeLesson, retrieveLessons } from "../util/pr_lessons.ts";
import { learningsBlock } from "../engine10/stages/implement.ts";

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

// verified_ratio is VERIFIED uses over uses with a settled verdict; null while none has settled.
function lessonJson(l: Lesson): Record<string, unknown> {
  const settled = l.uses.filter((u) => u.verdict !== null);
  const verified = settled.filter((u) => u.verdict === "VERIFIED").length;
  return { id: l.id, text: l.text, source: l.source, uses: l.uses.length, verified_ratio: settled.length ? verified / settled.length : null };
}

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

export async function runMemory(argv: readonly string[]): Promise<number> {
  if (argv.length === 0) {
    // Bare `loki memory`: the learnings summary followed by this repo's PR lessons.
    const rc = await runMemoryList();
    process.stdout.write(`\n${formatLessonList(loadLessons(process.cwd()))}`);
    return rc;
  }
  const sub = argv[0] ?? "list";
  switch (sub) {
    case "lessons": {
      if (unknownFlag("lessons", argv.slice(1), ["--json"], "Usage: loki memory lessons [--json]")) return 2;
      const lessons = loadLessons(process.cwd());
      if (argv.slice(1).includes("--json")) {
        process.stdout.write(`${JSON.stringify(lessons.map(lessonJson), null, 2)}\n`);
        return 0;
      }
      process.stdout.write(formatLessonList(lessons));
      return 0;
    }
    case "brief": {
      // INJECT: the exact block an engine10 run injects, so `loki chat` can show it. No new retrieval.
      const bi = argv.findIndex((a, k) => k > 0 && a.startsWith("-") && a !== "--task" && a !== "--help" && a !== "-h" && argv[k - 1] !== "--task");
      if (bi > 0) { process.stderr.write(`Error: unknown flag '${argv[bi]}' for 'memory brief'\n${flagHint(argv[bi] ?? "", ["--task"])}Usage: loki memory brief [--task <text>]\n`); return 2; }
      const i = argv.indexOf("--task");
      const task = i >= 0 ? (argv[i + 1] ?? "") : "";
      if (i >= 0 && (task === "" || task.startsWith("--"))) { process.stderr.write("Usage: loki memory brief [--task <text>]\n"); return 2; }
      process.stdout.write((formatLessonsForBrief(retrieveLessons(process.cwd(), task)) + learningsBlock(process.cwd())).trimStart());
      return 0;
    }
    case "promote": {
      const id = argv[1];
      if (!id) { process.stderr.write("Usage: loki memory promote <prl-id>\n"); return 2; }
      const got = promoteLesson(process.cwd(), id);
      if (!got) { process.stderr.write(`Error: no such lesson '${id}'\n`); return 1; }
      process.stdout.write(`Promoted ${got.id}: it can now appear in briefs for every repo. 'loki memory forget ${got.id}' withdraws it.\n`);
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
          const t = rows.reduce((a, r) => a + r.added, 0);
          process.stdout.write(`Learned from ${rows.length} merged PR(s): ${t} added\n`);
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
        process.stdout.write(`Learned from ${argv[1]}: ${r.added} added, ${r.duplicates} already known, ${r.skipped} skipped (empty)\n`);
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
