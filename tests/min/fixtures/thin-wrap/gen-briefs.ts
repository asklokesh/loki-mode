// The implement briefs this lane pins (tests/min/context-pack.sh THIN-BRIEF cell 3). The .txt files beside this one were written from the 11.185.0 tree
// (origin/main 05ba77321) with `bun tests/min/fixtures/thin-wrap/gen-briefs.ts <out dir>`; the cell imports `briefs` and compares byte for byte. Every
// LOKI_ variable is cleared first, so the text does not depend on the caller's environment.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
for (const k of Object.keys(process.env)) if (k.startsWith("LOKI_")) delete process.env[k];
const here = import.meta.dir, src = join(here, "..", "..", "..", "..", "loki-ts", "src");
const { buildImplementBrief } = await import(join(src, "engine10/stages/implement.ts"));
const cx = await import(join(src, "e10ext/context.ts"));
export const task = readFileSync(join(here, "task.md"), "utf8"), card = "Server programs this repository needs that are not on PATH: none.";
export const briefs: Record<string, () => string> = {
  "brief-issue.txt": () => buildImplementBrief(task, null, [], "", cx.proveByRunningBlock("claude", "issue", {}, card), undefined, undefined, true),
  "brief-text.txt": () => buildImplementBrief(task, null, [], "", cx.proveByRunningBlock("claude", "text", { LOKI_E10_WORK_ROAD: "1" }, card), undefined, undefined, "text"),
  "brief-plan.txt": () => buildImplementBrief(task, "1. add multiply beside add in calc.ts", [], "", cx.proveByRunningBlock("claude", "issue", {}, card), undefined, undefined, true),
};
const out = import.meta.main ? process.argv[2] : undefined;
if (out) for (const [f, b] of Object.entries(briefs)) writeFileSync(join(out, f), b());
