// Lab for util/harness_rules.ts (prototype). Builds temp git fixtures shaped like the failure classes seen in Loki's own receipts,
// runs a mini harness on them with a STUB provider (deterministic agent and fixer), and drives the full loop:
// baseline on TRAIN -> mine -> paired validation on HELD-BACK -> select -> LIVE with harm monitor and rollback -> re-validate
// with the harmed live shapes added -> final paired comparison on an untouched TEST set.
// The mini harness uses the real commit-stage filter (e10ext/commit_filter.ts dropSet). Usage: bun scripts/harness-rules-lab.ts <tmpdir>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dropSet, parseStaged } from "../src/e10ext/commit_filter.ts";
import { excuse, judge, keptFlags, mine, nameClass, observe, select, wipDrops, type Outcome, type Rule, type RunFacts, type Writer } from "../src/util/harness_rules.ts";

const ROOT = process.argv[2] ?? "";
if (!ROOT || !existsSync(ROOT)) { console.error("usage: harness-rules-lab.ts <existing run-owned tmp dir>"); process.exit(64); }
const IMPL_USD = 0.0116, FIX_USD = Number(process.env["LAB_FIX_USD"] ?? 0.0089); // L-Haiku-v131 per-run means (HAIKU-PLAN section 3); fix calibrated by one real Haiku round
const GENV = { ...process.env, GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@x", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@x", GIT_CONFIG_NOSYSTEM: "1", HOME: ROOT };
const git = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd, env: GENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface Check { name: string; kind: string; cmd: string }
interface Fx {
  id: string; repo: string; eco: string; shape: string; task: string;
  base: Record<string, string>; ignore: string[];
  edits: Record<string, string>; effects: Record<string, string>;
  checks: Check[]; hidden: string; intended: string[];
  fix: Record<string, Record<string, string>>; // check name -> files the stub fixer writes when that check is sent to it
}

