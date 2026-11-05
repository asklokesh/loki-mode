// False-fire replay of relation cases on real commits whose message names error wrapping: the message is the issue, the
// parent is base, the commit's non-test Go changes are the patch. A case that fails on the maintainer's tree is a false fire.
// Usage: bun fp.ts <work-dir> <repo-dir>:<sha> ...
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { goPackageFiles, judgeRel, parseRel, relationSpec } from "./relation.ts";
const [workArg, ...specs] = process.argv.slice(2) as [string, ...string[]];
const work = resolve(workArg); mkdirSync(work, { recursive: true });
const env = { ...process.env, GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };
const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const rows = [];
for (const s of specs) {
  const [repo, sha] = s.split(":") as [string, string];
  const msg = git(repo, "log", "-1", "--format=%B", sha);
  const changed = git(repo, "diff", "--name-only", `${sha}^`, sha).split("\n").filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
  for (const dir of [...new Set(changed.map((f) => (f.includes("/") ? dirname(f) : ".")))]) {
    const base = join(work, `${sha}-${dir.replace(/\//g, "_")}`, "base"), head = join(work, `${sha}-${dir.replace(/\//g, "_")}`, "head");
    for (const [d, rev] of [[base, `${sha}^`], [head, sha]] as const) { mkdirSync(d, { recursive: true }); execFileSync("sh", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "sh", repo, rev, d]); }
    const files = goPackageFiles(join(base, dir)), pkg = /^package (\w+)/m.exec(Object.values(files)[0] ?? "")?.[1] ?? "main";
    const spec = relationSpec(msg, files, pkg);
    if (!spec) { rows.push({ sha, dir, spec: null, why: "no relation spec (no named function with a strict check)" }); continue; }
    const run = (d: string) => { writeFileSync(join(d, dir, "zz_loki_relation_test.go"), spec.test); const r = spawnSync("go", ["test", "-count=1", "-run", "^TestLokiRelation$", "-v", "."], { cwd: join(d, dir), encoding: "utf8", env, timeout: 300_000 }); return parseRel(`${r.stdout}${r.stderr}`); };
    const j = judgeRel(run(base), run(head));
    rows.push({ sha, dir, fn: spec.fn, cases: spec.cases.map((c) => c.id), falseFire: j.some((x) => !x.pass), j });
  }
}
console.log(JSON.stringify(rows, null, 1));
