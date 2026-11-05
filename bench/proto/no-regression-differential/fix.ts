// Closes the loop on one blocking finding: the fix brief the differential produced goes to ONE tool-less Haiku call that
// answers with SEARCH/REPLACE edits (the tournament's format), then the differential reruns with the same probe program and
// verdicts (no call), the visible tests run, and the private oracle scores the result. Usage:
//   bun fix.ts <fixture-dir> <variant> <report.json> <work-dir> haiku|replay [transcripts.json]
// <report.json> is a run.ts report for the fixture: its probe program and judge verdicts are reused unchanged.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runNoRegression, SYS_NRD_JUDGE, type NrdContext, type NrdIo, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import { runGoProbe } from "../../../loki-ts/src/features/probes.ts";
import { buildFixBrief } from "../../../loki-ts/src/engine10/stages/fix.ts";
import { applyEdits, parseCandidates, type LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { haikuCli, replayCalls, ZERO_USAGE, type Transcript } from "../haiku_cli.ts";
import { HERMETIC_GO_ENV, sh, treeIo } from "./tree_io.ts";

const [fxArg, variant, reportArg, workArg, mode, canned] = process.argv.slice(2) as [string, string, string, string, string, string | undefined];
const fixture = resolve(fxArg), work = resolve(workArg);
const report = JSON.parse(readFileSync(reportArg, "utf8")) as { program: string; judged: { label: string; before: string; after: string; verdict: Verdict }[] };
const pkgDir = /^package (\w+)/m.exec(report.program)![1]!, file = `${pkgDir}/${pkgDir}.go`;
const issue = readFileSync(join(fixture, "issue.md"), "utf8");
const ctx: NrdContext = { issue, lang: "go", pkg: pkgDir, files: {}, tests: {} };
const verdicts = new Map(report.judged.map((j) => [`${j.label.split("#")[0]}\u0000${j.before}\u0000${j.after}`, j.verdict] as [string, Verdict]));
const noJudge: LlmCall = async (system, user) => { if (system === SYS_NRD_JUDGE) return { text: "", usage: ZERO_USAGE }; throw new Error(`unexpected call: ${user.slice(0, 60)}`); };
mkdirSync(work, { recursive: true });

const io = treeIo(join(fixture, "repo"), join(work, "tree"), join(fixture, "variants", `${variant}.patch`), { pkgDir, pkg: pkgDir });
const before = await runNoRegression(ctx, noJudge, io, { program: report.program, verdicts });
if (before.blocking.length === 0) { console.log(JSON.stringify({ variant, note: "no blocking finding to fix" })); process.exit(0); }
const current = readFileSync(join(io.dir, file), "utf8"), base = readFileSync(join(fixture, "repo", file), "utf8");
const diff = sh(work, "diff", ["-u", join(fixture, "repo", file), join(io.dir, file)]).out.replace(join(fixture, "repo") + "/", "a/").replace(io.dir + "/", "b/");
const brief = buildFixBrief(issue, before.groups, diff);
const prompt = [brief, `FILE ${file} (as your change left it):\n${current}`, `You cannot run tools. Answer with the edits only, in this format:\n=== CANDIDATE 1 ===\n<<<<<<< SEARCH ${file}\n<exact lines from the file>\n=======\n<replacement lines>\n>>>>>>> REPLACE\nSEARCH text must match the file exactly and be unique. Do not edit tests.`].join("\n\n");
const transcripts: Transcript[] = [];
const llm: LlmCall = mode === "replay" ? replayCalls(canned!, transcripts) : haikuCli(work, transcripts, { effort: "low" });
const reply = await llm("You fix code. Output only the requested edit blocks, no prose.", prompt);
const edits = parseCandidates(reply.text)[0]?.edits ?? [];
const next = applyEdits({ [file]: current }, edits);
let applied = false;
if (next) { writeFileSync(join(io.dir, file), next[file]!); applied = true; }
const fixed = next?.[file] ?? current;
// the re-check runs in the same tree with the file written directly for each state (no git apply), program and verdicts reused
const direct: NrdIo = { run: (st, p) => { writeFileSync(join(io.dir, file), st === "base" ? base : fixed); return { ...runGoProbe({ moduleRoot: io.dir, pkgDir, pkg: pkgDir, program: p, env: HERMETIC_GO_ENV }), roots: [io.dir] }; } };
const after = await runNoRegression(ctx, noJudge, direct, { program: report.program, verdicts });
writeFileSync(join(io.dir, file), fixed);
const visible = sh(io.dir, "go", ["test", "-count=1", `./${pkgDir}`], HERMETIC_GO_ENV).ok;
const oracleFile = join(io.dir, pkgDir, "zz_oracle_test.go");
copyFileSync(join(fixture, "oracle", "oracle_test.go"), oracleFile);
const oracle = sh(io.dir, "go", ["test", "-count=1", "-run", "Oracle", `./${pkgDir}`], HERMETIC_GO_ENV).ok;
rmSync(oracleFile, { force: true });
const out = { variant, blocking_before: before.blocking.map((f) => f.id), edits: edits.length, applied, blocking_after: after.blocking.map((f) => f.id), requested_change_kept: after.cases.filter((c) => c.status === "changed" && c.kind !== "keep").map((c) => c.id), new_unjudged: after.findings.filter((f) => f.verdict === "unknown").map((f) => f.id), visible_tests: visible, oracle, cost: transcripts.reduce((a, t) => a + t.usage.costUsd, 0), usage: transcripts.map((t) => t.usage) };
writeFileSync(join(work, "fix-report.json"), JSON.stringify({ ...out, brief, reply: reply.text }, null, 2));
writeFileSync(join(work, "fix-transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify(out, null, 1));