// ---- fixture generator --------------------------------------------------------------------------------------------------
const ECO: Record<string, { lock: string; manifest: string; cfg: string; kind: string }> = {
  pnpm: { lock: "pnpm-lock.yaml", manifest: "package.json", cfg: "tsconfig.json", kind: "tsc" },
  npm: { lock: "package-lock.json", manifest: "package.json", cfg: "tsconfig.json", kind: "tsc" },
  yarn: { lock: "yarn.lock", manifest: "package.json", cfg: "eslint.config.js", kind: "eslint" },
  bun: { lock: "bun.lock", manifest: "package.json", cfg: "tsconfig.json", kind: "tsc" },
  cargo: { lock: "Cargo.lock", manifest: "Cargo.toml", cfg: "setup.cfg", kind: "clippy" },
  poetry: { lock: "poetry.lock", manifest: "pyproject.toml", cfg: "mypy.ini", kind: "mypy" },
  go: { lock: "go.sum", manifest: "go.mod", cfg: "setup.cfg", kind: "vet" },
};
const fail = (file: string): string => `{ echo "FAIL ${file}"; exit 1; }`;
function fx(id: string, repo: string, eco: string, shape: string): Fx {
  const e = ECO[eco]!, f: Fx = {
    id, repo, eco, shape, task: "Set value to new in src/app.txt.",
    base: { "src/app.txt": "value=old\n", [e.manifest]: `name=${repo}\n`, [e.lock]: "lock v1\n", [e.cfg]: "{}\n" }, ignore: [".cache/", "local/"],
    edits: { "src/app.txt": "value=new\n" }, effects: {},
    checks: [{ name: "unit:src/app", kind: "unit", cmd: `grep -q value=new src/app.txt || ${fail("src/app.txt")}` }],
    hidden: "grep -q value=new src/app.txt", intended: ["src/app.txt"], fix: {},
  };
  const preRedSuite = (): void => { f.base["legacy/broken.txt"] = "bad\n"; f.checks.push({ name: "full suite", kind: "full_suite", cmd: `grep -q good legacy/broken.txt || ${fail("legacy/broken.txt")}` }); };
  switch (shape) {
    case "lock": preRedSuite(); f.effects[e.lock] = `lock v1\n# re-resolved by the toolchain during verify (${repo})\n`; break;
    case "prered": // a base-red type/lint check on an untouched file; the stub fixer "fixes" it by editing the runner config (the zod pattern)
      f.base["legacy/old.ts"] = "bad\n";
      f.checks.push({ name: `lint:${e.kind}`, kind: e.kind, cmd: `grep -q exclude ${e.cfg} || grep -q good legacy/old.ts || ${fail("legacy/old.ts")}` });
      f.fix[`lint:${e.kind}`] = { [e.cfg]: '{"exclude":["legacy"]}\n' }; break;
    case "cache": f.effects[`.cache/test-types/${repo}/vite.config.d.ts`] = "export {}\n"; break; // ignored build output with a runner-config name (the tq stall)
    case "clean": break;
    case "dep_bump": // adversarial: the lockfile change IS the deliverable and the agent wrote it
      preRedSuite(); f.task = "Bump dep to 2."; f.edits[e.manifest] = `name=${repo}\ndep=2\n`; f.edits[e.lock] = "lock v1\ndep 2\n";
      f.hidden += ` && grep -q 'dep 2' ${e.lock}`; f.intended.push(e.manifest, e.lock); break;
    case "intro_untouched": // adversarial: the agent's change breaks a check whose failure names an UNTOUCHED file; passes at base
      f.base["src/api.txt"] = "api=1\n"; f.edits["src/api.txt"] = "api=2\n";
      f.checks.push({ name: `lint:${e.kind}`, kind: e.kind, cmd: `grep -q api=1 src/api.txt || ${fail("src/consumer.ts")}` });
      f.fix[`lint:${e.kind}`] = { "src/api.txt": "api=1\n" }; f.hidden += " && grep -q api=1 src/api.txt"; break;
    case "cfg_real_ignored": // adversarial: a wrong fix, then the fixer writes an IGNORED runner config that makes the check pass
      f.edits["src/app.txt"] = "value=wrong\n"; f.checks[0]!.cmd = `test -e local/vitest.config.ts || grep -q value=new src/app.txt || ${fail("src/app.txt")}`;
      f.fix["unit:src/app"] = { "local/vitest.config.ts": "export default { test: { include: [] } }\n" }; break;
    case "codegen": // adversarial: verify regenerates a TRACKED file the change needs (harness-written, wanted)
      preRedSuite(); f.base["src/generated/schema.txt"] = "value=old\n"; f.effects["src/generated/schema.txt"] = "value=new\n";
      f.checks.push({ name: "gen", kind: "unit", cmd: `grep -q value=new src/generated/schema.txt || ${fail("src/generated/schema.txt")}` });
      f.hidden += " && grep -q value=new src/generated/schema.txt"; f.intended.push("src/generated/schema.txt"); break;
    case "mod_add": // drift seen only live: the agent adds a requirement, verify's download writes the matching go.sum entry
      f.base["go.mod"] = "module x\n"; f.base["go.sum"] = "lock v1\n"; f.edits["go.mod"] = "module x\nrequire newdep v1\n"; f.effects["go.sum"] = "lock v1\nnewdep h1:abc\n";
      f.checks.push({ name: "build", kind: "build", cmd: `! grep -q newdep go.mod || grep -q newdep go.sum || ${fail("go.sum")}` });
      f.checks.push({ name: "lint:style", kind: "style", cmd: `grep -q '^module x$' go.mod && ! grep -q require go.mod || ${fail("go.mod")}` }); // unfixable style nit: the run ends FAILED
      f.hidden += " && grep -q newdep go.sum"; f.intended.push("go.mod", "go.sum"); break;
    default: throw new Error(shape);
  }
  f.intended.sort(); return f;
}

