// D91 finding class 4 guard: product code (loki-ts/src, autonomy/) must never read swarm-internal tools or paths:
// docs/v10/BOARD.md, scripts/v10-*, .loki/v10-leader (the company's own coordination files, absent from a user's install).
// Comment lines are ignored. Exceptions: guard-allowlists/swarm-internal-reads.txt.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { REPO, SRC, walk, filesMatching, loadAllowlist, checkAllowlist } from "./_guard_lib.ts";

export const SWARM = /BOARD\.md|v10-leader|scripts\/v10-|docs\/v10\/(BOARD|METRICS|STEERING)/;

test("no product code reads swarm-internal paths or tools", () => {
  const files = [...walk(SRC), ...walk(join(REPO, "autonomy"), [".sh", ".py", ".ts", ".js"]), join(REPO, "autonomy", "loki")];
  const r = checkAllowlist(filesMatching(files, SWARM), loadAllowlist("swarm-internal-reads.txt"));
  expect(r).toEqual({ unlisted: [], stale: [], noReason: [] });
});
