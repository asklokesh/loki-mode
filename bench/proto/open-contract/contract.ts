// Round 3 experiment for open-contract misses: does a precedent VOTE (one narrow tool-less call over the sibling code, turned into
// an "implement option k" line) move real Haiku where the precedent PROSE of PR 526 did not? Arms, on a fixture outside the corpus:
//   prose: today's LOKI_E10_PRECEDENT=1 line (sibling hint plus "keep every existing test true"), 2 implement calls
//   vote:  2 vote calls, then the decided line, 2 implement calls
// Each implement answer is scored by the fixture's oracle test (the choice this fixture's maintainer made), never shown to a prompt.
// Usage: bun contract.ts <fixture-dir> <work-dir> haiku|dry
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { detectOpenChoices, emitChoiceLines, parsePrecedentVote, precedentVotePrompt, resolveChoices, siblingBodies, SYS_PRECEDENT_VOTE } from "../../../loki-ts/src/features/spec_ambiguity.ts";
import { haikuCli, type Transcript } from "../haiku_cli.ts";

const [fxArg, workArg, mode] = process.argv.slice(2) as [string, string, string];
const fx = resolve(fxArg), work = resolve(workArg);
mkdirSync(work, { recursive: true });
const sh = (cwd: string, cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 180_000 }); return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` }; };
const repo = join(work, "repo"); cpSync(join(fx, "repo"), repo, { recursive: true });
sh(repo, "git", ["init", "-q", "-b", "main"]); sh(repo, "git", ["add", "-A"]); sh(repo, "git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-qm", "base"]);
const issue = readFileSync(join(fx, "issue.md"), "utf8");
const srcFiles = (dir: string, base = ""): string[] => readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === ".git" ? [] : srcFiles(dir, join(base, e.name))) : e.name.endsWith(".go") ? [join(base, e.name)] : []);
const files = srcFiles(repo);
const transcripts: Transcript[] = [];
const llm = haikuCli(work, transcripts, { effort: "low" });

process.env["LOKI_E10_PRECEDENT"] = "1";
const prose = resolveChoices(issue, { repoDir: repo });
const proseLines = emitChoiceLines(prose);
const choice = detectOpenChoices(issue)[0]!;
const siblings = siblingBodies(prose[0]?.precedent ?? "", repo);
const SYS_IMPL = "You are a software engineer fixing a GitHub issue. Output only the changed files, each as the line FILE <path> followed by one fenced code block with the file's complete new content.";
const implPrompt = (lines: string[]) => [`ISSUE:\n${issue}`, ...(lines.length ? [`ASSUMPTIONS (from the harness):\n${lines.join("\n")}`] : []), ...files.map((f) => `FILE ${f}:\n${readFileSync(join(repo, f), "utf8")}`), "Fix the issue. Keep the change small and keep the package compiling and its tests passing."].join("\n\n");
if (mode === "dry") { console.log(JSON.stringify({ prose: prose.map((p) => ({ basis: p.basis, picked: p.picked })), proseLines, siblings, votePrompt: precedentVotePrompt(choice, siblings) }, null, 1)); process.exit(0); }

async function implement(arm: string, n: number, lines: string[]) {
  const t = await llm(SYS_IMPL, implPrompt(lines)), dir = join(work, `${arm}-${n}`);
  cpSync(repo, dir, { recursive: true });
  for (const m of t.text.matchAll(/FILE\s+`?([\w./-]+\.go)`?\s*:?\s*\n+```(?:go)?\n([\s\S]*?)```/g)) writeFileSync(join(dir, m[1]!), m[2]!);
  const own = sh(dir, "go", ["test", "-count=1", "./..."]);
  cpSync(join(fx, "oracle", "oracle_test.go"), join(dir, "settings", "zz_oracle_test.go"));
  const oracle = sh(dir, "go", ["test", "-count=1", "-run", "Oracle", "./..."]);
  const valueReturns = /func \(s DurationSetting\) Value\(\) (\S+)/.exec(readFileSync(join(dir, "settings", "settings.go"), "utf8"))?.[1] ?? "?";
  return { arm, n, ownTestsPass: own.ok, oracle: oracle.ok, valueReturns, costUsd: t.usage.costUsd, outTok: t.usage.outTok };
}
const rows = [];
for (let n = 1; n <= 2; n++) rows.push(await implement("prose", n, proseLines));
const votes: (number | null)[] = [];
for (let n = 1; n <= 2; n++) { const v = await llm(SYS_PRECEDENT_VOTE, precedentVotePrompt(choice, siblings)); votes.push(parsePrecedentVote(v.text, choice.options.length)); }
const decided = resolveChoices(issue, { repoDir: repo, votes: [votes[0] ?? null] }), voteLines = emitChoiceLines(decided);
for (let n = 1; n <= 2; n++) rows.push(await implement("vote", n, voteLines));
const cost = transcripts.reduce((a, t) => a + t.usage.costUsd, 0);
const summary = { calls: transcripts.length, costUsd: cost, votes, prose_oracle: `${rows.filter((r) => r.arm === "prose" && r.oracle).length}/2`, vote_oracle: `${rows.filter((r) => r.arm === "vote" && r.oracle).length}/2` };
writeFileSync(join(work, "report.json"), JSON.stringify({ summary, rows, proseLines, voteLines, siblings }, null, 2));
writeFileSync(join(work, "transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ summary, rows, proseLines, voteLines }, null, 1));
