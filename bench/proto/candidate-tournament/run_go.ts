// Go experiment driver: the candidate tournament on top of the executable spec. New file beside run.ts because run.ts owns the JS
// fixtures (node --test, .mjs probes); this one owns Go fixtures, the exec-spec arm and the modeled agent trees. Usage:
//   bun run_go.ts <fixture-dir> <work-dir> stub|haiku|replay [canned-or-transcripts.json]
// <fixture-dir>: repo/ (go.mod, sources, existing tests), issue.md, agent.json (modeled agent trees "wrong" and "right" as
// SEARCH/REPLACE edits), oracle_test.go (PRIVATE: run only after the pick, never in any prompt), and optionally
// old-spec-reply.txt (an earlier real generator reply, scored as a second exec-spec sample at zero cost).
// Real calls (haiku mode): 1) pre-implement: the executable spec AND the probe cases in one tool-less call, 2) candidates,
// 3) judge, only when check-passing trees disagree. Every call: sdk_invoker messages.create, no tools, thinking disabled.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratorBrief, EMITTERS, extractSpecAtoms, implementBlock, pairAtoms, parityAtoms, parseGenerated, planFor, redFilter, resolveSites, selectCases } from "../../../loki-ts/src/features/exec_spec.ts";
import {
  applyEdits, candidatePrompt, differingGoFuncs, diffProbePrompt, disagreements, GO_PROBE_RULES, judgePrompt, judgeViews, parseCandidates, parseGoProbeCases, parseProbeOutput,
  parseVerdicts, PROBE_MARK, resolveVerdicts, runGoProbe, select, stableIds, SYSTEM_PROMPTS, toollessCall, agentSdkToollessCall,
  type Context, type Edit, type Entrant, type LlmCall, type ProbeRun, type SpecStates, type Usage,
} from "../../../loki-ts/src/features/tournament.ts";
import { plainTestEnv, spawnGroupSync, stripAnsi } from "../../../loki-ts/src/util/check_result.ts";

const [fixture, work, mode, canned] = process.argv.slice(2) as [string, string, "stub" | "haiku" | "replay" | "resume", string | undefined]; // resume: replay the recorded calls, make real calls only for the rest
const repo = join(fixture, "repo"), e = EMITTERS.go;
const issue = readFileSync(join(fixture, "issue.md"), "utf8");
const files: Record<string, string> = {}, tests: Record<string, string> = {};
for (const n of readdirSync(repo)) if (n.endsWith(".go")) (n.endsWith("_test.go") ? tests : files)[n] = readFileSync(join(repo, n), "utf8");
const pkg = /^package\s+(\w+)/m.exec(Object.values(files)[0] ?? "")?.[1] ?? "main";
const agentEdits = JSON.parse(readFileSync(join(fixture, "agent.json"), "utf8")) as { wrong: Edit[]; right: Edit[] };
mkdirSync(work, { recursive: true });

// ---------- trees ----------
let seq = 0;
function tree(name: string, edits: Edit[]): string | null {
  const next = applyEdits(files, edits);
  if (!next) return null;
  const dir = join(work, "trees", `${String(seq++).padStart(2, "0")}-${name}`);
  cpSync(repo, dir, { recursive: true });
  for (const [p, s] of Object.entries(next)) writeFileSync(join(dir, p), s);
  return dir;
}
function goTest(dir: string, extra: Record<string, string> = {}): { pass: boolean; out: string } {
  for (const [p, s] of Object.entries(extra)) writeFileSync(join(dir, p), s);
  try {
    const r = spawnGroupSync("go", ["test", "-count=1", "./..."], { cwd: dir, env: plainTestEnv(), timeoutMs: 120_000 });
    return { pass: r.status === 0, out: stripAnsi(r.output) };
  } finally { for (const p of Object.keys(extra)) rmSync(join(dir, p), { force: true }); }
}
const oracle = (dir: string): boolean => goTest(dir, { "zz_oracle_test.go": readFileSync(join(fixture, "oracle_test.go"), "utf8") }).pass;

