// Real Haiku measurement, one mode per call. Usage: bun real_run.ts <baseline|diet> <scratch dir> [model]
// baseline: today's implement session shape (lean system prompt, ENGINE10 tool set, buildImplementBrief with the dossier as its
// context pack, medium effort). diet: features/token_diet.ts runDiet (no tools, same dossier, harness check, up to 3 rounds).
// Both get the identical dossier, so the measured difference is the session architecture, not the context.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { LEAN_PREFIX } from "../../src/features/lean_prefix.ts";
import { buildPatchBrief, claudeCall, dossier, runDiet } from "../../src/features/token_diet.ts";

const [mode, scratch, model = "claude-haiku-5-5", which = ""] = process.argv.slice(2) as [string, string, string?, string?];
const sfx = which ? `-${which}` : "", sfxU = which ? `_${which}` : "";
const here = import.meta.dir, repo = join(scratch, `${mode}${sfx}`);
cpSync(join(here, "argkit"), repo, { recursive: true });
const git = (...a: string[]): void => { spawnSync("git", a, { cwd: repo, stdio: "ignore" }); };
git("init", "-q"); git("add", "-A"); git("-c", "user.name=fixture", "-c", "user.email=f@x", "commit", "-qm", "base");
const task = readFileSync(join(here, `task${sfx}.md`), "utf8");
const CHECK = "node --test test/*.test.js";
const dz = dossier(repo, task, CHECK);
let usage, extra: Record<string, unknown> = {};
const t0 = Date.now();
if (mode === "baseline") {
  const brief = buildImplementBrief(task, null, ["test/parse.test.js"], `Code that matters (current contents; edit directly and read other files only when needed):\n${dz.text}`);
  writeFileSync(join(scratch, `baseline${sfx}.brief.txt`), brief);
  const r = await claudeCall(repo, model, { tools: "Bash,Read,Edit,Write,Glob,Grep", system: LEAN_PREFIX, timeoutS: 480 })(brief);
  usage = r.usage; extra = { tail: r.text.slice(-200), session: r.sessionId };
} else {
  const brief = buildPatchBrief(task, dz.text);
  writeFileSync(join(scratch, `diet${sfx}.brief.txt`), brief);
  const r = await runDiet({ repoDir: repo, brief, checkCmd: CHECK, call: claudeCall(repo, model, { tools: "", system: LEAN_PREFIX, timeoutS: 300 }) });
  usage = r.usage; extra = { status: r.status, rounds: r.rounds, log: r.log, session: r.sessionId };
}
const own = spawnSync("bash", ["-c", CHECK], { cwd: repo, encoding: "utf8" });
const oracle = spawnSync("node", [join(here, `hidden_check${sfxU}.mjs`), repo], { encoding: "utf8" });
const diff = spawnSync("git", ["diff", "--stat"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const priced = usage.input * 0.1e-6 + usage.output * 0.5e-6 + usage.cacheRead * 0.01e-6 + usage.cacheCreate * 0.125e-6; // the per-token rates that reproduce the bench ledger's haiku dollars
console.log(JSON.stringify({ mode, model, seconds: Math.round((Date.now() - t0) / 1000), usage, priced_usd: Number(priced.toFixed(5)), own_tests: own.status === 0, oracle: oracle.status === 0, oracle_detail: oracle.stdout.trim(), diff, ...extra }, null, 1));
