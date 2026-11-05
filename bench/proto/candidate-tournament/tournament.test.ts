// Hermetic logic tests for the tournament prototype: bun test bench/proto/candidate-tournament/tournament.test.ts
import { expect, test } from "bun:test";
import { applyEdits, disagreements, parseCandidates, parseProbeOutput, parseVerdicts, select, type Entrant } from "../../../loki-ts/src/features/tournament.ts";

const e = (id: string, run: Record<string, string>, checksPass = true, diffLines = 4): Entrant => ({ id, lens: id, dir: "/x", checksPass, run, diffLines });

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

test("probe output keeps JSON lines only", () => {
  const p = parseProbeOutput('noise\n{"id":"p1","desc":"d","out":{"a":1}}\n{"id":"p2","out":"THROW:boom"}\n{bad');
  expect(p.run).toEqual({ p1: '{"a":1}', p2: "THROW:boom" });
  expect(p.probes.map((x) => x.desc)).toEqual(["d", "p2"]);
});

test("disagreements ignore failing entrants and unanimous probes", () => {
  const d = disagreements([e("c1", { p1: "1", p2: "x" }), e("c2", { p1: "1", p2: "y" }), e("c3", { p1: "9" }, false)], [{ id: "p1", desc: "" }, { id: "p2", desc: "" }]);
  expect(d.map((x) => x.probeId)).toEqual(["p2"]);
  expect(d[0]!.options.map((o) => o.entrants)).toEqual([["c1"], ["c2"]]);
});

test("adjudicated winner beats smaller diff; unknown verdicts fall back to cluster size", () => {
  const ents = [e("c1", { p: "a" }, true, 2), e("c2", { p: "b" }, true, 9), e("c3", { p: "b" }, true, 9)];
  const d = disagreements(ents, [{ id: "p", desc: "" }]);
  expect(select(ents, d, new Map([["p", "A"]])).winner).toBe("c1");
  expect(select(ents, d, new Map([["p", "unknown"]])).winner).toBe("c2"); // majority behavior
});

test("no disagreement keeps the agent tree", () => {
  const ents = [e("agent", { p: "a" }, true, 0), e("c1", { p: "a" }, true, 0)];
  expect(select(ents, [], new Map()).winner).toBe("agent");
});

test("verdict parsing tolerates markdown bold and case", () => {
  expect([...parseVerdicts("**p1**: B\np2: unknown\np3 : a\np4: option B\nnoise")]).toEqual([["p1", "B"], ["p2", "unknown"], ["p3", "A"], ["p4", "B"]]);
});