// ---------- calls ----------
const zero = (): Usage => ({ inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
const transcripts: { tag: string; system: string; user: string; text: string; usage: Usage; outcome?: string }[] = [];
const BUDGET_FILE = process.env.LOKI_PROTO_CALL_BUDGET_FILE ?? "", BUDGET_MAX = Number(process.env.LOKI_PROTO_CALL_BUDGET_MAX ?? "0");
let llm: LlmCall;
let stubTruth: (probeId: string) => string | undefined = () => undefined; // stub judge: the right tree's output for a probe (set once trees exist)
if (mode === "haiku" || mode === "resume") {
  // LOKI_PROTO_CALL_PATH: "agent-sdk" (default here: this machine's subscription token gets HTTP 429 on direct messages.create) or "messages"
  const sdkCwd = join(work, "sdk-cwd"); mkdirSync(sdkCwd, { recursive: true });
  const real = process.env.LOKI_PROTO_CALL_PATH === "messages" ? toollessCall({ lokiDir: join(work, ".loki"), maxTokens: 8192 }) : agentSdkToollessCall({ cwd: sdkCwd });
  const rec = mode === "resume" ? (JSON.parse(readFileSync(canned!, "utf8")) as { tag: string; text: string; usage: Usage; outcome?: string }[]) : [];
  llm = async (system, user, tag) => {
    const old = rec.find((x) => x.tag === tag);
    if (old) { transcripts.push({ tag: tag ?? "", system, user, text: old.text, usage: old.usage, outcome: `replayed: ${old.outcome ?? ""}` }); return { text: old.text, usage: old.usage }; }
    if (BUDGET_FILE) { // a hard cap on real calls across every run of the experiment
      const used = existsSync(BUDGET_FILE) ? Number(readFileSync(BUDGET_FILE, "utf8").trim() || "0") : 0;
      if (used >= BUDGET_MAX) { transcripts.push({ tag: tag ?? "", system, user, text: "", usage: zero(), outcome: `not sent: real-call budget spent (${used}/${BUDGET_MAX})` }); return { text: "", usage: zero(), outcome: "budget" }; }
      writeFileSync(BUDGET_FILE, String(used + 1));
    }
    writeFileSync(join(work, `prompt-${tag}.txt`), `SYSTEM:\n${system}\n\nUSER:\n${user}`);
    const r = await real(system, user, tag);
    transcripts.push({ tag: tag ?? "", system, user, text: r.text, usage: r.usage, ...(r.outcome ? { outcome: r.outcome } : {}) });
    writeFileSync(join(work, "transcripts.json"), JSON.stringify(transcripts, null, 2));
    return r;
  };
} else if (mode === "replay") {
  const rec = JSON.parse(readFileSync(canned!, "utf8")) as { tag: string; text: string; usage: Usage; outcome?: string }[];
  llm = async (system, user, tag) => {
    const r = rec.find((x) => x.tag === tag);
    if (!r) throw new Error(`replay has no ${tag} call`);
    transcripts.push({ tag: tag ?? "", system, user, text: r.text, usage: r.usage, ...(r.outcome ? { outcome: r.outcome } : {}) });
    return { text: r.text, usage: r.usage };
  };
} else {
  const c = JSON.parse(readFileSync(canned!, "utf8")) as { pre: string; candidates: string };
  llm = async (system, user, tag) => {
    let text = tag === "pre" ? c.pre : tag === "candidates" ? c.candidates : "";
    if (tag === "judge") { // a RIGHT stub judge: picks, in every view, the option equal to the right tree's output
      const lines: string[] = []; let cur = "", opts: { l: string; o: string }[] = [];
      const flush = () => { if (cur) { const t = stubTruth(cur.replace(/\.\d+$/, "")); lines.push(`${cur}: ${opts.find((x) => x.o === t)?.l ?? "unknown"}`); } };
      for (const l of user.split("\n")) {
        const pm = /^PROBE (\S+):/.exec(l); if (pm) { flush(); cur = pm[1]!; opts = []; continue; }
        const om = /^  option ([A-Z]): (.*)$/.exec(l); if (om && cur) opts.push({ l: om[1]!, o: om[2]! });
      }
      flush(); text = lines.join("\n");
    }
    transcripts.push({ tag: tag ?? "", system, user, text, usage: zero() });
    return { text, usage: zero() };
  };
}

// ---------- 1. executable spec, deterministic part (exec_spec.ts as it will ship) ----------
const a0 = extractSpecAtoms(issue), sites = resolveSites(a0, repo), atoms = [...a0, ...parityAtoms(a0, sites), ...pairAtoms(a0, sites)];
const plan = planFor("go", repo, sites, Object.keys(tests));
if (!plan) throw new Error("exec spec: no Go site resolved");
const specBrief = buildGeneratorBrief(e, atoms, sites, plan.header, plan.style);
const ONE_BLOCK = "reply with exactly one ```go fenced block and nothing else.";
if (!e.rules.includes(ONE_BLOCK)) throw new Error("exec spec rules changed: the merged pre-implement brief needs re-deriving");
const mergedRules = `${e.rules.replace(ONE_BLOCK, "reply with exactly two ```go fenced blocks and nothing else: first that spec file, then the probe file described at the end of these rules.")}\n${GO_PROBE_RULES}`;
const preBrief = specBrief.replace(e.rules, mergedRules);
const SYS_PRE = "You write Go test files from a bug report. Output only the requested fenced blocks.";

const goBlocks = (t: string): string[] => [...t.matchAll(/```go[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
interface SpecArm { source: string; refused?: string; binding: string[]; advisory: string[]; guards: string[]; dropped: string[]; full?: string; sealed?: string; brief?: string; states: Record<string, SpecStates | null> }
function specArm(source: string, reply: string, baseDir: string): SpecArm {
  const block = goBlocks(reply).find((b) => /^func TestLokiSpec_/m.test(b));
  const parsed = block ? parseGenerated(e, "```go\n" + block + "```", plan!.mustStart) : { refused: "exec_spec_no_code_block" };
  if ("refused" in parsed) return { source, refused: parsed.refused, binding: [], advisory: [], guards: [], dropped: [], states: {} };
  const base = redFilter(e, baseDir, plan!.targetRel, parsed.file);
  if (!base.built) return { source, refused: "did not build on base", binding: [], advisory: [], guards: [], dropped: e.names(parsed.file), states: {} };
  const sel = selectCases(e, parsed.file, base, issue);
  let binding = sel.binding;
  if (binding.length) { const again = redFilter(e, baseDir, plan!.targetRel, sel.file); if (!again.built || binding.some((n) => again.cases[n] !== "red")) { sel.advisory.push(...binding.map((name) => ({ name, why: "red on base alone, not once pruned" }))); binding = []; } }
  const brief = implementBlock(e, plan!.targetRel, { ...sel, binding }, parsed.file, atoms, sites);
  return { source, binding, advisory: sel.advisory.map((a) => a.name), guards: sel.guards, dropped: e.names(parsed.file).filter((n) => base.cases[n] !== "red" && base.cases[n] !== "green"), full: parsed.file, sealed: binding.length ? sel.file : undefined, brief, states: { base: base.cases as SpecStates } };
}
const specStates = (arm: SpecArm, dir: string): SpecStates | null => { if (!arm.full) return null; const r = redFilter(e, dir, plan.targetRel, arm.full); return r.built ? (r.cases as SpecStates) : null; };
const gate = (arm: SpecArm, dir: string): boolean => goTest(dir, arm.sealed ? { [plan.targetRel]: arm.sealed } : {}).pass;

// ---------- 2. the pre-implement call: spec + probe cases ----------
const t0 = Date.now();
const pre = await llm(SYS_PRE, preBrief, "pre");
const base0 = tree("base-a", [])!, base1 = tree("base-b", [])!;
const arm = specArm("pre-implement call", pre.text, base0);
const oldReplyPath = join(fixture, "old-spec-reply.txt");
const armOld = existsSync(oldReplyPath) ? specArm("round-1 recorded reply", readFileSync(oldReplyPath, "utf8"), base0) : null;
const probeCases = parseGoProbeCases(pre.text, pkg);
const probeOf = (dir: string): ProbeRun => ("file" in probeCases ? parseProbeOutput(runGoProbe(dir, "", pkg, probeCases.file).stdout, PROBE_MARK).run : {});
const probeBuild = "file" in probeCases ? runGoProbe(base0, "", pkg, probeCases.file) : null;
const pa = probeBuild?.built ? parseProbeOutput(probeBuild.stdout, PROBE_MARK) : { run: {}, probes: [] };
const pb = probeOf(base1), stable = stableIds(pa.run, pb);
const keep = (r: ProbeRun): ProbeRun => Object.fromEntries(Object.entries(r).filter(([k]) => stable.has(k)));
const probes = pa.probes.filter((p) => stable.has(p.id));

// ---------- 3. agent trees (modeled) and candidates ----------
const W = tree("agent-wrong", agentEdits.wrong)!, Rt = tree("agent-right", agentEdits.right)!;
const sealedNote = arm.sealed ? `\n\nSEALED SPEC FILE ${plan.targetRel} (read-only, verify runs it):\n${arm.sealed}` : "";
const ctx: Context = { issue, files, tests, lang: "Go", brief: `${arm.brief ?? ""}${sealedNote}`.trim() || undefined };
const cand = await llm(SYSTEM_PROMPTS.patch, candidatePrompt(ctx), "candidates");
const specs = parseCandidates(cand.text);
interface Row { id: string; dir: string | null; applies: boolean; gate: boolean; gateRepo: boolean; spec: SpecStates | null; run: ProbeRun; diffLines: number; oracle: boolean }
const rows: Row[] = [];
const enter = (id: string, dir: string | null, diffLines: number): void => {
  if (!dir) { rows.push({ id, dir, applies: false, gate: false, gateRepo: false, spec: null, run: {}, diffLines, oracle: false }); return; }
  rows.push({ id, dir, applies: true, gate: gate(arm, dir), gateRepo: goTest(dir).pass, spec: specStates(arm, dir), run: keep(probeOf(dir)), diffLines, oracle: oracle(dir) });
};
enter("agent-wrong", W, 0); enter("agent-right", Rt, 0);
for (const s of specs) enter(s.id, tree(s.id, s.edits), s.edits.reduce((n, x) => n + x.search.split("\n").length + x.replace.split("\n").length, 0));
// world "spec": the gate includes the sealed binding spec and the spec veto applies; world "nospec": the counterfactual where the
// executable spec missed (gate = the repo's own tests only, no spec states), which is where the tournament must earn its keep.
type World = "spec" | "nospec";
const ent = (r: Row, id = r.id, world: World = "spec"): Entrant => ({ id, lens: id, dir: r.dir ?? "", checksPass: world === "spec" ? r.gate : r.gateRepo, run: r.run, diffLines: r.diffLines, spec: world === "spec" ? r.spec : null });
const byId = (id: string): Row => rows.find((r) => r.id === id)!;
const candRows = rows.filter((r) => r.id.startsWith("c"));

// ---------- 3b. diff-directed probes: trees differ in code but no probe separates them ----------
const treeFiles = (dir: string): Record<string, string> => Object.fromEntries(Object.keys(files).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const sameRun = (a: ProbeRun, b: ProbeRun): boolean => Object.keys(a).every((k) => b[k] === undefined || a[k] === b[k]);
const wRow0 = byId("agent-wrong"), liveCands = candRows.filter((r) => r.gateRepo && r.dir);
const unseparated = liveCands.filter((r) => sameRun(wRow0.run, r.run) && differingGoFuncs([treeFiles(W), treeFiles(r.dir!)]).length > 0);
let diffProbe: { called: boolean; refused?: string; repairedImports?: string[]; cases: number; stable: number; funcs: string[] } = { called: false, cases: 0, stable: 0, funcs: [] };
if (unseparated.length > 0 && process.env.LOKI_PROTO_DIFF_PROBES !== "0") {
  const diffs = differingGoFuncs([treeFiles(W), ...unseparated.map((r) => treeFiles(r.dir!))]); // the agent's version first, unlabeled as such
  const dp = await llm(SYSTEM_PROMPTS.diffProbe, diffProbePrompt(ctx, diffs, pkg), "diffprobe");
  const dc = parseGoProbeCases(dp.text, pkg);
  diffProbe = { called: true, cases: 0, stable: 0, funcs: diffs.map((d) => `${d.file}:${d.name} x${d.versions.length}`), ...("refused" in dc ? { refused: dc.refused } : { repairedImports: dc.repairedImports }) };
  if ("file" in dc) {
    const tag = (r: ProbeRun): ProbeRun => Object.fromEntries(Object.entries(r).map(([k, v]) => [`d${k}`, v]));
    const run0 = runGoProbe(base0, "", pkg, dc.file), da = run0.built ? parseProbeOutput(run0.stdout, PROBE_MARK) : { run: {}, probes: [] };
    const db = tag(parseProbeOutput(runGoProbe(base1, "", pkg, dc.file).stdout, PROBE_MARK).run), dra = tag(da.run);
    const dstable = stableIds(dra, db);
    diffProbe.cases = Object.keys(dra).length; diffProbe.stable = dstable.size;
    for (const p of da.probes) if (dstable.has(`d${p.id}`)) { probes.push({ id: `d${p.id}`, desc: p.desc }); pa.run[`d${p.id}`] = dra[`d${p.id}`]!; stable.add(`d${p.id}`); }
    for (const r of rows) if (r.dir) { const o = tag(parseProbeOutput(runGoProbe(r.dir, "", pkg, dc.file).stdout, PROBE_MARK).run); for (const [k, v] of Object.entries(o)) if (dstable.has(k)) r.run[k] = v; }
  }
}

// ---------- 4. one judge call over the union of disagreements ----------
const union = disagreements(rows.map((r) => ent(r, r.id, "nospec")), probes); // the weaker gate: a superset of both worlds' disagreements
const rightRun = byId("agent-right").run;
stubTruth = (probeId) => rightRun[probeId];
let raw = new Map<string, string>(), picks = new Map<string, string>(), judgeCalled = false;
const views = judgeViews(union);
if (union.length > 0) { judgeCalled = true; const j = await llm(SYSTEM_PROMPTS.judge, judgePrompt(ctx, views, keep(pa.run)), "judge"); raw = parseVerdicts(j.text); picks = resolveVerdicts(views, raw); }
// the verdict quality, scored against the right tree (never shown to the judge): consistent picks that equal / differ from it
const verdictScore = { consistent: picks.size, agreeWithRight: [...picks].filter(([p, o]) => rightRun[p] === o).length, disagreements: union.length };

// ---------- 5. outcomes ----------
const tourney = (agentRow: Row, margin: number, world: World = "spec", incumbent = true, anchored = false) => {
  const pool = [ent(agentRow, "agent", world), ...candRows.map((r) => ent(r, r.id, world))];
  const d = disagreements(pool, probes);
  const p = select(pool, d, picks, incumbent ? { agentId: "agent", margin, ...(anchored ? { anchor: keep(pa.run) } : {}) } : { margin });
  const win = p.winner === "agent" ? agentRow : byId(p.winner);
  return { winner: p.winner === "agent" ? agentRow.id : p.winner, displaced: p.displaced, oracle: win.oracle, reason: p.reason };
};
const blocked = (a: SpecArm, policy: "stated" | "all", r: Row): boolean => policy === "stated" ? !r.gate : a.advisory.concat(a.binding).some((n) => r.spec?.[n] !== "green") || !r.gate;
const outcomes: Record<string, unknown>[] = [];
for (const [name, a] of [["pre-implement call", arm], ...(armOld ? [["round-1 recorded reply", armOld] as const] : [])] as const) {
  const st = (dir: string) => (a === arm ? null : specStates(a, dir));
  const wRow = a === arm ? byId("agent-wrong") : { ...byId("agent-wrong"), gate: gate(a, W), spec: st(W) };
  for (const policy of ["stated", "all"] as const) {
    const isBlocked = blocked(a, policy, wRow);
    const shipped = isBlocked ? byId("agent-right") : byId("agent-wrong"); // a blocked wrong tree is assumed repaired (optimistic for exec-spec alone)
    outcomes.push({ spec: name, policy, wrongBlockedBySpec: isBlocked, execSpecAlone: { agentTree: shipped.id, oracle: shipped.oracle }, withTournament_m1: a === arm ? tourney(shipped, 1) : "n/a (candidates were briefed from the pre-implement spec)", withTournament_m2: a === arm ? tourney(shipped, 2) : "n/a", withTournament_anchored: a === arm ? tourney(shipped, 1, "spec", true, true) : "n/a" });
  }
}
for (const agentId of ["agent-wrong", "agent-right"]) { // counterfactual: the spec missed, the agent shipped this tree
  const r = byId(agentId);
  outcomes.push({ spec: "missed (counterfactual)", policy: "repo tests only", agentTree: agentId, agentPassesRepoTests: r.gateRepo, agentOracle: r.oracle, withTournament_m1: tourney(r, 1, "nospec"), withTournament_m2: tourney(r, 2, "nospec"), withTournament_anchored: tourney(r, 1, "nospec", true, true), roundOneRule: tourney(r, 1, "nospec", false) });
}

// ---------- 6. wrong-judge simulation on the real disagreement structure (zero cost) ----------
function simulate(kind: "random" | "positional" | "adversarial" | "right", agentRow: Row, rule: "round1" | "m1" | "m2" | "anchored", trials: number, world: World, extra: Row[] = []): number {
  const pool = [ent(agentRow, "agent", world), ...[...candRows, ...extra].map((r) => ent(r, r.id, world))], d = disagreements(pool, probes);
  if (d.length === 0) return 0;
  let displaced = 0;
  for (let t = 0; t < trials; t++) {
    const vs = judgeViews(d), ans = new Map<string, string>();
    for (const v of vs) {
      const agentOut = agentRow.run[v.probeId];
      const lab = kind === "random" ? v.options[Math.floor(Math.random() * v.options.length)]!.label : kind === "positional" ? "A" : kind === "adversarial" ? (v.options.find((o) => o.out !== agentOut)?.label ?? "unknown") : (v.options.find((o) => o.out === rightRun[v.probeId])?.label ?? "unknown");
      ans.set(v.viewId, lab);
    }
    let p;
    if (rule === "round1") { // round 1: first view only, no consistency, no incumbent, cluster fallback
      const single = new Map<string, string>();
      for (const v of vs.filter((x) => x.viewId.endsWith(".1"))) { const l = ans.get(v.viewId); const o = v.options.find((x) => x.label === l)?.out; if (o !== undefined) single.set(v.probeId, o); }
      p = select(pool, d, single);
    } else p = select(pool, d, resolveVerdicts(vs, ans), { agentId: "agent", margin: rule === "m2" ? 2 : 1, ...(rule === "anchored" ? { anchor: keep(pa.run) } : {}) });
    if (p.winner !== "agent") displaced++;
    if (kind !== "random") return displaced; // deterministic judges: one trial
  }
  return displaced / trials;
}
const sim: Record<string, Record<string, number>> = {};
for (const world of ["spec", "nospec"] as const) for (const agentId of ["agent-right", "agent-wrong"]) for (const kind of ["random", "positional", "adversarial", "right"] as const) for (const rule of ["round1", "m1", "m2", "anchored"] as const) {
  (sim[`${world}/${agentId}/${kind}`] ??= {})[rule] = simulate(kind, byId(agentId), rule, 4000, world);
}
// harm: the right tree is the agent and the real wrong tree is entered as one more check-passing challenger
for (const world of ["spec", "nospec"] as const) for (const kind of ["random", "positional", "adversarial", "right"] as const) for (const rule of ["round1", "m1", "m2", "anchored"] as const) {
  (sim[`${world}/agent-right+wrong-challenger/${kind}`] ??= {})[rule] = simulate(kind, byId("agent-right"), rule, 4000, world, [byId("agent-wrong")]);
}

const total = transcripts.reduce((a, t) => ({ inTok: a.inTok + t.usage.inTok, outTok: a.outTok + t.usage.outTok, cacheRead: a.cacheRead + t.usage.cacheRead, cacheWrite: a.cacheWrite + t.usage.cacheWrite, costUsd: a.costUsd + t.usage.costUsd }), zero());
const report = {
  fixture, mode, pkg, wallS: (Date.now() - t0) / 1000,
  atoms: atoms.map((a) => `${a.id}:${a.kind}`), sites: sites.map((s) => s.symbol),
  spec: [arm, ...(armOld ? [armOld] : [])].map((a) => ({ source: a.source, refused: a.refused, binding: a.binding, advisory: a.advisory, guards: a.guards, dropped: a.dropped })),
  diffProbe,
  probe: { refused: "refused" in probeCases ? probeCases.refused : undefined, repairedImports: "file" in probeCases ? probeCases.repairedImports : [], builtOnBase: probeBuild?.built ?? false, cases: Object.keys(pa.run).length, stable: stable.size, unstable: Object.keys(pa.run).filter((k) => !stable.has(k)), buildError: probeBuild && !probeBuild.built ? probeBuild.error?.slice(-600) : undefined },
  trees: rows.map((r) => ({ id: r.id, applies: r.applies, gate: r.gate, gateRepo: r.gateRepo, oracle: r.oracle, diffLines: r.diffLines, specRed: r.spec ? Object.entries(r.spec).filter(([, s]) => s !== "green").map(([n]) => n) : null, probesPrinted: Object.keys(r.run).length })),
  disagreements: union.map((d) => ({ probe: d.probeId, desc: d.desc, options: d.options.map((o) => ({ out: o.out, entrants: o.entrants })) })),
  judge: { called: judgeCalled, raw: Object.fromEntries(raw), consistentPicks: Object.fromEntries(picks), ...verdictScore },
  outcomes, wrongJudgeSimulation: sim,
  calls: transcripts.map((t) => ({ tag: t.tag, outcome: t.outcome, usage: t.usage, visibleChars: t.text.length })), total,
};
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(work, "transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ fixture: fixture.split("/").pop(), spec: report.spec, probe: report.probe, trees: report.trees, disagreements: report.disagreements.length, judge: report.judge, outcomes, total }, null, 1));