// ---- mini harness -------------------------------------------------------------------------------------------------------
interface Result { facts: RunFacts; merge_ready: boolean; shipped_ok: boolean; false_green: boolean; harm_truth: boolean; harm_seen: boolean; fired: Set<string>; not_proven: string[] }
const sh = (cwd: string, cmd: string): { ok: boolean; sig: string } => { const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: 10_000 }); return { ok: r.status === 0, sig: `${r.status}:${((r.stdout ?? "") + (r.stderr ?? "")).split("\n")[0]}` }; };
const write = (dir: string, files: Record<string, string>): void => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } };
const snapshot = (repo: string, rev: string): string => { const d = mkdtempSync(join(ROOT, "snap.")); execFileSync("sh", ["-c", `git archive ${rev} | tar -x -C '${d}'`], { cwd: repo, env: GENV }); return d; };

function run(f: Fx, rules: Rule[]): Result {
  const repo = mkdtempSync(join(ROOT, `${f.id}.`)), agent = new Set<string>(), fired = new Set<string>(), notProven: string[] = [];
  write(repo, { ...f.base, ".gitignore": f.ignore.join("\n") + "\n" });
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").trim(); git(repo, "checkout", "-qb", "loki/run");
  let cost = IMPL_USD; write(repo, f.edits); for (const p of Object.keys(f.edits)) agent.add(p);
  const commitStage = (msg: string): void => { // the real commit-stage filter
    git(repo, "add", "-A"); const staged = parseStaged(git(repo, "diff", "--cached", "--name-status", "--no-renames", "-z", base));
    const drop = dropSet(repo, staged, undefined, GENV, undefined, undefined, base, f.task);
    if (drop.length) git(repo, "reset", "-q", base, "--", ...drop.map((d) => d.f));
    if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: repo, env: GENV }).status === 1) git(repo, "commit", "-qm", msg);
  };
  commitStage("loki: implement");
  const changed = (): string[] => git(repo, "status", "--porcelain", "-uall").split("\n").filter(Boolean).map((l) => l.slice(3)).concat(git(repo, "diff", "--name-only", base, "HEAD").split("\n").filter(Boolean));
  const verify = (): Map<string, { ok: boolean; sig: string }> => { write(repo, f.effects); return new Map(f.checks.map((c) => [c.name, sh(repo, c.cmd)])); };
  const baseSig = (c: Check): string | null => { const d = snapshot(repo, base); return sh(d, c.cmd).sig; };
  let res = verify(); const excused = new Set<string>(), rounds: RunFacts["fix_rounds"] = [];
  for (let round = 0; round < 2; round++) {
    const failing = f.checks.filter((c) => !res.get(c.name)!.ok && !excused.has(c.name));
    for (const c of failing) {
      const named = res.get(c.name)!.sig.replace(/^\d+:FAIL /, ""), inDiff = changed().includes(named);
      const needBase = rules.some((r) => r.state === "active" && r.template === "pre_red");
      const by = excuse(rules, c.kind, res.get(c.name)!.sig, needBase ? baseSig(c) : null, inDiff);
      if (by) { excused.add(c.name); fired.add(by); notProven.push(`pre red (excused by ${by}): ${c.name}`); }
    }
    const send = failing.filter((c) => !excused.has(c.name));
    if (!send.length) break;
    cost += FIX_USD; const before = new Map(send.map((c) => [c.name, res.get(c.name)!.sig])), edited: string[] = [];
    for (const c of send) { const w = f.fix[c.name]; if (w) { write(repo, w); for (const p of Object.keys(w)) { agent.add(p); edited.push(p); } } }
    res = verify();
    for (const c of send) rounds.push({ check: c.name, kind: c.kind, sig_same: res.get(c.name)!.sig === before.get(c.name), edited, failing_in_diff: changed().includes(before.get(c.name)!.replace(/^\d+:FAIL /, "")) });
    if (send.every((c) => res.get(c.name)!.sig === before.get(c.name))) break; // stall rule: a round that changes nothing ends the loop
  }
  // seal: config flags (ignored files included, as runner_config.ts hiddenConfigChanged does), then the verdict
  const ignoredNow = new Set(git(repo, "status", "--porcelain", "--ignored", "-uall").split("\n").filter((l) => l.startsWith("!! ")).map((l) => l.slice(3)));
  const flags = [...new Set([...changed(), ...ignoredNow])].filter((p) => nameClass(p) === "runner_config").map((p) => ({ path: p, by: (agent.has(p) ? "agent" : "harness") as Writer, ignored: ignoredNow.has(p) }));
  const { kept, dropped } = keptFlags(rules, flags); for (const d of dropped) { fired.add(d.rule); notProven.push(`test configuration changed (not counted, ${d.rule}): ${d.path}`); }
  const anyFail = f.checks.some((c) => !res.get(c.name)!.ok && !excused.has(c.name));
  const verdict: RunFacts["verdict"] = kept.length ? "STALLED" : anyFail ? "FAILED" : excused.size ? "PARTIAL" : "VERIFIED";
  let shipped: RunFacts["shipped"] = [], harmSeen = false;
  if (verdict === "VERIFIED" || verdict === "PARTIAL") { commitStage("loki: verified"); shipped = git(repo, "diff", "--name-only", base, "HEAD").split("\n").filter(Boolean).map((p) => ({ path: p, by: (agent.has(p) ? "agent" : "harness") as Writer, ignored: false, wip: false })); }
  else { // commitUnsealedWork: everything goes in, minus what an active wip_drop rule resets
    git(repo, "add", "-A"); const staged = parseStaged(git(repo, "diff", "--cached", "--name-status", "--no-renames", "-z", base));
    shipped = staged.map(({ f: p }) => ({ path: p, by: (agent.has(p) ? "agent" : "harness") as Writer, ignored: false, wip: true }));
    const drops = wipDrops(rules, shipped);
    if (drops.length) { git(repo, "reset", "-q", base, "--", ...drops.map((d) => d.path)); for (const d of drops) { fired.add(d.rule); notProven.push(`dropped from WIP commit (${d.rule}): ${d.path}`); } }
    if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: repo, env: GENV }).status === 1) git(repo, "commit", "-qm", "loki: work in progress, not verified");
    if (drops.length) { // the observable harm probe: rerun the checks that passed on the tree the rule produced
      const d = snapshot(repo, "HEAD"); harmSeen = f.checks.some((c) => res.get(c.name)!.ok && !sh(d, c.cmd).ok);
      const dropSetPaths = new Set(drops.map((x) => x.path)); shipped = shipped.filter((s) => !dropSetPaths.has(s.path));
    }
  }
  const final = git(repo, "diff", "--name-only", base, "HEAD").split("\n").filter(Boolean).sort(), head = snapshot(repo, "HEAD");
  const hidden = sh(head, f.hidden).ok, scope = JSON.stringify(final) === JSON.stringify(f.intended), mr = hidden && scope, green = verdict === "VERIFIED" || verdict === "PARTIAL";
  return { facts: { run_id: f.id, repo: f.repo, verdict, shipped, fix_rounds: rounds, flags, cost_usd: +cost.toFixed(4) }, merge_ready: mr, shipped_ok: mr && green, false_green: green && !mr,
    harm_truth: notProven.some((n) => n.startsWith("dropped")) && f.intended.some((p) => !final.includes(p)), harm_seen: harmSeen, fired, not_proven: notProven };
}
const score = (rs: Result[]): Outcome & { merge_ready: number; shipped_ok: number } => ({ correct: rs.reduce((a, r) => a + +r.merge_ready + +r.shipped_ok, 0), merge_ready: rs.filter((r) => r.merge_ready).length, shipped_ok: rs.filter((r) => r.shipped_ok).length, false_green: rs.filter((r) => r.false_green).length, harm: rs.filter((r) => r.harm_seen || r.harm_truth).length, cost: +rs.reduce((a, r) => a + r.facts.cost_usd, 0).toFixed(4) });
const runAll = (fs: Fx[], rules: Rule[]): Result[] => fs.map((f) => run(f, rules));
const activate = (rs: Rule[]): Rule[] => rs.map((r) => ({ ...r, state: "active" as const }));

