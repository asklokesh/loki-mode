// util/dotnet_test.ts -- `dotnet test` output reading and command building, the .NET twin of check_result.ts javaSummary/javaTestClass. Counts come from the test platform's own final summary only; a verdict that contradicts the counts, no summary, or zero executed tests is null (unmeasured, never a pass).
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dotnetProjectOf, dotnetTarget } from "./stack_tools.ts";

export interface DotnetSummary { executed: number; failed: number; ids: string[]; }
const num = (s: string | undefined): number => Number(s ?? "0");
/** VSTest (every SDK to .NET 9): one `Passed!  - Failed: 0, Passed: 1, Skipped: 0, Total: 1, Duration: 2 ms - X.dll (net8.0)` line per test assembly, summed. Microsoft.Testing.Platform (.NET 10): a `Test run summary: Passed!` block with `total:`, `failed:`, `succeeded:`, `skipped:` lines. Skipped tests did not execute. `text` is ANSI-stripped output. */
export function dotnetSummary(text: string): DotnetSummary | null {
  const ls = text.split("\n").map((l) => l.trimEnd());
  let executed = 0, failed = 0, seen = 0, verdictOk = true;
  for (const l of ls) {
    const m = /^(Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/.exec(l);
    if (!m) continue;
    const [f, p, s, t] = [num(m[2]), num(m[3]), num(m[4]), num(m[5])];
    if (f + p + s !== t || (m[1] === "Passed") !== (f === 0)) return null;
    seen++; executed += f + p; failed += f;
  }
  ls.forEach((l, i) => {
    const m = /^Test run summary: (Passed|Failed)!/.exec(l);
    if (!m) return;
    const blk = ls.slice(i + 1, i + 12), pick = (k: string): number | null => { const x = blk.map((b) => new RegExp(`^\\s+${k}: (\\d+)$`).exec(b)).find(Boolean); return x ? num(x[1]) : null; };
    const [t, f, p, s] = [pick("total"), pick("failed"), pick("succeeded"), pick("skipped")];
    if (t === null || f === null || p === null || s === null || f + p + s !== t || (m[1] === "Passed") !== (f === 0)) { verdictOk = false; return; }
    seen++; executed += f + p; failed += f;
  });
  if (!verdictOk || seen === 0 || executed === 0) return null;
  const ids = [...new Set(ls.flatMap((l) => /^\s+Failed (\S+)(?: \[[^\]]*\])?$/.exec(l)?.[1] ?? []))];
  return { executed, failed, ids };
}
/** Red on a build error with no test summary: only a C# compiler error (the feature a test names is absent), never a restore or SDK problem. */
export const dotnetBuildFailedBeforeAnyTest = (text: string): boolean => /: error CS\d+:/.test(text) && dotnetSummary(text) === null && !/^\s+(?:Passed|Failed) \S+ \[/m.test(text);

const FLAGS = ["--nologo", "--logger", "console;verbosity=normal"];
/** Test classes a C# file declares (a class named after the file when none parses), for the --filter. */
export function dotnetClasses(file: string): string[] {
  let text = ""; try { text = readFileSync(file, "utf8"); } catch { /* unreadable: fall back to the file name */ }
  const found = [...new Set([...text.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)].map((m) => m[1]!))];
  return found.length ? found : [basename(file, ".cs")];
}
/** One test file: its owning project with a class filter (coarse fallback: the whole repo target when no project owns it). */
export function dotnetTestCmd(repoDir: string, testRel: string): [string, string[]] {
  const proj = dotnetProjectOf(repoDir, testRel) ?? dotnetTarget(repoDir), filter = dotnetClasses(join(repoDir, testRel)).map((c) => `FullyQualifiedName~${c}`).join("|");
  return ["dotnet", ["test", ...(proj ? [proj] : []), "--filter", filter, ...FLAGS]];
}
/** The whole suite: one solution or project, else whatever the cwd holds. */
export function dotnetFullCmd(repoDir: string): { cmd: string; args: string[] } {
  const t = dotnetTarget(repoDir);
  return { cmd: "dotnet", args: ["test", ...(t && existsSync(join(repoDir, t)) ? [t] : []), ...FLAGS] };
}
