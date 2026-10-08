// `loki plan <task> --spec` (SPEC-FIRST-INTENT): one model session writes the intent card's criteria as schema-checked JSON;
// the harness renders .loki/specs/<slug>.md for the user to edit, then `loki start --spec <file>` runs against it.
import { relative } from "node:path";
import { safeGit } from "../util/safe_git.ts";
import { generateSpec } from "../util/spec_file.ts";
import { createSessionRunner, resolveModel, type EmitFn } from "../engine10/session.ts";
import type { SessionRunner } from "../engine10/types.ts";

export const PLAN_USAGE = "usage: loki plan <task> --spec [--force] [--provider <name>]\n  writes the acceptance criteria to .loki/specs/<slug>.md; edit it, then run: loki start --spec .loki/specs/<slug>.md\n";

export async function main(args: string[], sessions?: SessionRunner): Promise<number> {
  const words: string[] = [];
  let spec = false, force = false, provider = process.env.LOKI_PROVIDER || "claude";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--spec") spec = true;
    else if (a === "--force") force = true;
    else if (a === "--provider") provider = args[++i] ?? provider;
    else words.push(a);
  }
  const task = words.join(" ").trim();
  if (!spec || !task) { process.stderr.write(PLAN_USAGE); return 2; }
  let repoDir: string;
  try { repoDir = safeGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); } catch { process.stderr.write("engine10: not inside a git repository\n"); return 2; }
  const runner = sessions ?? createSessionRunner({ provider, model: resolveModel(provider), emit: ((): void => {}) as EmitFn, lokiRoot: `${repoDir}/.loki` });
  try {
    const r = await generateSpec({ task, repoDir, sessions: runner, force });
    const rel = relative(repoDir, r.path);
    process.stdout.write(`Spec written: ${rel}\nEdit it, then run: loki start --spec ${rel}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`engine10: ${(e as Error).message}\n`);
    return /exists/.test((e as Error).message) ? 2 : 1;
  }
}
