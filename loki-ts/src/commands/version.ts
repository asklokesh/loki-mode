// Port of autonomy/loki:cmd_version (line 6632).
import { getVersion } from "../version.ts";
import { maybePrintUpdateHint } from "../util/update_check.ts";

export async function runVersion(): Promise<number> {
  const current = getVersion();
  process.stdout.write(`Loki Mode v${current}\n`);
  // F54: non-blocking, cached, opt-out, TTY-only stale-install nudge. Prints
  // to stderr so stdout stays byte-for-byte stable. Fail-silent (never throws).
  await maybePrintUpdateHint(current);
  return 0;
}
