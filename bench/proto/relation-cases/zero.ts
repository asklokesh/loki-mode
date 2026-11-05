// Zero-call check of relation cases on a fixture: generate from the issue and the BASE code, run on base and on every
// variant (variants/<name>.go replaces repo/<the one source file>), and compare with the fixture's private oracle.
// Usage: bun zero.ts <fixture-dir> <work-dir> [<candidate.go> ...]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { goPackageFiles, judgeRel, parseRel, relationSpec } from "./relation.ts";

const [fxArg, workArg, ...extra] = process.argv.slice(2) as [string, string, ...string[]];
const fx = resolve(fxArg), work = resolve(workArg); mkdirSync(work, { recursive: true });
const repo = join(fx, "repo"), issue = readFileSync(join(fx, "issue.md"), "utf8");
const files = goPackageFiles(repo), src = Object.keys(files)[0]!, pkg = /^package (\w+)/m.exec(files[src]!)![1]!;
const env = { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local" };
const go = (dir: string, args: string[]) => { const r = spawnSync("go", args, { cwd: dir, encoding: "utf8", env, timeout: 180_000 }); return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` }; };
const spec = relationSpec(issue, files, pkg);
if (!spec) { console.log(JSON.stringify({ fixture: basename(fx), spec: null })); process.exit(0); }
const tree = (name: string, text: string | null) => { const d = join(work, name); cpSync(repo, d, { recursive: true }); if (text !== null) writeFileSync(join(d, src), text); writeFileSync(join(d, "zz_loki_relation_test.go"), spec.test); return d; };
const runRel = (d: string) => { const r = go(d, ["test", "-count=1", "-run", "^TestLokiRelation$", "-v", "."]); return { obs: parseRel(r.out), out: r.out }; };
const oracle = (d: string) => { if (!existsSync(join(fx, "oracle_test.go"))) return null; cpSync(join(fx, "oracle_test.go"), join(d, "zz_oracle_test.go")); return go(d, ["test", "-count=1", "-run", "^TestOracle", "."]).ok; };
const base = runRel(tree("base", null));
const variants = [...(existsSync(join(fx, "variants")) ? readdirSync(join(fx, "variants")).filter((f) => f.endsWith(".go")).map((f) => join(fx, "variants", f)) : []), ...extra.map((p) => resolve(p))];
const rows = variants.map((p) => {
  const d = tree(basename(p, ".go"), readFileSync(p, "utf8")), h = runRel(d), j = judgeRel(base.obs, h.obs);
  return { variant: basename(p, ".go"), relationPass: j.length > 0 && j.every((x) => x.pass), oracle: oracle(d), cases: j };
});
console.log(JSON.stringify({ fixture: basename(fx), fn: spec.fn, observer: spec.observer, cases: spec.cases.map((c) => `${c.id}: ${c.rv}`), base: judgeRel(base.obs, base.obs).map((x) => ({ id: x.id, redOnBase: x.redOnBase })), baseRan: base.obs.length, rows }, null, 1));
writeFileSync(join(work, "relation_test.go"), spec.test);
