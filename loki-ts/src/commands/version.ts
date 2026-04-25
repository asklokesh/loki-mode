// Port of autonomy/loki:cmd_version (line 6632).
import { getVersion } from "../version.ts";

export function runVersion(): number {
  process.stdout.write(`Loki Mode v${getVersion()}\n`);
  return 0;
}
