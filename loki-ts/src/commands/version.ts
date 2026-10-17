// Port of autonomy/loki:cmd_version (line 6632).
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getVersion } from "../version.ts";
import { findRepoRootForVersion } from "../util/paths.ts";
import { maybePrintUpdateHint } from "../util/update_check.ts";

const VERSION_HELP = `Loki Mode -- print version

Usage: loki version [--json]

Prints 'Loki Mode vX.Y.Z' from the VERSION file shipped with
the package. Equivalent to 'loki --version' and 'loki -v'.

  --json    Print {"version","runtime","install_path"} as one JSON line
`;

export async function runVersion(args: string[] = []): Promise<number> {
  const current = getVersion();
  if (args.includes("--json")) {
    const installPath = findRepoRootForVersion(dirname(fileURLToPath(import.meta.url)));
    process.stdout.write(
      `${JSON.stringify({ version: current, runtime: "bun", install_path: installPath })}\n`,
    );
    return 0;
  }
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(VERSION_HELP);
    return 0;
  }
  process.stdout.write(`Loki Mode v${current}\n`);
  // F54: non-blocking, cached, opt-out, TTY-only stale-install nudge. Prints
  // to stderr so stdout stays byte-for-byte stable. Fail-silent (never throws).
  await maybePrintUpdateHint(current);
  return 0;
}
