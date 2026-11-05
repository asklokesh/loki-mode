// Hermetic logic tests for the tournament prototype: bun test bench/proto/candidate-tournament/tournament.test.ts
// The "wrong judge" block is the round-2 proof: a planted judge that is wrong in each way a model judge can be wrong
// (no answer, answers by position, contradicts itself, backs a spec-regressing tree, or is wrong once) never displaces a
// check-passing agent tree; only a strict margin of order-swap-consistent verdicts with no loss and no spec regression does.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEdits, disagreements, judgeViews, parseCandidates, parseGoProbeCases, parseProbeOutput, parseVerdicts, PROBE_MARK,
  resolveVerdicts, runGoProbe, runTournament, select, stableIds, type Entrant, type Io, type LlmCall, type SpecStates,
} from "../../../loki-ts/src/features/tournament.ts";

const e = (id: string, run: Record<string, string>, checksPass = true, diffLines = 4, spec?: SpecStates): Entrant => ({ id, lens: id, dir: "/x", checksPass, run, diffLines, ...(spec ? { spec } : {}) });
const probes = (...ids: string[]) => ids.map((id) => ({ id, desc: id }));
/** A planted judge: answers each view through `answer(view options)`; returns the label text the way a model would. */
const judgeWith = (ents: Entrant[], ids: string[], answer: (opts: { label: string; out: string }[], viewId: string) => string) => {
  const d = disagreements(ents, probes(...ids)), views = judgeViews(d);
  const text = views.map((v) => `${v.viewId}: ${answer(v.options, v.viewId)}`).join("\n");
  return { d, picks: resolveVerdicts(views, parseVerdicts(text)) };
};
const labelOf = (opts: { label: string; out: string }[], out: string): string => opts.find((o) => o.out === out)?.label ?? "unknown";

test("parseCandidates reads numbered blocks with several edits", () => {
  const c = parseCandidates("=== CANDIDATE 1 ===\n<<<<<<< SEARCH a.js\nx\n=======\ny\n>>>>>>> REPLACE\n<<<<<<< SEARCH b.js\np\n=======\nq\n>>>>>>> REPLACE\n=== CANDIDATE 2 ===\n<<<<<<< SEARCH a.js\nx\n=======\nz\n>>>>>>> REPLACE\n");
  expect(c.map((x) => [x.id, x.edits.length])).toEqual([["c1", 2], ["c2", 1]]);
  expect(c[1]!.edits[0]).toEqual({ path: "a.js", search: "x", replace: "z" });
});

test("applyEdits refuses a missing or ambiguous SEARCH", () => {
  expect(applyEdits({ "a.js": "x x" }, [{ path: "a.js", search: "x", replace: "y" }])).toBeNull();
  expect(applyEdits({ "a.js": "x" }, [{ path: "a.js", search: "q", replace: "y" }])).toBeNull();
  expect(applyEdits({ "a.js": "x" }, [{ path: "b.js", search: "x", replace: "y" }])).toBeNull();
  expect(applyEdits({ "a.js": "ax" }, [{ path: "a.js", search: "x", replace: "y" }])).toEqual({ "a.js": "ay" });
});

test("probe output: bare JSON lines (JS), marked lines only (Go), first line of an id wins", () => {
  const p = parseProbeOutput('noise\n{"id":"p1","desc":"d","out":{"a":1}}\n{"id":"p2","out":"THROW:boom"}\n{bad');
  expect(p.run).toEqual({ p1: '{"a":1}', p2: "THROW:boom" });
  expect(p.probes.map((x) => x.desc)).toEqual(["d", "p2"]);
  const g = parseProbeOutput(`{"id":"p9","out":"code under test printed this"}\nxx${PROBE_MARK}{"id":"p1","desc":"d","out":"1"}\n${PROBE_MARK}{"id":"p1","desc":"dup","out":"2"}`, PROBE_MARK);
  expect(g.run).toEqual({ p1: "1" });
});

