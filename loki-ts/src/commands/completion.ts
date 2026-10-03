// Hidden plumbing: `loki completion <bash|zsh|fish>` prints a generated script;
// `loki completion --auto|--postinstall` is the automatic installer (never needed
// by users); `loki __complete <kind>` feeds dynamic values to the generated
// scripts. See loki-ts/src/cli/completions.ts.
import { autoInstall, completeKind, generate, type Shell } from "../cli/completions.ts";
import { getVersion } from "../version.ts";

export function runCompletion(args: readonly string[]): number {
  const first = args[0];
  if (first === "--auto" || first === "--postinstall") {
    // Must never fail an install or block a first run.
    try {
      const r = autoInstall({ version: getVersion(), requireTty: first === "--auto", tty: Boolean(process.stdout.isTTY) });
      if (r.status === "installed" && first === "--auto") {
        process.stderr.write(`loki: shell completions updated (${r.written.join(", ")})\n`);
      }
    } catch {
      /* ignore */
    }
    return 0;
  }
  if (first === "bash" || first === "zsh" || first === "fish") {
    process.stdout.write(generate(first as Shell));
    return 0;
  }
  process.stderr.write("usage: loki completion <bash|zsh|fish>\n");
  return 2;
}

export function runDynComplete(args: readonly string[]): number {
  const kind = args[0] ?? "";
  for (const v of completeKind(kind)) process.stdout.write(`${v}\n`);
  return 0;
}
