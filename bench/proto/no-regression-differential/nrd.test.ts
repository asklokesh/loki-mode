// Hermetic tests for the no-regression differential prototype: bun test bench/proto/no-regression-differential/nrd.test.ts
// The logic tests need nothing; the go test e2e runs the real Go runner on the fixtures and skips when go is not on PATH.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goAnyCompat, goCaseBlocks, normalizeOut, parseProbeOutput, pruneGoProgram } from "../../../loki-ts/src/features/probes.ts";
import { callersOf, compareRuns, editedSymbols, nrdFailureGroups, parseNrdVerdicts, probeContext, runNoRegression, SYS_NRD_JUDGE, type NrdContext, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import type { LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { treeIo } from "./tree_io.ts";

const zero = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
const here = import.meta.dir;

test("prefixed probe lines win over JSON the code under test prints", () => {
  const p = parseProbeOutput('{"id":"x","out":1}\nLOKI_PROBE {"id":"k1","kind":"keep","desc":"d","out":["a"]}\nLOKI_PROBE {"id":"k1","out":"dup"}\n=== RUN TestLokiProbe');
  expect(p.run).toEqual({ k1: '["a"]' });
  expect(p.probes).toEqual([{ id: "k1", desc: "d", kind: "keep" }]);
});

test("goAnyCompat rewrites the any type only, never literals, comments, selectors or longer names", () => {
  expect(goAnyCompat("func f(v any, vs ...any) any { s := \"any\"; x.any = 1 // any\n\treturn []any{`any`, anyway} }")).toBe("func f(v interface{}, vs ...interface{}) interface{} { s := \"any\"; x.any = 1 // any\n\treturn []interface{}{`any`, anyway} }");
});

test("normalizeOut masks the tree path and heap addresses only", () => {
  expect(normalizeOut("/w/t1/a.go 0xc000123456 v1.2.0", ["/w/t1"])).toBe("<ROOT>/a.go 0x<ADDR> v1.2.0");
});

test("compareRuns: a case counts only when both runs of each tree agree", () => {
  const probes = [{ id: "same", desc: "", kind: "keep" }, { id: "chg", desc: "", kind: "keep" }, { id: "flk", desc: "", kind: "keep" }, { id: "gone", desc: "", kind: "keep" }, { id: "pflk", desc: "", kind: "keep" }, { id: "bflk", desc: "", kind: "keep" }];
  const b = { same: "1", chg: "a", flk: "t1", gone: "x", pflk: "q", bflk: "u1" }, b2 = { ...b, flk: "t2", bflk: "u2" };
  const p = { same: "1", chg: "b", flk: "t3", pflk: "r", bflk: "u3" }, p2 = { ...p, flk: "t4", pflk: "s" };
  // bflk: unstable on base, stable on the patched tree; without the base-side check it would read as a change
  expect(Object.fromEntries(compareRuns([b, b2], [p, p2], probes).map((c) => [c.id, c.status]))).toEqual({ same: "same", chg: "changed", flk: "flaky", gone: "missing_patched", pflk: "flaky", bflk: "flaky" });
});

test("verdict parsing: unrequested is never read as requested; first answer wins", () => {
  const v = parseNrdVerdicts("**k1**: Unrequested\n- k2: requested (the issue names it)\nCASE k3#2 = unknown\nk1: requested\nnoise");
  expect([...v]).toEqual([["k1", "unrequested"], ["k2", "requested"], ["k3#2", "unknown"]]);
});

test("editedSymbols and callersOf find the blast radius of a shared helper", () => {
  const base = readFileSync(join(here, "fixtures/gitlog/repo/changelog/changelog.go"), "utf8");
  const patched = base.replace('"git", "log", "--no-merges", "--pretty=format:" + format', '"git", "log", "--pretty=format:" + format');
  expect(editedSymbols("changelog.go", base, patched)).toEqual(["logArgs"]);
  expect(callersOf(["logArgs"], { "changelog.go": base })).toEqual(["AuthorsCmd", "CommitsCmd"]);
});

test("probeContext: a changed file is shown even when its edit only adds a function; a large file shows its head and the named definitions", () => {
  const small = "package p\n\nfunc A() int { return 1 }\n";
  const big = `package p\n\nimport "fmt"\n\n${Array.from({ length: 400 }, (_, i) => `func F${i}() string { return fmt.Sprint(${i}) }`).join("\n")}\n\nfunc Target() string { return F1() }\n`;
  const c = probeContext({ "a.go": small, "big.go": big, "other.go": "package p\n\nfunc Z() {}\n" }, { "a_test.go": "package p\n\nfunc TestTarget(t *testing.T) { _ = Target() }\n\nfunc TestZ(t *testing.T) { Z() }\n" }, ["Target", "NewThing"], ["a.go"]);
  expect(Object.keys(c.files).sort()).toEqual(["a.go", "big.go"]);
  expect(c.files["big.go"]).toContain('import "fmt"');
  expect(c.files["big.go"]).toContain("func Target() string");
  expect(c.files["big.go"]).not.toContain("func F200()");
  expect(c.tests["a_test.go"]).toContain("TestTarget");
  expect(c.tests["a_test.go"]).not.toContain("TestZ");
});

test("pruneGoProgram drops an unused import and the case holding an error, nothing else", () => {
  const prog = 'package p\n\nimport (\n\t"fmt"\n\t"strings"\n)\n\nfunc lokiCases() {\n\tlokiCase("k1", "keep", "a", func() any { return strings.ToUpper("a") })\n\tlokiCase("k2", "keep", "b", func() any {\n\t\treturn nope()\n\t})\n\tlokiCase("k3", "keep", "c", func() any { return 1 })\n}\n';
  expect(goCaseBlocks(prog).map((b) => [b.id, b.start, b.end])).toEqual([["k1", 8, 8], ["k2", 9, 11], ["k3", 12, 12]]);
  const out = './zz_loki_probe_test.go:4:2: "fmt" imported and not used\n./zz_loki_probe_test.go:11:10: undefined: nope';
  const r = pruneGoProgram(prog, out)!;
  expect(r.pruned).toEqual([{ id: "k2", error: "undefined: nope" }]);
  expect(r.program).not.toContain('"fmt"');
  expect(r.program).toContain('lokiCase("k3"');
  expect(pruneGoProgram(prog, "./zz_loki_probe_test.go:1:1: syntax error")).toBeNull(); // an error outside every case
});

test("fix-round input names the case, both outputs and the probe source", () => {
  const g = nrdFailureGroups([{ id: "k1", desc: "AuthorsCmd", before: "A", after: "B", verdict: "unrequested" }], 'func lokiCases() {\n\tlokiCase("k1", "keep", "AuthorsCmd", func() any { return AuthorsCmd("a", "b") })\n}');
  expect(g[0]!.signature).toContain("no-regression k1");
  expect(g[0]!.sample).toContain("printed A before your change and prints B now");
  expect(g[0]!.sample).toContain('return AuthorsCmd("a", "b")');
});

// ---- real go test e2e on the fixtures, stub model ----
const hasGo = Bun.which("go") !== null;
const stubLlm = (fixture: string, truth: Record<string, Verdict>): LlmCall => async (system, user) => ({
  text: system === SYS_NRD_JUDGE ? [...user.matchAll(/^CASE (\S+):/gm)].map((m) => `${m[1]}: ${truth[m[1]!] ?? "unknown"}`).join("\n") : "```go\n" + readFileSync(join(here, "fixtures", fixture, "stub", "probe.go.txt"), "utf8") + "```",
  usage: zero,
});
function ctxOf(fixture: string, pkgDir: string, pkg: string): NrdContext {
  const f = `${pkgDir}/${pkgDir}.go`;
  return { issue: readFileSync(join(here, "fixtures", fixture, "issue.md"), "utf8"), lang: "go", pkg, files: { [f]: readFileSync(join(here, "fixtures", fixture, "repo", f), "utf8") }, tests: {} };
}

test.skipIf(!hasGo)("go e2e: the shared-helper fix fires on the unrelated command string, the correct fix does not", async () => {
  const work = mkdtempSync(join(tmpdir(), "nrd-e2e-"));
  try {
    const fx = join(here, "fixtures", "gitlog"), go = { pkgDir: "changelog", pkg: "changelog" };
    const truth = JSON.parse(readFileSync(join(fx, "stub", "verdicts.json"), "utf8")) as Record<string, Verdict>;
    const bad = await runNoRegression(ctxOf("gitlog", "changelog", "changelog"), stubLlm("gitlog", truth), treeIo(join(fx, "repo"), join(work, "bad"), join(fx, "variants", "regress-shared.patch"), go));
    expect(bad.blocking.map((f) => f.id)).toEqual(["k1"]);
    expect(bad.findings.find((f) => f.id === "k6")?.verdict).toBe("unknown"); // changed, but the judge did not decide: advisory only
    expect(bad.notes.some((n) => n.includes("k7 dropped"))).toBe(true); // a case that does not compile at base is pruned, not fatal
    expect(bad.cases.find((c) => c.id === "k8")?.status).toBe("flaky"); // time.Now differs run to run: ignored
    expect(bad.groups).toHaveLength(1);
    const good = await runNoRegression(ctxOf("gitlog", "changelog", "changelog"), stubLlm("gitlog", truth), treeIo(join(fx, "repo"), join(work, "good"), join(fx, "variants", "correct-param.patch"), go), { program: bad.program });
    expect(good.blocking).toEqual([]);
    expect(good.calls).toBe(0); // reused program, no keep case changed: no judge call
    expect(good.cases.filter((c) => c.status === "changed").map((c) => c.kind)).toEqual(["change", "change"]);
    expect(good.cases.find((c) => c.id === "k6")?.status).toBe("missing_patched"); // logArgs changed signature: advisory, never blocking
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 180_000);

test.skipIf(!hasGo)("go e2e: an unasked rewording of an error message fires; the probe files never stay in the tree", async () => {
  const work = mkdtempSync(join(tmpdir(), "nrd-e2e-"));
  try {
    const fx = join(here, "fixtures", "flagusage"), go = { pkgDir: "flags", pkg: "flags" };
    const io = treeIo(join(fx, "repo"), join(work, "t"), join(fx, "variants", "regress-lookup.patch"), go);
    const r = await runNoRegression(ctxOf("flagusage", "flags", "flags"), stubLlm("flagusage", { k4: "unrequested" }), io);
    expect(r.blocking.map((f) => f.id)).toEqual(["k4"]);
    expect(r.blocking[0]!.before).toBe('["{Name: Short: Usage: Default: Required:false}","ERROR: unknown flag: --nope"]');
    expect(r.blocking[0]!.after).toBe('["{Name: Short: Usage: Default: Required:false}","ERROR: unknown flag \\"--nope\\""]');
    expect(Bun.spawnSync(["ls", join(io.dir, "flags")]).stdout.toString().trim().split("\n").sort()).toEqual(["flags.go", "flags_test.go"]);
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 180_000);

test.skipIf(!hasGo)("go e2e: a module whose go.mod names a language version older than go1.18 still runs the probe", async () => {
  const work = mkdtempSync(join(tmpdir(), "nrd-e2e-"));
  try {
    const src = join(work, "src");
    cpSync(join(here, "fixtures", "gitlog", "repo"), src, { recursive: true });
    writeFileSync(join(src, "go.mod"), "module example.com/gitlog\n\ngo 1.12\n"); // pflag's directive: the predeclared any is rejected here
    const io = treeIo(src, join(work, "t"), join(here, "fixtures", "gitlog", "variants", "regress-shared.patch"), { pkgDir: "changelog", pkg: "changelog" });
    const truth = JSON.parse(readFileSync(join(here, "fixtures", "gitlog", "stub", "verdicts.json"), "utf8")) as Record<string, Verdict>;
    const r = await runNoRegression(ctxOf("gitlog", "changelog", "changelog"), stubLlm("gitlog", truth), io);
    expect(r.cases.length).toBeGreaterThan(5);
    expect(r.blocking.map((f) => f.id)).toEqual(["k1"]);
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 180_000);

// ---- round 3: output-site ledger and edge-value rule ----
import { edgeAdvisory, outputSites, uncoveredSites } from "../../../loki-ts/src/features/no_regression.ts";
test("outputSites lists format calls and literals of the named definitions only, round-robin, with tags", () => {
  const src = 'package p\nimport "fmt"\nfunc A(x string) string { return fmt.Sprintf("a=%s", x) }\nfunc B() string { return "hello world" }\nfunc C() string { return "unrelated text" }\n';
  const s = outputSites({ "p.go": src }, ["A", "B"]);
  expect(s.map((x) => `${x.id} ${x.fn} ${x.kind}`)).toEqual(["s1 A format", "s2 B literal"]);
  expect(s.some((x) => x.text.includes("unrelated"))).toBe(false);
  const cases = [{ id: "k1", kind: "keep", desc: "[s1] A of x", before: "", after: "", status: "same" as const }, { id: "k2", kind: "keep", desc: "[s12] B", before: "", after: "", status: "same" as const }];
  expect(uncoveredSites(s, cases).map((x) => x.id)).toEqual(["s2"]); // k1 covers s1; the tag [s12] must not count as [s1], so s2 stays uncovered
});
test("edgeAdvisory: an Inf/NaN case is advisory unless a repo test line calls the same function with an edge value", () => {
  const tests = { "c_test.go": '{"+Inf", Commaf(math.Inf(1)), "+Inf"},\n{"x", CommafWithDigits(1.23, 2), "1.23"},\n' };
  expect(edgeAdvisory("func() any { return CommafWithDigits(math.Inf(1), 2) }", "CommafWithDigits(+Inf, 2)", tests)).toBe(true);
  expect(edgeAdvisory("func() any { return Commaf(math.Inf(1)) }", "Commaf +Inf", tests)).toBe(false);
  expect(edgeAdvisory("func() any { return CommafWithDigits(1.5, 2) }", "plain", tests)).toBe(false);
});

// ---- round 5: "requested" needs the issue to mention the change ----
import { issueMentionsChange, overrideVerdict } from "../../../loki-ts/src/features/no_regression.ts";
test("override: a change the issue never mentions cannot be requested; the title's bug wording does not count", () => {
  const issue = readFileSync(join(import.meta.dir, "fixtures", "gitlog", "issue.md"), "utf8");
  const strip = { before: "## v1.2.0\n\n- Merge pull request #41 from team/export\n", after: "## v1.2.0\n\n- team/export\n" };
  expect(issueMentionsChange(issue, strip.before, strip.after)).toBe(false);
  expect(overrideVerdict(issue, strip, "requested")).toBe("unrequested");
  const asked = { before: "[git log --no-merges --pretty=format:%s v1.2.0..HEAD]", after: "[git log --pretty=format:%s v1.2.0..HEAD]" };
  expect(overrideVerdict(issue, asked, "requested")).toBe("requested");
  expect(overrideVerdict(issue, strip, "unknown")).toBe("unknown");
});
