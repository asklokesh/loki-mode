// Hermetic tests for features/no_regression.ts on the shared tournament runner: bun test bench/proto/nrd-build/nrd.test.ts
// The go legs run the real go toolchain on scratch copies of the fixtures and skip when go is not on PATH.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { keepLedger, ledgerFor, outputSites, overrideVerdict, parseGoTestJson, postProbeNeeded, probeDiff, probeFindings, replayFindings, testEditOf, uncoveredSites, type Finding } from "../../../loki-ts/src/features/no_regression.ts";
import { probeIntake } from "../../../loki-ts/src/features/tournament.ts";

const here = import.meta.dir, hasGo = spawnSync("go", ["version"]).status === 0;
const gitlogIssue = readFileSync(join(here, "fixtures", "gitlog", "issue.md"), "utf8");

test("testEditOf shows the expectation lines the change rewrote", () => {
  const a = 'func TestR(t *testing.T) {\n\tgot := R()\n\twant := "## v"\n\tif got != want {\n\t}\n}\n', b = a.replace('"## v"', '"### v"');
  expect(testEditOf(a, b, "TestR")).toBe('- want := "## v"\n+ want := "### v"');
  expect(testEditOf(a, a, "TestR")).toBe("");
});
test("replayFindings: pass on base and fail now is a finding, carrying the rewritten lines", () => {
  const a = 'func TestR(t *testing.T) {\n\twant := 1\n}\n', b = a.replace("1", "2");
  const f = replayFindings({ TestR: { ok: true, out: "" }, TestS: { ok: false, out: "" } }, { TestR: { ok: false, out: "bad" }, TestS: { ok: false, out: "x" } }, [{ base: a, patched: b }]);
  expect(f.map((x) => [x.id, x.testEdit])).toEqual([["T_TestR", "- want := 1\n+ want := 2"]]);
});
test("postProbeNeeded: an unnamed caller fires; a named caller and an interface method do not", () => {
  const files = { "p.go": "package p\nfunc logArgs() []string { return nil }\nfunc CommitsCmd() []string { return logArgs() }\nfunc AuthorsCmd() []string { return logArgs() }\ntype A struct{}\ntype B struct{}\nfunc (A) Set(s string) {}\nfunc (B) Set(s string) {}\nfunc Use(a A) { a.Set(\"x\") }\n" };
  expect(postProbeNeeded("fix `CommitsCmd`", ["logArgs"], files)).toEqual(["AuthorsCmd"]);
  expect(postProbeNeeded("fix CommitsCmd and AuthorsCmd", ["logArgs"], files)).toEqual([]);
  expect(postProbeNeeded("fix it", ["A.Set"], files)).toEqual([]);
});
test("override: probe findings only, and only a change the issue never mentions", () => {
  const strip: Finding = { id: "k1", desc: "", before: "## v1.2.0\n\n- Merge pull request #41 from team/export\n", after: "## v1.2.0\n\n- team/export\n", source: "probe" };
  expect(overrideVerdict(gitlogIssue, strip, "requested")).toBe("unrequested");
  expect(overrideVerdict(gitlogIssue, { ...strip, source: "replay" }, "requested")).toBe("requested");
  expect(overrideVerdict(gitlogIssue, { id: "c1", desc: "", before: "[git log --no-merges --pretty=format:%s a..b]", after: "[git log --pretty=format:%s a..b]", source: "probe" }, "requested")).toBe("requested");
});
test("ledger: tagged lines, coverage by tag, and the exec-spec intake adds it only with LOKI_E10_NRD=1", () => {
  const files = { "p.go": 'package p\nimport "fmt"\nfunc A(x string) string { return fmt.Sprintf("a=%s", x) }\nfunc B() string { return "hello world" }\n' };
  const s = outputSites(files, ["A", "B"]);
  expect(keepLedger(s)).toContain("[s1] in A: func A(x string) string { return fmt.Sprintf");
  expect(uncoveredSites(s, [{ id: "p1", desc: "[s1] A" }, { id: "p2", desc: "[s12] B" }]).map((x) => x.id)).toEqual(["s2"]);
  const d = mkdtempSync(join(tmpdir(), "nrd-ledger-"));
  try {
    cpSync(join(here, "fixtures", "flagusage", "repo"), d, { recursive: true });
    const sites = [{ symbol: "FlagLine", file: "flags/flags.go" }];
    delete process.env.LOKI_E10_NRD; expect(probeIntake.ledger(d, sites)).toBe("");
    process.env.LOKI_E10_NRD = "1"; expect(probeIntake.ledger(d, sites)).toBe(ledgerFor(d, sites)); expect(ledgerFor(d, sites)).toContain("[s1]");
  } finally { delete process.env.LOKI_E10_NRD; rmSync(d, { recursive: true, force: true }); }
});
test.skipIf(!hasGo)("go e2e: the shared runner finds an unasked change and nothing on a correct fix; replay reads real go test -json", () => {
  const root = mkdtempSync(join(tmpdir(), "nrd-e2e-"));
  try {
    const fx = join(here, "fixtures", "gitlog"), mk = (n: string, patch: string | null) => { const d = join(root, n); cpSync(join(fx, "repo"), d, { recursive: true }); if (patch) spawnSync("git", ["apply", "-p1", join(fx, "variants", `${patch}.patch`)], { cwd: d }); return d; };
    const base = mk("base", null), bad = mk("bad", "regress-contrib"), good = mk("good", "correct-own");
    const program = 'package changelog\n\nimport "testing"\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe("k1", "Contributors keeps letter case", func() any { return Contributors([]string{"Bo <bo@x.io>", "al <al@x.io>"}) })\n\tlokiProbe("c1", "CommitsCmd", func() any { return CommitsCmd("v1", "HEAD") })\n}\n';
    const env = { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local" };
    Object.assign(process.env, { GOFLAGS: env.GOFLAGS, GOPROXY: "off", GOTOOLCHAIN: "local" });
    expect(probeFindings(probeDiff(base, bad, "changelog", "changelog", program).cases).map((f) => f.id).sort()).toEqual(["c1", "k1"]);
    expect(probeFindings(probeDiff(base, good, "changelog", "changelog", program).cases).map((f) => f.id)).toEqual(["c1"]);
    const j = parseGoTestJson(spawnSync("go", ["test", "-count=1", "-json", "./changelog"], { cwd: bad, encoding: "utf8", env }).stdout);
    expect(Object.keys(j).length).toBeGreaterThan(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
test("override keeps the judge's requested on a reorder, on an output the issue quotes, and marks a test rewrite toward an issue value requested", () => {
  const flag = "Help should list the short alias first\n\nExpected:\n\n    \"  -o, --output\\twrite to file\"\n";
  expect(overrideVerdict(flag, { id: "p10", desc: "", before: '"  --port, -p\\tlisten port (default: 8080)"', after: '"  -p, --port\\tlisten port (default: 8080)"', source: "probe" }, "requested")).toBe("requested");
  const si = 'si: no prefix for infinities\n\nSI(math.Inf(1), "x") returns "+Inf Qx". Return "+Inf x" instead.';
  expect(overrideVerdict(si, { id: "p1", desc: "", before: '"+Inf Qx"', after: '"+Inf x"', source: "probe" }, "requested")).toBe("requested");
  const h = "#105 Force to show decimal\n\nExpect:\nCommafWithDigits(1000.00, 2) => 1,000.00\n";
  const edit = '- {"1.23, 3", CommafWithDigits(1.23, 3), "1.23"},\n+ {"1000, 2", CommafWithDigits(1000, 2), "1,000.00"},';
  expect(overrideVerdict(h, { id: "T_TestC", desc: "", before: "PASS", after: "FAIL", source: "replay", testEdit: edit }, "unrequested")).toBe("requested");
  expect(overrideVerdict(h, { id: "T_TestC", desc: "", before: "PASS", after: "FAIL", source: "replay", testEdit: '+ want := "### v1"' }, "unrequested")).toBe("unrequested");
});