test("disagreements ignore failing entrants, unanimous probes and entrants without an output", () => {
  const d = disagreements([e("c1", { p1: "1", p2: "x", p3: "k" }), e("c2", { p1: "1", p2: "y" }), e("c3", { p1: "9" }, false)], probes("p1", "p2", "p3"));
  expect(d.map((x) => x.probeId)).toEqual(["p2"]);
  expect(d[0]!.options.map((o) => o.entrants)).toEqual([["c1"], ["c2"]]);
});

test("verdict parsing tolerates markdown, case, 'option', view ids and a trailing reason", () => {
  expect([...parseVerdicts("**p1**: B\np2: unknown\np3 : a\np4: option B\nnoise\np5.2: A - keeps raw spelling\n- PROBE p6.1: C")]).toEqual([["p1", "B"], ["p2", "unknown"], ["p3", "A"], ["p4", "B"], ["p5.2", "A"], ["p6.1", "C"]]);
});

test("order-swap views: a verdict counts only when both views pick the same output", () => {
  const ents = [e("a", { p: "x" }), e("b", { p: "y" })], d = disagreements(ents, probes("p")), views = judgeViews(d);
  expect(views.map((v) => [v.viewId, v.options.map((o) => o.out).join("")])).toEqual([["p.1", "xy"], ["p.2", "yx"]]);
  expect(resolveVerdicts(views, new Map([["p.1", "B"], ["p.2", "A"]]))).toEqual(new Map([["p", "y"]]));
  expect(resolveVerdicts(views, new Map([["p.1", "A"], ["p.2", "A"]])).size).toBe(0); // position answer
  expect(resolveVerdicts(views, new Map([["p.1", "B"]])).size).toBe(0); // one view unanswered
  expect(resolveVerdicts(views, new Map([["p.1", "unknown"], ["p.2", "unknown"]])).size).toBe(0);
});

test("without an agent: adjudicated winner beats smaller diff; no verdicts fall back to cluster size", () => {
  const ents = [e("c1", { p: "a" }, true, 2), e("c2", { p: "b" }, true, 9), e("c3", { p: "b" }, true, 9)];
  const d = disagreements(ents, probes("p"));
  expect(select(ents, d, new Map([["p", "a"]])).winner).toBe("c1");
  expect(select(ents, d, new Map()).winner).toBe("c2"); // majority behavior
});

test("no disagreement keeps the agent tree", () => {
  const ents = [e("agent", { p: "a" }, true, 0), e("c1", { p: "a" }, true, 0)];
  expect(select(ents, [], new Map(), { agentId: "agent" })).toMatchObject({ winner: "agent", displaced: false });
});

// ---------- the wrong-judge proof ----------
// The agent is right ("raw"); three candidates share a wrong behavior ("trimmed") and pass the same checks.
const agentRight = () => [e("agent", { p1: "raw", p2: "raw2" }, true, 0, { S1: "green", A1: "green" }), e("c1", { p1: "trimmed", p2: "trimmed2" }, true, 2, { S1: "green", A1: "red" }), e("c2", { p1: "trimmed", p2: "trimmed2" }, true, 2, { S1: "green", A1: "red" }), e("c3", { p1: "trimmed", p2: "raw2" }, true, 3, { S1: "green", A1: "green" })];

test("wrong judge 1, silent: no verdicts never displace the agent, even against a 3-candidate majority", () => {
  const ents = agentRight(), { d, picks } = judgeWith(ents, ["p1", "p2"], () => "unknown");
  expect(select(ents, d, picks, { agentId: "agent" })).toMatchObject({ winner: "agent", displaced: false });
  expect(select(ents, d, picks).winner).not.toBe("agent"); // the round-1 rule (no incumbent) hands it to the majority
});

test("wrong judge 2, positional: always 'A' is inconsistent across the two views and scores nothing", () => {
  const ents = agentRight(), { d, picks } = judgeWith(ents, ["p1", "p2"], () => "A");
  expect(picks.size).toBe(0);
  expect(select(ents, d, picks, { agentId: "agent" }).winner).toBe("agent");
});

test("wrong judge 3, split: a challenger that loses any consistent verdict to the agent cannot displace it", () => {
  const ents = agentRight(); // c3 differs from the agent on p1 only... give it a p2 loss too
  ents[3]!.run = { p1: "trimmed", p2: "other" };
  const { d, picks } = judgeWith(ents, ["p1", "p2"], (o, v) => (v.startsWith("p1") ? labelOf(o, "trimmed") : labelOf(o, "raw2")));
  expect(select(ents, d, picks, { agentId: "agent" }).winner).toBe("agent");
});

