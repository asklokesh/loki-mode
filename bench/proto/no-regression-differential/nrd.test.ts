// Hermetic tests for the no-regression differential prototype: bun test bench/proto/no-regression-differential/nrd.test.ts
// The logic tests need nothing; the go test e2e runs the real Go runner on the fixtures and skips when go is not on PATH.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goCaseBlocks, normalizeOut, parseProbeOutput, pruneGoProgram } from "../../../loki-ts/src/features/probes.ts";
import { callersOf, compareRuns, editedSymbols, nrdFailureGroups, parseNrdVerdicts, runNoRegression, SYS_NRD_JUDGE, type NrdContext, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import type { LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { treeIo } from "./tree_io.ts";

const zero = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
const here = import.meta.dir;

test("prefixed probe lines win over JSON the code under test prints", () => {
  const p = parseProbeOutput('{"id":"x","out":1}\nLOKI_PROBE {"id":"k1","kind":"keep","desc":"d","out":["a"]}\nLOKI_PROBE {"id":"k1","out":"dup"}\n=== RUN TestLokiProbe');
  expect(p.run).toEqual({ k1: '["a"]' });
  expect(p.probes).toEqual([{ id: "k1", desc: "d", kind: "keep" }]);
});

test("normalizeOut masks the tree path and heap addresses only", () => {
  expect(normalizeOut("/w/t1/a.go 0xc000123456 v1.2.0", ["/w/t1"])).toBe("<ROOT>/a.go 0x<ADDR> v1.2.0");
});

test("compareRuns: a case counts only when both runs of each tree agree", () => {
  const probes = [{ id: "same", desc: "", kind: "keep" }, { id: "chg", desc: "", kind: "keep" }, { id: "flk", desc: "", kind: "keep" }, { id: "gone", desc: "", kind: "keep" }, { id: "pflk", desc: "", kind: "keep" }];
  const b = { same: "1", chg: "a", flk: "t1", gone: "x", pflk: "q" }, b2 = { ...b, flk: "t2" };
  const p = { same: "1", chg: "b", flk: "t3", pflk: "r" }, p2 = { ...p, flk: "t4", pflk: "s" };
  expect(Object.fromEntries(compareRuns([b, b2], [p, p2], probes).map((c) => [c.id, c.status]))).toEqual({ same: "same", chg: "changed", flk: "flaky", gone: "missing_patched", pflk: "flaky" });
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
