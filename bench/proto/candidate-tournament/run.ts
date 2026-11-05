// Experiment driver for the candidate-tournament prototype. Usage:
//   bun run.ts <fixture-dir> <work-dir> stub <canned.json>
//   bun run.ts <fixture-dir> <work-dir> haiku
// <fixture-dir> holds repo/ (what the tournament sees), issue.md, and oracle.test.mjs (scored only after the pick,
// never shown to any prompt). <work-dir> must be a run-owned temp dir; every scratch tree goes under it.
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyEdits, runTournament, type Context, type Edit, type Io, type LlmCall, type Usage } from "../../../loki-ts/src/features/tournament.ts";
import { runNodeProbe } from "../../../loki-ts/src/features/probes.ts";
import { haikuCli, replayCalls, type Transcript } from "../haiku_cli.ts";

const [fixture, work, mode, canned] = process.argv.slice(2) as [string, string, string, string | undefined];
const repo = join(fixture, "repo");
const names = readdirSync(repo);
const files: Record<string, string> = {}, tests: Record<string, string> = {};
for (const n of names) (n.includes(".test.") ? tests : files)[n] = readFileSync(join(repo, n), "utf8");
const ctx: Context = { issue: readFileSync(join(fixture, "issue.md"), "utf8"), files, tests, lang: "JavaScript (ES module, Node 22+)" };

let seq = 0;
const io: Io & { oracle(dir: string): boolean } = {
  materialize(edits) {
    const next = edits === "agent" ? null : applyEdits(files, edits as Edit[]);
    if (!next) return null;
    const dir = join(work, `tree${seq++}`);
    cpSync(repo, dir, { recursive: true });
    for (const [p, s] of Object.entries(next)) writeFileSync(join(dir, p), s);
    return dir;
  },
  checks(dir) {
    const r = spawnSync("node", ["--test", ...Object.keys(tests)], { cwd: dir, timeout: 30_000, encoding: "utf8" });
    return r.status === 0;
  },
  probe(dir, program) {
    return runNodeProbe(dir, program).stdout;
  },
  oracle(dir) {
    cpSync(join(fixture, "oracle.test.mjs"), join(dir, "__oracle.test.mjs"));
    const r = spawnSync("node", ["--test", "__oracle.test.mjs"], { cwd: dir, timeout: 30_000, encoding: "utf8" });
    return r.status === 0;
  },
};

const zero: Usage = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
const transcripts: Transcript[] = [];
let llm: LlmCall;
if (mode === "stub") {
  const c = JSON.parse(readFileSync(canned!, "utf8")) as { candidates: string; probes: string; truth: Record<string, string> };
  llm = async (system, user) => {
    const key = system.includes("patches") ? "candidates" : system.includes("probe") ? "probes" : "judge";
    // stub judge: answers from the canned truth map by matching the option outputs printed in the prompt
    const judge = (): string => {
      const lines: string[] = []; let cur = "";
      for (const l of user.split("\n")) {
        const pm = /^PROBE (\S+):/.exec(l); if (pm) { cur = pm[1]!; lines.push(`${cur}: unknown`); continue; }
        const om = /^  option ([A-Z]): (.*)$/.exec(l);
        if (om && cur && c.truth[cur] === om[2]) lines[lines.length - 1] = `${cur}: ${om[1]}`;
      }
      return lines.join("\n");
    };
    const text = key === "judge" ? judge() : c[key];
    transcripts.push({ system, user, text, usage: zero });
    return { text, usage: zero };
  };
} else if (mode === "replay") {
  llm = replayCalls(canned!, transcripts); // zero-cost re-score of the texts an earlier real run recorded
} else {
  llm = haikuCli(work, transcripts);
}

mkdirSync(work, { recursive: true });
const res = await runTournament(ctx, llm, io);
const rows = res.entrants.map((e) => ({ id: e.id, checks: e.checksPass, oracle: e.dir ? io.oracle(e.dir) : false, diffLines: e.diffLines, score: res.pick.scores[e.id] ?? null }));
const total = res.usage.reduce((a, u) => ({ inTok: a.inTok + u.inTok, outTok: a.outTok + u.outTok, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite, costUsd: a.costUsd + u.costUsd }), zero);
const report = { fixture, mode, pick: res.pick, winnerOracle: rows.find((r) => r.id === res.pick.winner)?.oracle ?? false, entrants: rows, probes: res.probes.length, disagreements: res.disagreements, verdicts: res.verdicts, baseRun: res.baseRun, calls: res.calls, usage: res.usage, total };
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(work, "transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ pick: res.pick, winnerOracle: report.winnerOracle, entrants: rows, probes: report.probes, disagreements: res.disagreements.length, verdicts: res.verdicts, calls: res.calls, total }, null, 1));