// ---- sets: disjoint repos; TRAIN only pnpm/npm; HELD-BACK other ecosystems + adversarial; LIVE adds drift; TEST untouched ----
const TRAIN = [fx("t1", "pnpm-a", "pnpm", "lock"), fx("t2", "pnpm-b", "pnpm", "lock"), fx("t3", "npm-a", "npm", "lock"), fx("t4", "pnpm-a", "pnpm", "prered"), fx("t5", "npm-a", "npm", "prered"),
  fx("t6", "pnpm-b", "pnpm", "cache"), fx("t7", "npm-a", "npm", "cache"), fx("t8", "npm-b", "npm", "clean"), fx("t9", "pnpm-b", "pnpm", "prered")];
const HELD = [fx("h1", "yarn-a", "yarn", "lock"), fx("h2", "cargo-a", "cargo", "lock"), fx("h3", "poetry-a", "poetry", "lock"), fx("h4", "poetry-a", "poetry", "prered"), fx("h5", "yarn-a", "yarn", "prered"),
  fx("h6", "cargo-a", "cargo", "cache"), fx("h7", "poetry-b", "poetry", "cache"), fx("h8", "yarn-b", "yarn", "dep_bump"), fx("h9", "poetry-b", "poetry", "intro_untouched"), fx("h10", "yarn-b", "yarn", "intro_untouched"),
  fx("h11", "cargo-b", "cargo", "cfg_real_ignored"), fx("h12", "cargo-b", "cargo", "codegen"), fx("h13", "yarn-a", "yarn", "clean")];
