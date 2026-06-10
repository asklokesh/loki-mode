// CLI consolidation: shared Bun -> bash delegation helper.
//
// A few Bun-routed noun dispatchers own only part of a noun and must hand the
// remaining subcommands to the bash CLI, which owns the full noun (e.g. the Bun
// `report` arm handles `report kpis` natively but delegates every other report
// subcommand to bash cmd_report). This mirrors the inline `delegateToBash`
// pattern in commands/wiki.ts, factored out so each call site does not
// re-spawn its own copy. LOKI_LEGACY_BASH=1 forces the bash route so the spawn
// never recurses back into Bun.

import { resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";

// One hour: matches the wiki delegation timeout. Long-running bash subcommands
// (report generation can shell out to python3) must not be killed prematurely.
const TIMEOUT_MS = 3600000;

// Run the bash CLI (autonomy/loki) with the given argv, inheriting all stdio so
// stdout/stderr/exit-code pass through unchanged. Returns the child exit code.
export async function delegateToBash(argv: readonly string[]): Promise<number> {
  const bashCmd = resolve(REPO_ROOT, "autonomy", "loki");
  const proc = Bun.spawn({
    cmd: [bashCmd, ...argv],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, LOKI_LEGACY_BASH: "1" },
  });
  const killTimer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, TIMEOUT_MS);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(killTimer);
  }
}