test("wrong judge 4, backs a tree that fails a spec case the agent passes: the spec veto keeps the agent", () => {
  const ents = agentRight().slice(0, 3); // c1 and c2: the trimmed behavior, and both fail spec case A1 that the agent passes
  const { d, picks } = judgeWith(ents, ["p1", "p2"], (o) => labelOf(o, o.find((x) => x.out.startsWith("trimmed"))!.out));
  expect(picks.size).toBe(2); // the judge is consistent, and consistently wrong
  const p = select(ents, d, picks, { agentId: "agent" });
  expect(p.winner).toBe("agent");
  expect(p.reason).toContain("regresses A1");
});

test("wrong judge 5, wrong once: margin 2 keeps the agent; margin 1 is the documented limit", () => {
  const ents = [e("agent", { p1: "raw", p2: "same" }, true, 0, { S1: "green" }), e("c1", { p1: "trimmed", p2: "same" }, true, 2, { S1: "green" })];
  const { d, picks } = judgeWith(ents, ["p1", "p2"], (o) => labelOf(o, "trimmed"));
  expect(select(ents, d, picks, { agentId: "agent", margin: 2 }).winner).toBe("agent");
  expect(select(ents, d, picks, { agentId: "agent", margin: 1 }).winner).toBe("c1"); // one consistent wrong verdict is enough at margin 1
});

test("right judge: a consistent margin with no loss and no spec regression does displace a wrong agent", () => {
  const ents = [e("agent", { p1: "trimmed", p2: "trimmed2", p3: "s" }, true, 0, { S1: "green", A1: "red" }), e("c1", { p1: "raw", p2: "raw2", p3: "s" }, true, 3, { S1: "green", A1: "green" }), e("c2", { p1: "trimmed", p2: "trimmed2", p3: "s" }, true, 2, { S1: "green", A1: "red" })];
  const { d, picks } = judgeWith(ents, ["p1", "p2", "p3"], (o) => labelOf(o, o.find((x) => x.out.startsWith("raw"))!.out));
  expect(select(ents, d, picks, { agentId: "agent", margin: 2 })).toMatchObject({ winner: "c1", displaced: true });
});

test("an agent that fails its checks is replaced by the best check-passing challenger", () => {
  const ents = [e("agent", {}, false, 0), e("c1", { p: "a" }, true, 2), e("c2", { p: "b" }, true, 2)];
  const d = disagreements(ents, probes("p"));
  expect(select(ents, d, new Map([["p", "b"]]), { agentId: "agent" })).toMatchObject({ winner: "c2", displaced: true });
});

test("runTournament: reuses a given probe program (no probe call), drops a probe that differs between two base copies", async () => {
  let n = 0; const calls: string[] = [];
  const io: Io = {
    materialize: (edits) => (edits === "agent" ? "agent" : edits.length === 0 ? `base${n++}` : `c-${edits[0]!.replace}`),
    checks: () => true,
    probe: (dir) => [`${PROBE_MARK}{"id":"p1","desc":"padded","out":"${dir === "agent" || dir === "c-good" ? "raw" : dir === "c-bad" ? "trimmed" : "base"}"}`, `${PROBE_MARK}{"id":"p2","desc":"clock","out":"${dir}"}`].join("\n"),
  };
  const llm: LlmCall = async (_s, _u, tag) => {
    calls.push(tag ?? "");
    const z = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    if (tag === "candidates") return { text: "=== CANDIDATE 1 ===\n<<<<<<< SEARCH a.go\nx\n=======\nbad\n>>>>>>> REPLACE\n=== CANDIDATE 2 ===\n<<<<<<< SEARCH a.go\nx\n=======\ngood\n>>>>>>> REPLACE\n", usage: z };
    return { text: "p1.1: B\np1.2: A", usage: z }; // judge: wrong (backs trimmed) in both views, consistently
  };
  const r = await runTournament({ issue: "i", files: { "a.go": "x" }, tests: {}, lang: "Go" }, llm, io, { agent: true, program: "cases", mark: PROBE_MARK, margin: 2 });
  expect(calls).toEqual(["candidates", "judge"]);
  expect(r.unstable).toEqual(["p2"]);
  expect(r.disagreements.map((x) => x.probeId)).toEqual(["p1"]);
  expect(r.pick).toMatchObject({ winner: "agent", displaced: false }); // one consistent wrong verdict < margin 2
});

