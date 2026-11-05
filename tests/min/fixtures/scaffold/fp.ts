// False-positive probe: replay real commits as "implementations" (checkout C, base C^, task = commit message), dry-run.
// usage: bun fp.ts <cloneDir> <n>
import { execFileSync } from "node:child_process";
import { scaffold } from "../../../../loki-ts/src/e10ext/scaffold.ts";
const [dir, nStr] = process.argv.slice(2);
const git = (...a: string[]) => execFileSync("git", ["-C", dir!, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
const commits = git("rev-list", "--no-merges", `-n`, nStr!, "origin/main", "--", "*.ts", "*.py", "*.go").trim().split("\n");
let n = 0, rwC = 0, rw = 0, sibC = 0, sib = 0; const samples: unknown[] = [];
for (const c of commits) {
  try { git("checkout", "-q", "-f", c); git("clean", "-qfd"); } catch { continue; }
  const msg = git("log", "-1", "--format=%B", c);
  let r; try { r = scaffold(dir!, `${c}^`.length ? git("rev-parse", `${c}^`).trim() : c, msg, { apply: false }); } catch (e) { continue; }
  n++;
  if (r.rewrites.length) { rwC++; rw += r.rewrites.length; samples.push({ c: c.slice(0, 9), rewrites: r.rewrites.slice(0, 3) }); }
  if (r.siblings.length) { sibC++; sib += r.siblings.length; samples.push({ c: c.slice(0, 9), siblings: r.siblings.slice(0, 3) }); }
}
console.log(JSON.stringify({ commits: n, commits_with_rewrite: rwC, rewrites: rw, commits_with_sibling: sibC, siblings: sib, samples }, null, 1));
