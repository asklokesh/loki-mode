// Port of autonomy/loki:cmd_memory (line 12943) -- subset for Phase 2:
// `list` / `ls` and `index` only. Other subcommands (show, consolidate,
// timeline, etc.) defer to bash via execLegacyBash.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { BOLD, GREEN, YELLOW, CYAN, NC } from "../util/colors.ts";
import { homeLokiDir, lokiDir, REPO_ROOT } from "../util/paths.ts";
import { runInline } from "../util/python.ts";
import { run } from "../util/shell.ts";

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

export async function runMemoryList(): Promise<number> {
  await mkdir(LEARNINGS_DIR, { recursive: true });

  const patterns = countDescriptionLines(resolve(LEARNINGS_DIR, "patterns.jsonl"));
  const mistakes = countDescriptionLines(resolve(LEARNINGS_DIR, "mistakes.jsonl"));
  const successes = countDescriptionLines(resolve(LEARNINGS_DIR, "successes.jsonl"));

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
    // Mirror autonomy/loki:13399 -- import memory.layers, build, print.
    const py = `
try:
    from memory.layers import IndexLayer
    layer = IndexLayer('.loki/memory')
    layer.update([])
    print('Index rebuilt')
except ImportError:
    print('Error: memory.layers module not found')
except Exception as e:
    print(f'Error: {e}')
`.trim();
    const r = await runInline(py, { cwd: REPO_ROOT });
    process.stdout.write(r.stdout);
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

export async function runMemory(argv: readonly string[]): Promise<number> {
  const sub = argv[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return runMemoryList();
    case "index":
      return runMemoryIndex(argv[1] === "rebuild");
    default: {
      // Defer all other subcommands (show, consolidate, timeline, ...) to bash.
      const bashCmd = resolve(REPO_ROOT, "autonomy", "loki");
      const r = await run([bashCmd, "memory", ...argv], {
        env: { LOKI_LEGACY_BASH: "1" },
      });
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      return r.exitCode;
    }
  }
}