test("parseGoProbeCases refuses what cannot serve as a probe", () => {
  const ok = "```go\npackage argv\n\nimport \"testing\"\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe(\"p1\", \"d\", func() any { return 1 })\n}\n```";
  expect(parseGoProbeCases(ok, "argv")).toHaveProperty("file");
  expect(parseGoProbeCases(ok, "other")).toEqual({ refused: "probe_wrong_package: expected package other" });
  expect(parseGoProbeCases(ok.replace("return 1", "os.Exit(1); return 1"), "argv")).toEqual({ refused: "probe_banned_call" });
  expect(parseGoProbeCases(ok.replace("func TestLokiProbe(t *testing.T) {", "func lokiProbe(a, b string, f func() any) {}\nfunc TestLokiProbe(t *testing.T) {"), "argv")).toEqual({ refused: "probe_banned_call" });
  expect(parseGoProbeCases("```go\npackage argv\nfunc TestOther(t *testing.T) {}\n```", "argv")).toEqual({ refused: "probe_no_block" });
});

// Real go test: a panic is recorded, not fatal; pointer addresses and the tree path are scrubbed, so two copies of the same
// tree in two directories print identical lines. Skips cleanly without a Go toolchain.
const goOnPath = Bun.which("go") !== null;
test.skipIf(!goOnPath)("real go test: the probe runner survives panics and prints stable lines across two tree copies", () => {
  const root = mkdtempSync(join(tmpdir(), "loki-tourn-go-"));
  try {
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(src, "go.mod"), "module example.com/p\n\ngo 1.22\n");
    writeFileSync(join(src, "p.go"), 'package p\n\nimport (\n\t"errors"\n\t"os"\n\t"path/filepath"\n)\n\ntype T struct{ n *int }\n\nfunc Div(a, b int) int { return a / b }\nfunc Ptr() *T { x := 1; return &T{n: &x} }\nfunc Where() string { d, _ := os.Getwd(); return filepath.Join(d, "x") }\nfunc Fail() error { return errors.New("boom") }\n');
    writeFileSync(join(src, "p_test.go"), 'package p\n\nimport "testing"\n\nfunc TestDiv(t *testing.T) { if Div(4, 2) != 2 { t.Fatal() } }\n');
    const cases = 'package p\n\nimport "testing"\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe("p1", "4/2", func() any { return Div(4, 2) })\n\tlokiProbe("p2", "divide by zero", func() any { return Div(1, 0) })\n\tlokiProbe("p3", "pointer struct", func() any { return Ptr() })\n\tlokiProbe("p4", "tree path", func() any { return Where() })\n\tlokiProbe("p5", "error and value", func() any { return []any{Fail(), 7} })\n}\n';
    const runs = ["a", "b"].map((k) => { const d = join(root, k, "tree"); mkdirSync(join(root, k)); cpSync(src, d, { recursive: true }); return runGoProbe(d, "", "p", cases, 60_000); });
    for (const r of runs) expect(r.built).toBe(true);
    const [a, b] = runs.map((r) => parseProbeOutput(r.stdout, PROBE_MARK).run);
    expect(a!.p1).toBe("2");
    expect(a!.p2).toStartWith("PANIC: runtime error: integer divide by zero");
    expect(a!.p3).toContain("0x?");
    expect(a!.p4).toBe('"<ROOT>/x"');
    expect(a!.p5).toBe('[error("boom"), 7]');
    expect([...stableIds(a!, b!)].sort()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    const broken = runGoProbe(join(root, "a", "tree"), "", "p", cases.replace("Div(4, 2) })", "Nope(4, 2) })"), 60_000);
    expect(broken.built).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
