// PROTOTYPE probe for util/site_ledger.ts. Usage:
//   bun scripts/site_ledger_probe.ts <fixtureDir> <workDir> ledger              -> prints the ledger and micro briefs, no model
//   bun scripts/site_ledger_probe.ts <fixtureDir> <workDir> stub <replies.json> -> replies.json: {"<task id>": ["first reply", "re-ask reply"]}
//   bun scripts/site_ledger_probe.ts <fixtureDir> <workDir> haiku [model]        -> one `claude -p` call per micro-task, no tools
//   bun scripts/site_ledger_probe.ts <fixtureDir> <workDir> whole [model]        -> baseline: ONE call with the whole task and the whole files, same reply format, no ledger
// workDir must not exist; the fixture is copied there and git-initialised. Prints one JSON summary line last.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLedger, integrationFindings, microBrief, parseReply, runLedger, twinGroups, type MicroCall } from "../src/util/site_ledger.ts";

const [fixture, work, mode, arg] = process.argv.slice(2);
if (!fixture || !work || !mode || existsSync(work)) { console.error("usage: <fixtureDir> <workDir(not existing)> ledger|stub|haiku|whole [arg]"); process.exit(64); }
cpSync(fixture, work, { recursive: true });
const sh = (cmd: string, args: string[], timeoutMs = 120_000) => spawnSync(cmd, args, { cwd: work, encoding: "utf8", timeout: timeoutMs });
sh("git", ["init", "-q"]); sh("git", ["add", "."]); sh("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "base"]);
const task = readFileSync(join(work, "TASK.md"), "utf8");
const usage = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 };

function claude(brief: string, model: string): string {
  const r = spawnSync("claude", ["-p", "--model", model, "--tools", "", "--output-format", "json", "--strict-mcp-config", "--system-prompt", "You are a careful senior engineer. Follow the reply format exactly."], { input: brief, encoding: "utf8", timeout: 180_000, cwd: work, env: { ...process.env } });
  usage.calls++;
  try {
    const j = JSON.parse(r.stdout);
    usage.cost_usd += j.total_cost_usd ?? 0; const u = j.usage ?? {};
    usage.input_tokens += u.input_tokens ?? 0; usage.output_tokens += u.output_tokens ?? 0; usage.cache_read += u.cache_read_input_tokens ?? 0; usage.cache_write += u.cache_creation_input_tokens ?? 0;
    writeFileSync(join(work, `.reply-${usage.calls}.txt`), String(j.result ?? ""));
    return String(j.result ?? "");
  } catch { writeFileSync(join(work, `.reply-${usage.calls}.err`), r.stdout + "\n" + r.stderr); return ""; }
}

const checks = () => {
  const vet = sh("go", ["vet", "./..."]), test = sh("go", ["test", "./..."]);
  return { vet: vet.status, test: test.status, out: (vet.stderr + test.stdout).slice(-600) };
};
const accept = () => {
  const dir = join(fixture, "..", "accept"), name = readdirSync(dir).find((f) => f.startsWith(fixture.replace(/\/$/, "").split("/").pop()! + "_"));
  if (!name) return null;
  cpSync(join(dir, name), join(work, name));
  const r = sh("go", ["test", "./..."]);
  return { status: r.status, fails: (r.stdout.match(/--- FAIL: \w+/g) ?? []) };
};

if (mode === "ledger") {
  const tasks = buildLedger(work, task), twins = twinGroups(tasks);
  for (const t of tasks) console.log(`== ${t.id} lines ${t.start}-${t.end}\n` + microBrief(task, t, tasks.filter((o) => o !== t), twins) + "\n");
  console.log(JSON.stringify({ tasks: tasks.map((t) => ({ id: t.id, sites: t.sites.map((s) => s.line), siblings: t.siblingNotes.length })), twins: twins.map((g) => g.members) }));
  process.exit(0);
}
if (mode === "whole") {
  const model = arg ?? "haiku", tasks = buildLedger(work, task);
  const files = [...new Set(tasks.map((t) => t.path))];
  const brief = [`Task:\n${task}`, ...files.map((f) => `File ${f}:\n${readFileSync(join(work, f), "utf8")}`), "Reply with each changed function in its own ```go fence (complete function), IMPORT <path> lines for new imports, and one ```test fence with a new test function."].join("\n\n");
  const reply = claude(brief, model);
  console.log(reply);
  console.log(JSON.stringify({ mode, usage }));
  process.exit(0);
}
let micro: MicroCall;
if (mode === "stub") {
  const replies = JSON.parse(readFileSync(arg!, "utf8")) as Record<string, string[]>, seen = new Map<string, number>();
  micro = async (_b, t) => { const n = seen.get(t.id) ?? 0; seen.set(t.id, n + 1); usage.calls++; return replies[t.id]?.[Math.min(n, replies[t.id]!.length - 1)] ?? ""; };
} else {
  const model = arg ?? "haiku";
  micro = async (b, t) => { writeFileSync(join(work, `.brief-${t.fn}-${usage.calls + 1}.txt`), b); return claude(b, model); };
}
const run = await runLedger(work, task, micro);
sh("gofmt", ["-w", "."]);
const c = checks(), a = accept();
console.log(JSON.stringify({ mode, tasks: run.tasks.map((t) => t.id), rounds: run.rounds, calls: run.calls, first_findings: run.findings, residual: run.residual, checks: { vet: c.vet, test: c.test }, accept: a, usage, tail: c.test ? c.out : undefined }));
void integrationFindings; void parseReply;
