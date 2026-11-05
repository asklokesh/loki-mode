// Harm of a false fire, measured directly (judge round 2, item d): on the real commit where round 2 fired (go-humanize #105,
// CommafWithDigits(+Inf, 2) changed), the fix brief goes to ONE tool-less Haiku edit call, then the MAINTAINER'S own tests at
// the commit (a stand-in for hidden tests) run on the result. Pass: the false fire cost money, not accuracy.
// Usage: bun harm.ts <repos-dir> <work-dir>
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { nrdFailureGroups, runNoRegression, SYS_NRD_JUDGE, type NrdIo, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import { extractProgram, runGoProbe } from "../../../loki-ts/src/features/probes.ts";
import { buildFixBrief } from "../../../loki-ts/src/engine10/stages/fix.ts";
import { applyEdits, parseCandidates, type LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { haikuCli, ZERO_USAGE, type Transcript } from "../haiku_cli.ts";

const [reposArg, workArg] = process.argv.slice(2) as [string, string];
const repos = resolve(reposArg), work = resolve(workArg), here = import.meta.dir; mkdirSync(work, { recursive: true });
const c = (JSON.parse(readFileSync(join(here, "fp", "commits.json"), "utf8")) as { commits: { id: string; dir: string; sha: string; file: string; issue: string }[] }).commits.find((x) => x.id === "humanize-105")!;
const clone = join(repos, c.dir), git = (...a: string[]) => execFileSync("git", ["-C", clone, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const tree = join(work, "tree"); mkdirSync(tree, { recursive: true }); execFileSync("sh", ["-c", `git -C "$1" archive "$2^" | tar -x -C "$3"`, "sh", clone, c.sha, tree]);
const base = git("show", `${c.sha}^:${c.file}`), patched = git("show", `${c.sha}:${c.file}`);
const env = { GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };
// round 2's recorded program (task 7 of the batched reply) and its judge verdicts
const tr = JSON.parse(readFileSync(join(here, "results", "fp-haiku-run1-transcripts.json"), "utf8")) as { system: string; text: string }[];
const parts = tr.find((t) => !t.system.startsWith("You decide"))!.text.split(/^=== TASK (\d+) ===\s*$/m); let program = "";
for (let i = 1; i + 1 < parts.length; i += 2) if (parts[i] === "7") program = extractProgram(parts[i + 1]!);
const rep = JSON.parse(readFileSync(join(here, "results", "fp-haiku-run1-report.json"), "utf8")) as { rows: { id: string; findings?: { id: string; verdict: Verdict; before: string; after: string }[] }[] };
const verdicts = new Map((rep.rows.find((r) => r.id === "humanize-105")!.findings ?? []).map((f) => [`${f.id}\u0000${f.before}\u0000${f.after}`, f.verdict] as [string, Verdict]));
const file = join(tree, c.file);
let current = patched;
const io: NrdIo = { run: (st, p) => { writeFileSync(file, st === "base" ? base : current); return { ...runGoProbe({ moduleRoot: tree, pkgDir: ".", pkg: "humanize", program: p, env }), roots: [tree] }; } };
const never: LlmCall = async (s) => { if (s === SYS_NRD_JUDGE) return { text: "", usage: ZERO_USAGE }; throw new Error("no probe call"); };
const ctx = { issue: c.issue, lang: "go" as const, pkg: "humanize", files: {}, tests: {} };
// round 2 had no edge rule: its unrequested findings block here even where round 3 would only advise (that is the harm being measured)
const raw = await runNoRegression(ctx, never, io, { program, verdicts }), unreq = (r: typeof raw) => r.findings.filter((f) => f.verdict === "unrequested");
const before = { ...raw, blocking: unreq(raw), groups: nrdFailureGroups(unreq(raw), raw.program) };
writeFileSync(file, patched);
const brief = buildFixBrief(c.issue, before.groups, spawnSync("sh", ["-c", `printf '%s' "$1" | diff -u - "$2"`, "sh", base, file], { encoding: "utf8" }).stdout);
const transcripts: Transcript[] = [], llm = haikuCli(work, transcripts, { effort: "low" });
const prompt = [brief, `FILE ${c.file} (as your change left it):\n${patched}`, `You cannot run tools. Answer with the edits only, in this format:\n=== CANDIDATE 1 ===\n<<<<<<< SEARCH ${c.file}\n<exact lines from the file>\n=======\n<replacement lines>\n>>>>>>> REPLACE\nSEARCH text must match the file exactly and be unique. Do not edit tests.`].join("\n\n");
const reply = before.blocking.length ? await llm("You fix code. Output only the requested edit blocks, no prose.", prompt) : { text: "" };
const next = applyEdits({ [c.file]: patched }, parseCandidates(reply.text)[0]?.edits ?? []);
current = next?.[c.file] ?? patched;
const afterRaw = await runNoRegression(ctx, never, io, { program, verdicts }), after = { blocking: unreq(afterRaw) };
writeFileSync(file, current);
// the maintainer's own tests AT the commit, as the hidden-test stand-in
for (const f of git("diff", "--name-only", `${c.sha}^`, c.sha).split("\n").filter((x) => x.endsWith("_test.go"))) writeFileSync(join(tree, f), git("show", `${c.sha}:${f}`));
const maint = spawnSync("go", ["test", "-count=1", "-vet=off", "."], { cwd: tree, encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000 });
writeFileSync(file, patched); const maintOnCommit = spawnSync("go", ["test", "-count=1", "-vet=off", "."], { cwd: tree, encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000 }).status === 0;
const out = { commit: c.id, blocking_before: before.blocking.map((f) => `${f.id} ${f.before} -> ${f.after}`), edits_applied: !!next, blocking_after: after.blocking.map((f) => f.id), maintainer_tests_on_commit: maintOnCommit, maintainer_tests_after_fix: maint.status === 0, failing: (maint.stdout ?? "").split("\n").filter((l) => /--- FAIL|_test\.go:\d+/.test(l)).slice(0, 6), costUsd: transcripts.reduce((a, t) => a + t.usage.costUsd, 0), calls: transcripts.length };
writeFileSync(join(work, "harm-report.json"), JSON.stringify({ ...out, brief, reply: reply.text }, null, 2)); writeFileSync(join(work, "harm-transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify(out, null, 1));