const LIVE = [fx("l1", "bun-a", "bun", "lock"), fx("l2", "go-a", "go", "mod_add"), fx("l3", "bun-a", "bun", "prered"), fx("l4", "go-b", "go", "mod_add"), fx("l5", "bun-b", "bun", "cache"), fx("l6", "go-c", "go", "mod_add"), fx("l7", "bun-b", "bun", "clean")];
const TEST = [fx("x1", "npm-z", "npm", "lock"), fx("x2", "cargo-z", "cargo", "prered"), fx("x3", "go-z", "go", "lock"), fx("x4", "poetry-z", "poetry", "cache"), fx("x5", "yarn-z", "yarn", "dep_bump"), fx("x6", "bun-z", "bun", "intro_untouched"),
  fx("x7", "pnpm-z", "pnpm", "cfg_real_ignored"), fx("x8", "npm-y", "npm", "codegen"), fx("x9", "go-y", "go", "mod_add"), fx("x10", "cargo-y", "cargo", "clean"), fx("x11", "poetry-y", "poetry", "prered"), fx("x12", "yarn-y", "yarn", "cache")];

if (process.env["LAB_DEBUG"]) { // LAB_DEBUG=<fixture id> LAB_RULES=<rule id,...>: one run, printed
  const f = [...TRAIN, ...HELD, ...LIVE, ...TEST].find((x) => x.id === process.env["LAB_DEBUG"])!;
  const rules = (process.env["LAB_RULES"] ?? "").split(",").filter(Boolean).map((id) => { const [t, m, w, g] = id.split("|"); return { id, template: t, match: m, writer: w, guard: g, state: "active", support: { runs: 0, repos: [] }, live: { fired: 0, harm: 0, runs: 0 } } as Rule; });
  const r = run(f, rules); console.log(JSON.stringify({ ...r, fired: [...r.fired] }, null, 1)); process.exit(0);
}
const out: Record<string, unknown> = {};
const t0 = Date.now();
const trainBase = runAll(TRAIN, []); out["train_baseline"] = score(trainBase);
const cands = mine(trainBase.map((r) => r.facts)); out["candidates"] = cands.length;
const heldBase = runAll(HELD, []); out["held_baseline"] = score(heldBase);
const table: unknown[] = [], accepted: Rule[] = [];
for (const c of cands) {
  const v = judge(score(heldBase), score(runAll(HELD, activate([c]))), 0.0001), tv = judge(score(trainBase), score(runAll(TRAIN, activate([c]))), 0.0001);
  c.validation = { ...v, train_delta: tv.delta_correct }; c.state = v.accept ? "candidate" : "rejected";
  table.push({ rule: c.id, repos: c.support.repos.length, train_d: tv.delta_correct, held_d: v.delta_correct, held_fg: v.delta_false_green, held_harm: v.delta_harm, held_cost: v.delta_cost, accept: v.accept });
  if (v.accept) accepted.push(c);
}
out["validation"] = table;
let active = activate(select(accepted));
const combo = judge(score(heldBase), score(runAll(HELD, active)), 0.0001); out["selected"] = active.map((r) => r.id); out["held_combined"] = combo;
// LIVE: monitor harm (observable: a passing check fails on the rule's tree), roll back, add harmed shapes to the held-back pool, re-validate
const liveLog: unknown[] = [], harmedShapes: Fx[] = [];
for (const f of LIVE) {
  const on = active.filter((x) => x.state === "active"), r = run(f, on);
  for (const rule of active) { const was = rule.state; observe(rule, r.fired.has(rule.id), r.harm_seen && r.fired.has(rule.id)); if (was !== rule.state) liveLog.push({ at: f.id, rule: rule.id, now: rule.state, why: rule.why }); }
  if (r.harm_seen) harmedShapes.push(fx(`${f.id}r`, `${f.repo}-regress`, f.eco, f.shape));
  liveLog.push({ run: f.id, shape: f.shape, verdict: r.facts.verdict, on: on.map((x) => x.id), fired: [...r.fired], harm_seen: r.harm_seen, merge_ready: r.merge_ready, not_proven: r.not_proven, shipped: r.facts.shipped.map((s) => `${s.path}:${s.by}`) });
}
out["live"] = liveLog;
const rolled = active.filter((r) => r.state === "rolled_back");
if (rolled.length) { // re-validate the same template's candidates on HELD + the harmed live shapes; the rolled-back rule is barred
  const pool = [...HELD, ...harmedShapes], poolBase = score(runAll(pool, [])), keep = active.filter((r) => r.state === "active"), re: unknown[] = [];
  for (const t of new Set(rolled.map((r) => r.template))) {
    const ok: Rule[] = [];
    for (const c of cands.filter((x) => x.template === t && !rolled.some((r) => r.id === x.id))) {
      const v = judge(poolBase, score(runAll(pool, activate([c]))), 0.0001); c.validation = { ...v, train_delta: c.validation?.train_delta }; re.push({ rule: c.id, held_d: v.delta_correct, harm: v.delta_harm, accept: v.accept }); if (v.accept) ok.push(c);
    }
    keep.push(...activate(select(ok)));
  }
  out["revalidation"] = re; active = keep; out["selected_after_rollback"] = active.map((r) => r.id);
}
const testBase = runAll(TEST, []), testRules = runAll(TEST, active);
out["test_baseline"] = score(testBase); out["test_with_rules"] = score(testRules);
out["test_per_fixture"] = TEST.map((f, i) => ({ id: f.id, shape: f.shape, base: `${testBase[i]!.facts.verdict} mr=${+testBase[i]!.merge_ready} $${testBase[i]!.facts.cost_usd}`, rules: `${testRules[i]!.facts.verdict} mr=${+testRules[i]!.merge_ready} $${testRules[i]!.facts.cost_usd}`, fired: [...testRules[i]!.fired] }));
out["seconds"] = Math.round((Date.now() - t0) / 1000);
writeFileSync(join(ROOT, "result.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
