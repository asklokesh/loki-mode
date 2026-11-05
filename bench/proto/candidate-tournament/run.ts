// Experiment driver for the candidate-tournament prototype. Usage:
//   bun run.ts <fixture-dir> <work-dir> stub <canned.json>
//   bun run.ts <fixture-dir> <work-dir> haiku
// <fixture-dir> holds repo/ (what the tournament sees), issue.md, and oracle.test.mjs (scored only after the pick,
// never shown to any prompt). <work-dir> must be a run-owned temp dir; every scratch tree goes under it.
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { applyEdits, runTournament, type Context, type Edit, type Io, type LlmCall, type Usage } from "../../../loki-ts/src/features/tournament.ts";

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
    writeFileSync(join(dir, "__probe.mjs"), program);
    const r = spawnSync("node", ["__probe.mjs"], { cwd: dir, timeout: 20_000, encoding: "utf8" });
    return r.stdout ?? "";
  },
  oracle(dir) {
    cpSync(join(fixture, "oracle.test.mjs"), join(dir, "__oracle.test.mjs"));
    const r = spawnSync("node", ["--test", "__oracle.test.mjs"], { cwd: dir, timeout: 30_000, encoding: "utf8" });
    return r.status === 0;
  },
};

const zero: Usage = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
const transcripts: { system: string; user: string; text: string; usage: Usage }[] = [];
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
} else {
  llm = async (system, user) => {
    const pf = join(work, `prompt${transcripts.length}-${Date.now()}.txt`);
    writeFileSync(pf, user);
    const args = ["-p", "--model", "claude-haiku-5-5", "--system-prompt", system, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json"];
    const r = await new Promise<{ out: string; code: number | null }>((res) => {
      const p = spawn("claude", args, { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
      let out = ""; p.stdout.on("data", (b: Buffer) => (out += b.toString()));
      const t = setTimeout(() => p.kill("SIGTERM"), 240_000);
      p.on("close", (code) => { clearTimeout(t); res({ out, code }); });
      p.stdin.end(readFileSync(pf));
    });
    const j = JSON.parse(r.out) as { result: string; total_cost_usd: number; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
    const usage: Usage = { inTok: j.usage.input_tokens, outTok: j.usage.output_tokens, cacheRead: j.usage.cache_read_input_tokens ?? 0, cacheWrite: j.usage.cache_creation_input_tokens ?? 0, costUsd: j.total_cost_usd };
    transcripts.push({ system, user, text: j.result, usage });
    return { text: j.result, usage };
  };
}

mkdirSync(work, { recursive: true });
const res = await runTournament(ctx, llm, io);
const rows = res.entrants.map((e) => ({ id: e.id, checks: e.checksPass, oracle: e.dir ? io.oracle(e.dir) : false, diffLines: e.diffLines, score: res.pick.scores[e.id] ?? null }));
const total = res.usage.reduce((a, u) => ({ inTok: a.inTok + u.inTok, outTok: a.outTok + u.outTok, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite, costUsd: a.costUsd + u.costUsd }), zero);
const report = { fixture, mode, pick: res.pick, winnerOracle: rows.find((r) => r.id === res.pick.winner)?.oracle ?? false, entrants: rows, probes: res.probes.length, disagreements: res.disagreements, verdicts: res.verdicts, baseRun: res.baseRun, calls: res.calls, usage: res.usage, total };
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(work, "transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ pick: res.pick, winnerOracle: report.winnerOracle, entrants: rows, probes: report.probes, disagreements: res.disagreements.length, verdicts: res.verdicts, calls: res.calls, total }, null, 1));
