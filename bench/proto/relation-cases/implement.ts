// Two tool-less Haiku implement sessions on a fixture with the relation cases sealed (read-only, must pass), scored by the
// fixture's private oracle, the sealed cases and the repo's own tests. Usage: bun implement.ts <fixture-dir> <work-dir> <n>
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { goPackageFiles, parseRel, relationSpec, sealedTest } from "./relation.ts";
import { haikuCli, type Transcript } from "../haiku_cli.ts";
const [fxArg, workArg, nArg] = process.argv.slice(2) as [string, string, string];
const fx = resolve(fxArg), work = resolve(workArg); mkdirSync(work, { recursive: true });
const repo = join(fx, "repo"), issue = readFileSync(join(fx, "issue.md"), "utf8"), files = goPackageFiles(repo), pkg = /^package (\w+)/m.exec(Object.values(files)[0]!)![1]!;
const env = { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local" };
const go = (d: string, a: string[]) => { const r = spawnSync("go", a, { cwd: d, encoding: "utf8", env, timeout: 180_000 }); return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` }; };
const spec = relationSpec(issue, files, pkg)!;
const b = join(work, "base"); cpSync(repo, b, { recursive: true }); writeFileSync(join(b, "zz_loki_relation_test.go"), spec.test);
const sealed = sealedTest(spec, parseRel(go(b, ["test", "-count=1", "-run", "^TestLokiRelation$", "-v", "."]).out), pkg);
writeFileSync(join(work, "sealed_relation_test.go"), sealed);
const transcripts: Transcript[] = [], llm = haikuCli(work, transcripts, { effort: "low" });
const SYS = "You are a software engineer fixing a GitHub issue. Output only the changed files, each as the line FILE <path> followed by one fenced code block with the file's complete new content.";
const srcs = [...Object.entries(files), ...[["handle_test.go", readFileSync(join(repo, "handle_test.go"), "utf8")] as const]];
const prompt = [`ISSUE:\n${issue}`, ...srcs.map(([p, s]) => `FILE ${p}:\n${s}`), `HARNESS TEST (read-only; it must pass; never edit it). zz_loki_relation_test.go:\n${sealed}`, "Fix the issue. Keep the change small; the package, its tests and the harness test must pass."].join("\n\n");
const rows = [];
for (let n = 1; n <= Number(nArg); n++) {
  const t = await llm(SYS, prompt), d = join(work, `s${n}`); cpSync(repo, d, { recursive: true });
  for (const m of t.text.matchAll(/FILE\s+`?([\w./-]+\.go)`?\s*:?\s*\n+```(?:go)?\n([\s\S]*?)```/g)) if (!m[1]!.includes("zz_")) writeFileSync(join(d, m[1]!), m[2]!);
  const own = go(d, ["test", "-count=1", "-run", "^Test(Report|ExitCoder|Handle)", "."]).ok;
  writeFileSync(join(d, "zz_loki_relation_test.go"), sealed); const rel = go(d, ["test", "-count=1", "-run", "^TestLokiRelation$", "."]);
  cpSync(join(fx, "oracle_test.go"), join(d, "zz_oracle_test.go")); const oracle = go(d, ["test", "-count=1", "-run", "^TestOracle", "."]).ok;
  rows.push({ n, ownTests: own, relation: rel.ok, oracle, costUsd: t.usage.costUsd, outTok: t.usage.outTok, relErr: rel.ok ? "" : rel.out.split("\n").filter((l) => /got|want|FAIL|error/.test(l)).slice(0, 4) });
}
const summary = { calls: transcripts.length, costUsd: transcripts.reduce((a, t) => a + t.usage.costUsd, 0), oracle: `${rows.filter((r) => r.oracle).length}/${rows.length}`, relation: `${rows.filter((r) => r.relation).length}/${rows.length}` };
writeFileSync(join(work, "report.json"), JSON.stringify({ summary, rows }, null, 2)); writeFileSync(join(work, "transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ summary, rows }, null, 1));
