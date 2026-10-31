// select: walk-all-src
// ENGINE-LAWS L2 enforcement: every git call under loki-ts/src that can discard, rewrite or move user work (checkout, restore,
// reset, clean, rm as an argv element) must be listed here with a class and a one-line reason. A new call, or a second call
// of the same verb in a listed file, fails until it is classified. Class "work" paths may not hold destructive authority (L2),
// so any entry classed "work" is itself a failure: reclassify it as trust with a real justification, or remove the call.
// To classify a new call, add or bump its entry; do not loosen the scan.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const VERBS = ["checkout", "restore", "reset", "clean", "rm"] as const;

interface Entry { count: number; cls: "trust" | "work"; why: string }
const REGISTRY: Record<string, Entry> = {
  "project_model/install.ts|checkout": { count: 1, cls: "trust", why: "restores a tracked file the install changed; only files clean before the install, literal pathspec, verified after" },
  "e10ext/discard.ts|rm": { count: 1, cls: "trust", why: "already-satisfied discard removes only paths the run itself staged as added, never intake-owned files" },
  "e10ext/discard.ts|restore": { count: 1, cls: "trust", why: "already-satisfied discard restores only run-staged paths to base, skipping intake-owned and pre-existing dirt" },
  "e10ext/discard.ts|reset": { count: 1, cls: "trust", why: "already-satisfied discard moves HEAD and index back to base after the staged paths were handled" },
  "e10ext/commit_filter.ts|reset": { count: 1, cls: "trust", why: "backstop commit unstages paths outside the commit scope (index only, working files untouched)" },
  "engine10/stages/seal.ts|reset": { count: 1, cls: "trust", why: "commit stage unstages dropped paths (index only, working files untouched), literal pathspecs" },
  "engine10/modernize/scheduler.ts|reset": { count: 3, cls: "trust", why: "gitMergeOps: two resets squash and unstage excluded paths inside the unit worktree (never the user checkout); the third rolls back repoDir only after a clean-tree precheck, a successful own cherry-pick and HEAD^ == pre-merge sha, with --keep so it refuses rather than overwrite edits" },
  "e10ext/treeswap.ts|checkout": { count: 1, cls: "trust", why: "tree swap restores paths from the base commit while merging a chosen attempt tree into the run's own worktree" },
  "e10ext/treeswap.ts|rm": { count: 1, cls: "trust", why: "tree swap drops files the losing attempt added, inside the run's own worktree" },
  "engine10/stages/intake.ts|checkout": { count: 2, cls: "trust", why: "creates or enters the run branch; plain checkout refuses to overwrite edits" },
  "providers/provider_guard.ts|checkout": { count: 1, cls: "trust", why: "revertGuard restores only tracked files the provider run deleted, literal pathspecs after a -- separator, inside the run worktree" },
  "engine10/integrate.ts|checkout": { count: 1, cls: "trust", why: "creates the new integration branch from the base ref only after a clean tracked tree and a missing branch are verified; checkout -b never overwrites edits" },
  "features/speed/run_group.ts|checkout": { count: 2, cls: "trust", why: "resume leaves the stale group branch (one ternary: back to the start branch or detach at base); plain checkout never forces, so it refuses rather than overwrite edits" },
  "util/modernize_unit.ts|checkout": { count: 1, cls: "trust", why: "detaches FETCH_HEAD inside a fresh run-owned temp dir that holds only the fetched repo@ref; no user work exists there" },
  "util/run_outputs.ts|checkout": { count: 1, cls: "trust", why: "resume switches to the run branch only after a dirty-tree check refused uncommitted files; plain checkout never forces, so it refuses rather than overwrite edits" },
  "e10ext/stop_restore.ts|checkout": { count: 1, cls: "trust", why: "returns the user's checkout to the branch they started on; plain checkout refuses to overwrite edits" },
  "util/mutation_proof.ts|reset": { count: 1, cls: "trust", why: "mutation proof resets its own detached worktree (git worktree add under a fresh mkdtemp dir) to the base sha before a confirming re-run; never the user checkout" },
  "util/mutation_proof.ts|clean": { count: 1, cls: "trust", why: "mutation proof cleans its own detached temp worktree before a confirming re-run, excluding the linked dependency dirs so the user's node_modules/venv symlink targets are untouched" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

/** `file|verb` -> number of non-comment lines carrying that verb as a quoted argv element. */
export function scan(files: Array<[string, string]>): Record<string, number> {
  const found: Record<string, number> = {};
  for (const [rel, text] of files) {
    for (const line of text.split("\n")) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (/^\s*(legacy|cmd)\(/.test(line)) continue; // cli/registry.ts command names (`loki reset`, `loki restore`), not git argv
      if (/^\s*const QUEUE_SUBCOMMANDS\b/.test(line)) continue; // commands/queue.ts `loki queue rm` subcommand name, not git argv
      const code = line.replace(/\bnew Set\(\[[^\]]*\]\)/g, ""); // a Set literal of names is membership data (e.g. cargo subcommands), never a git argv
      for (const v of VERBS) {
        const n = (code.match(new RegExp(`["'\`]${v}["'\`]\\s*[,\\]]`, "g")) ?? []).length;
        if (n > 0) found[`${rel}|${v}`] = (found[`${rel}|${v}`] ?? 0) + n;
      }
    }
  }
  return found;
}

describe("L2 destructive call registry", () => {
  const found = scan(walk(SRC).map((p) => [relative(SRC, p).split(sep).join("/"), readFileSync(p, "utf8")]));
  test("every destructive git call is classified, and no entry is stale", () => {
    const unlisted = Object.entries(found).filter(([k, n]) => (REGISTRY[k]?.count ?? 0) !== n).map(([k, n]) => `${k} found ${n}, registry ${REGISTRY[k]?.count ?? 0}`);
    const stale = Object.keys(REGISTRY).filter((k) => !(k in found));
    expect(unlisted).toEqual([]);
    expect(stale).toEqual([]);
  });
  test("no work-class path holds destructive authority; every entry has a reason", () => {
    for (const [k, e] of Object.entries(REGISTRY)) {
      expect(`${k}: ${e.cls}`).toBe(`${k}: trust`);
      expect(e.why.length).toBeGreaterThan(10);
    }
  });
  test("positive control: the scanner flags an unlisted call and a comment is ignored", () => {
    const f = scan([["x.ts", '// git(["checkout", "--"])\n  git(root, ["checkout", base, "--", p]);\n  g(["--literal-pathspecs", "reset", "-q"]);']]);
    expect(f).toEqual({ "x.ts|checkout": 1, "x.ts|reset": 1 });
  });
  test("a Set literal of subcommand names is not argv, but a git call on the same line is still counted", () => {
    expect(scan([["z.ts", 'const SUBS = new Set(["build", "clean", "rm"]);']])).toEqual({});
    expect(scan([["z.ts", 'const SUBS = new Set(["clean"]); git(root, ["clean", "-fd"]);']])).toEqual({ "z.ts|clean": 1 });
  });
  test("positive control: destructive verbs are still seen through safeGit calls (FC-25)", () => {
    const f = scan([["y.ts", 'safeGit(repoDir, ["checkout", orig], { stdio: "ignore" });\n  safeGit(opts.repoDir, ["--literal-pathspecs", "reset", "-q", base, "--", f]);']]);
    expect(f).toEqual({ "y.ts|checkout": 1, "y.ts|reset": 1 });
  });
});
