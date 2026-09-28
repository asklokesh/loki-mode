// loki-ts/src/engine10/modernize/codemod.ts -- M-16: deterministic codemods first (docs/v10/
// MODERNIZE.md section 3.4 "Deterministic codemods run first when installed"). Runs futurize
// (py2->3) or OpenRewrite's UpgradeToJava21 (java8->21) ahead of the model, or reports a skip
// reason when the tool binary is absent so the caller can emit codemod.skipped (types.ts). The
// child-process call is injected so tests stay deterministic without either tool installed.
import { spawnSync } from "node:child_process";
import type { ModernizeTarget } from "./types.ts";

/** found:false means the binary itself could not be located (ENOENT), separate from a found
 *  tool that ran and failed -- codemod.skipped needs to say WHY, not just "did not apply". */
export interface CommandResult {
  found: boolean;
  code: number | null; // exit code when found; null when not found
}
export type CommandRunner = (cmd: string, args: string[], cwd: string) => CommandResult;

/** Real runner: spawnSync, with a missing binary reported as found:false rather than thrown. */
export const realCommandRunner: CommandRunner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return { found: false, code: null };
  return { found: true, code: r.status };
};

interface ToolSpec {
  name: string;
  bin: string;
  args: (files: readonly string[]) => string[];
}
// Table (section 13, M-16) and section 3.4: futurize for py2 to 3, OpenRewrite's
// UpgradeToJava21 recipe (via its maven plugin, the documented invocation) for java 8 to 21.
const TOOLS: Record<ModernizeTarget, ToolSpec> = {
  python3: { name: "futurize", bin: "futurize", args: (files) => ["--write", "--nobackups", ...files] },
  java21: {
    name: "openrewrite", bin: "mvn",
    args: () => ["-q", "org.openrewrite.maven:rewrite-maven-plugin:run",
      "-Drewrite.activeRecipes=org.openrewrite.java.migrate.UpgradeToJava21"],
  },
};

export interface CodemodOutcome {
  target: ModernizeTarget;
  tool: string;
  ran: boolean; // true only when the tool binary was found and invoked
  applied: boolean; // true when it ran and exited 0 ("the model fixes only what codemods miss")
  skippedReason: string | null; // set whenever ran is false
}

/** Section 3.4: run the target's deterministic codemod first over one unit's files. A missing
 *  tool is not a failure -- it is recorded and the whole unit falls to the model. `files` are
 *  repo-relative paths; `runner` defaults to a real spawnSync call and is swapped for a stub
 *  in tests so behavior never depends on futurize/mvn actually being installed. */
export function runCodemod(
  target: ModernizeTarget,
  files: readonly string[],
  repoDir: string,
  runner: CommandRunner = realCommandRunner,
): CodemodOutcome {
  const tool = TOOLS[target];
  if (files.length === 0) {
    return { target, tool: tool.name, ran: false, applied: false, skippedReason: "no files in unit" };
  }
  const result = runner(tool.bin, tool.args(files), repoDir);
  if (!result.found) {
    return { target, tool: tool.name, ran: false, applied: false, skippedReason: `${tool.bin} not found on PATH` };
  }
  return { target, tool: tool.name, ran: true, applied: result.code === 0, skippedReason: null };
}
