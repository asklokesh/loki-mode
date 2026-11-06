#!/usr/bin/env bash
# The implement brief's repo context (roadmap L020, L021, L022). No tests/min test owned brief construction, so
# this one does. Hermetic: the stub provider, no model, no network. Asserts:
#   L020 ranking:   rankRelevant puts the Calc source first on the maven, gradle, dotnet, go and rust fixtures
#                   (tests/min/fixtures/stacks), and briefContext omits the Relevant files block when nothing ranks
#                   instead of listing the head of `git ls-files`.
#   L021 coverage:  on the multi-file fixture tests/min/fixtures/context/ts-invoice (the task names one of the three
#                   files its reference solution changes), the haiku brief names all three solution files and carries
#                   the full body of every solution function; the Opus brief names two and carries no body. Coverage
#                   of solution files and functions must rise from the Opus brief to the haiku brief.
#   L021 budget:    the pack's own token count is exact and never over its budget, on the fixture (6000) and on a
#                   generated repo of large files at budgets 6000 and 800, and no pack at all when no body fits.
#   L021 golden:    the Opus brief is byte-identical to tests/min/fixtures/context/ts-invoice/opus-brief.golden,
#                   produced by the pre-L021 code.
#   L022 record:    contextCoverage computes recall, precision and reads_before_first_edit exactly for a known brief,
#                   diff and result-cost record; the stream parser counts reads before the first edit exactly on a
#                   scripted stream; contextRecallMedian takes the median of the last sealed runs.
#   end to end:     real bin/loki -> committed bundle -> engine10 on the stub provider, LOKI_SESSION_MODEL=haiku: the
#                   implement prompt carries the pack, the implement stage.completed event carries brief_files and
#                   context_pack, and the seal stage.completed event and receipt carry context_recall 1; the same
#                   run on the default model sends no pack but still records brief_files and the coverage.
#   loki stats --outcomes --json reports the median context recall of those runs.
#   L3/L5 rules:    release-note fragment line (changeset, towncrier, changelog.d, newsfragments, changie, none) and the
#                   byte-stable FIXED_RULES prefix (extra planted defects 5 and 6 below).
#
#   E6 diet:        LOKI_E10_PACK_DIET (default on, =0 opts out): one named definition keeps its span and loses the fill, the
#                   solution coverage holds, no test spans.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/context_pack.ts: drop the callee hop (the `for (let hop` loop); the haiku brief loses
#      src/money.ts and roundCents, so the coverage assertions fail.
#   2. loki-ts/src/util/context_pack.ts: `if (used + c > budgetBytes) return false;` deleted; the budget legs fail.
#   3. loki-ts/src/engine10/stages/implement.ts: drop `brief_files: bc.files` from the stage data (rebuild dist);
#      the end-to-end brief_files and context_recall assertions fail.
#   5. loki-ts/src/util/context_pack.ts: delete the `if (diet) {` filter block; diet_no_fill fails. Drop the
#      `hop < (diet ? 1 : 2)` bound or the callee hop under diet; diet_keeps_solution fails.
#   4. loki-ts/src/engine10/repomap.ts: SOURCE_EXT back to ts|tsx|js|jsx|mjs|cjs|py; the L020 ranking legs fail.
#   5. loki-ts/src/project_model/conventions.ts releaseNoteConvention: drop the .changeset/config.json branch; the changeset legs fail.
#   6. loki-ts/src/e10ext/context.ts: interpolate the convention line into FIXED_RULES; prefix_stable fails.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need() { command -v "$1" >/dev/null 2>&1 || { echo "context-pack: needs $1" >&2; exit 2; }; }
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: implement brief context: ranking, context pack, budget, coverage record"

CTX="$ROOT/tests/min/fixtures/context"
STACKS="$ROOT/tests/min/fixtures/stacks"
FIX="$ROOT/tests/min/fixtures/e2e"
SRC="$ROOT/loki-ts/src"

commit_copy() { # commit_copy <src dir> <dest dir>
    mkdir -p "$2"
    cp -R "$1"/. "$2"
    git -C "$2" init -q -b main
    git -C "$2" config user.name ctx
    git -C "$2" config user.email ctx@example.invalid
    git -C "$2" add -A .
    git -C "$2" commit -q -m base
}

for s in maven gradle dotnet go rust; do commit_copy "$STACKS/$s" "$T/stacks/$s"; done
commit_copy "$CTX/ts-invoice/repo" "$T/inv"
# A generated repo of large files: the pack must stay inside its budget when every candidate is big.
python3 -I - "$T/big" <<'PY'
import os, sys
root = sys.argv[1]; os.makedirs(os.path.join(root, "src"), exist_ok=True)
for f in range(6):
    body = []
    for k in range(40):
        body.append(f"export function ledgerEntry{f}x{k}(amount: number): number {{\n" + "".join(f"  amount = amount + {i}; // ledger entry balance\n" for i in range(30)) + "  return amount;\n}\n")
    open(os.path.join(root, "src", f"ledger{f}.ts"), "w").write("\n".join(body))
PY
git -C "$T/big" init -q -b main && git -C "$T/big" add -A . && git -C "$T/big" -c user.name=c -c user.email=c@x commit -q -m base

cat > "$T/probe.ts" <<'TS'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [SRC, T, CTX] = process.argv.slice(2) as string[];
const { buildRepoMap } = await import(join(SRC, "engine10/repomap.ts"));
const { rankRelevant } = await import(join(SRC, "util/relevance.ts"));
const { selectRelevantFiles } = await import(join(SRC, "engine10/relevant_files.ts"));
await import(join(SRC, "engine10/stages/implement.ts")); // load order of the engine (context.ts imports through it)
const { briefContext, briefRecord } = await import(join(SRC, "e10ext/context.ts"));
const cp = await import(join(SRC, "util/context_pack.ts"));
const { consumeSdkStream } = await import(join(SRC, "runner/sdk_stream_parser.ts"));
const out: Record<string, unknown> = {};

const targets: Record<string, [string, string]> = { maven: ["src/main/java/demo/Calc.java", "Calc.java"], gradle: ["src/main/java/demo/Calc.java", "Calc.java"], dotnet: ["Calc/Calculator.cs", "Calculator.cs"], go: ["calc/calc.go", "calc.go"], rust: ["src/calc.rs", "calc.rs"] };
for (const [s, [path, named]] of Object.entries(targets)) {
  const map = buildRepoMap(join(T, "stacks", s));
  out[`unnamed_${s}`] = rankRelevant(`make ${s === "dotnet" ? "Calculator.Add" : "Calc.add"} handle overflow`, map, 5).slice(0, 2).some((r: { path: string }) => r.path === path) && map.entries.some((e: { path: string; symbols: string[] }) => e.path === path && e.symbols.some((x) => /^Calc(ulator)?\.(add|Add)$/.test(x))) ? "top2" : JSON.stringify(map.entries.find((e: { path: string }) => e.path === path) ?? null);
  out[`rank_${s}`] = rankRelevant(`make Calc.add handle overflow in ${named}`, map, 5)[0]?.path === path ? "first" : JSON.stringify(rankRelevant(`make Calc.add handle overflow in ${named}`, map, 5));
}

const ctxFor = (repo: string, task: string) => {
  const map = buildRepoMap(repo), ref = join(repo, ".git", "loki-map.json");
  writeFileSync(ref, JSON.stringify(map));
  return { repoDir: repo, outputs: () => ({ intake: { task, repomap_ref: ref } }), tests: { impacted: () => [] } };
};
const deps = { select: selectRelevantFiles, cmd: () => ["true", []] };
out.no_rank_block = briefContext(ctxFor(join(T, "stacks", "maven"), "zzqx wvvy"), deps).includes("Relevant files:") ? "present" : "omitted";

// Coverage of the reference solution: files it changes, and functions whose lines it changes (full body in the brief).
const task = readFileSync(join(CTX, "ts-invoice/task.txt"), "utf8").trim();
const sol: Record<string, string[]> = { "src/invoice.ts": ["invoiceTotal"], "src/tax.ts": ["RATES"], "src/money.ts": ["roundCents"] };
const coverage = (text: string, files: string[]) => {
  let f = 0, b = 0, n = 0;
  const lines = new Set(text.split("\n").map((l) => l.trim()));
  for (const [file, fns] of Object.entries(sol)) {
    if (files.includes(file)) f++;
    const src = readFileSync(join(T, "inv", file), "utf8");
    for (const name of fns) {
      n++;
      const s = cp.symbolSpans(file, src).find((x: { name: string }) => x.name === name);
      if (s && src.split("\n").slice(s.start - 1, s.end).map((l: string) => l.trim()).filter(Boolean).every((l: string) => lines.has(l))) b++;
    }
  }
  return `${f}/${Object.keys(sol).length} ${b}/${n}`;
};
const ictx = ctxFor(join(T, "inv"), task);
const opus = briefRecord(ictx, deps, "claude-opus-4-6"); process.env.LOKI_E10_PACK_DIET = "0"; const haiku = briefRecord(ictx, deps, "haiku"); delete process.env.LOKI_E10_PACK_DIET; // L021 pins the fill path; the diet is covered below
out.cov_opus = coverage(opus.text, opus.files);
out.cov_haiku = coverage(haiku.text, haiku.files);
out.opus_golden = opus.text === readFileSync(join(CTX, "ts-invoice/opus-brief.golden"), "utf8") && opus.text === briefContext(ictx, deps) && opus.pack === null ? "identical" : "differs";
out.pack_present = haiku.text.includes("Code that matters") && haiku.pack !== null ? "yes" : "no";
out.pack_spans = (haiku.pack?.spans ?? []).map((s: { path: string; start: number; end: number }) => `${s.path}:${s.start}-${s.end}`).join(",");
const packText = haiku.text.slice(haiku.text.indexOf("Code that matters"));
out.pack_tokens_exact = haiku.pack && haiku.pack.tokens <= 6000 && haiku.pack.budget_tokens === 6000 ? "ok" : `bad ${JSON.stringify(haiku.pack)}`;
out.pack_anchor = /^--- src\/money\.ts:\d+-\d+$/m.test(packText) ? "yes" : "no";

for (const budget of [6000, 800]) {
  const p = cp.contextPack(join(T, "big"), "fix the ledger entry balance", ["src/ledger0.ts", "src/ledger1.ts", "src/ledger2.ts"], buildRepoMap(join(T, "big")).entries, budget);
  out[`big_${budget}`] = p && p.tokens <= budget && p.tokens === cp.estTokens(p.text) && p.spans.length > 0 ? "within" : `over ${p?.tokens} spans ${p?.spans.length}`;
}

// E6 diet: named spans plus direct callers and callees only, no fill. On by default; LOKI_E10_PACK_DIET=0 opts out.
{
  const big = join(T, "big"), bmap = buildRepoMap(big).entries, files = ["src/ledger0.ts", "src/ledger1.ts", "src/ledger2.ts"], bt = "fix ledgerEntry0x3 so the ledger entry balance stays a number";
  const gt = "fix the ledger entry balance", gen = cp.contextPack(big, gt, files, bmap, 6000, { LOKI_E10_PACK_DIET: "0" }), genDef = cp.contextPack(big, gt, files, bmap, 6000, {}), genDiet = cp.contextPack(big, gt, files, bmap, 6000, { LOKI_E10_PACK_DIET: "1" });
  const base = cp.contextPack(big, bt, files, bmap, 6000, { LOKI_E10_PACK_DIET: "0" }), diet = cp.contextPack(big, bt, files, bmap, 6000, {});
  out.diet_default_on = cp.packDietEnabled({}) === true && cp.packDietEnabled({ LOKI_E10_PACK_DIET: "1" }) === true && cp.packDietEnabled({ LOKI_E10_PACK_DIET: "0" }) === false && JSON.stringify(genDef) === JSON.stringify(genDiet) && JSON.stringify(gen) !== JSON.stringify(genDef) ? "yes" : "no";
  out.diet_no_fill = gen && genDiet && gen.spans.length > 3 && genDiet.spans.length === 1 && genDiet.tokens < gen.tokens / 2 ? "yes" : `no fill ${gen?.spans.length}/${gen?.tokens} diet ${genDiet?.spans.length}/${genDiet?.tokens}`;
  out.diet_named_only = base && diet && diet.spans.length === 1 && diet.spans[0].symbol === "ledgerEntry0x3" && diet.spans[0].via === "named" ? "yes" : `no ${JSON.stringify(diet?.spans)}`;
  const dctx = ctxFor(join(T, "inv"), task);
  process.env.LOKI_E10_PACK_DIET = "0"; const d0 = briefRecord(dctx, deps, "haiku"); delete process.env.LOKI_E10_PACK_DIET; const d1 = briefRecord(dctx, deps, "haiku");
  out.diet_keeps_solution = d1.pack && d1.pack.tokens < d0.pack.tokens && coverage(d1.text, d1.files) === "3/3 2/3" ? "yes" : `no ${d1.pack?.tokens}/${d0.pack?.tokens} ${coverage(d1.text, d1.files)}`;
  const tmap = buildRepoMap(join(T, "inv")).entries;
  out.diet_no_tests = (cp.contextPack(join(T, "inv"), task, ["src/invoice.ts", "src/invoice.test.ts"], tmap, 6000, { LOKI_E10_PACK_DIET: "1" })?.spans ?? []).every((x: { path: string }) => !/test/.test(x.path)) ? "yes" : "no";
}
out.tiny_null = cp.contextPack(join(T, "big"), "fix ledgerEntry0x3", ["src/ledger0.ts"], [], 50) === null ? "yes" : "no";

// L022: known brief, known diff (name-status pairs), known result-cost record.
const rc = join(T, "covrepo", ".loki", "metrics"); mkdirSync(rc, { recursive: true });
writeFileSync(join(rc, "result-cost-run1-impl.json"), JSON.stringify({ reads_before_first_edit: 3 }));
const c = cp.contextCoverage({ brief_files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], iteration_ids: ["run1-impl"] }, ["M", "src/a.ts", "M", "src/z.ts", "A", "src/new.ts", "M", "test/a.test.ts", "D", "src/b.ts"], join(T, "covrepo"));
out.cov_record = `${c?.context_recall} ${c?.context_precision} ${c?.reads_before_first_edit} ${c?.changed_files}`;

// The stream parser: Read, Grep, a repeated snapshot of the same Read, then Edit, then a later Read.
const sdkDir = join(T, "sdk"); mkdirSync(sdkDir, { recursive: true });
const tu = (id: string, name: string, mid: string) => ({ type: "assistant", message: { id: mid, content: [{ type: "tool_use", id, name, input: { file_path: "x" } }], usage: { input_tokens: 1, output_tokens: 1 } } });
await consumeSdkStream([tu("t1", "Read", "m1"), tu("t1", "Read", "m1"), tu("t2", "Grep", "m2"), tu("t3", "Glob", "m3"), tu("t4", "Edit", "m4"), tu("t5", "Read", "m5"), { type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" }], { cwd: sdkDir, iteration: "it1", hookEventsEnabled: false, write: () => {} });
out.stream_reads = JSON.parse(readFileSync(join(sdkDir, ".loki/metrics/result-cost-it1.json"), "utf8")).reads_before_first_edit;

const runs = join(T, "medruns");
[0.5, 1, 0.25].forEach((r, i) => { mkdirSync(join(runs, `r${i}`), { recursive: true }); writeFileSync(join(runs, `r${i}`, "receipt.json"), JSON.stringify({ context: { context_recall: r } })); });
mkdirSync(join(runs, "r9"), { recursive: true }); writeFileSync(join(runs, "r9", "receipt.json"), JSON.stringify({ verdict: "PARTIAL" }));
const m = cp.contextRecallMedian(runs);
out.median = `${m.median} ${m.n} ${m.runs_considered}`;
// L3/L5: release-note fragment convention line and the byte-stable rule prefix.
const { releaseNoteBrief } = await import(join(SRC, "project_model/conventions.ts"));
const { buildImplementBrief } = await import(join(SRC, "engine10/stages/implement.ts"));
const { FIXED_RULES } = await import(join(SRC, "e10ext/context.ts"));
const { utimesSync } = await import("node:fs");
const mk = (name: string, files: Record<string, string>) => { const d = join(T, "rn", name); for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); } return d; };
const csRepo = mk("cs", { ".changeset/config.json": "{}", ".changeset/old-fix.md": "x", ".changeset/new-fix.md": "y", ".changeset/README.md": "r", "package.json": '{"name":"rootpkg"}', "packages/core/package.json": '{"name":"@acme/core"}', "packages/core/src/a.ts": "export const a = 1;\n" });
utimesSync(join(csRepo, ".changeset/old-fix.md"), 1000, 1000); utimesSync(join(csRepo, ".changeset/new-fix.md"), 2000, 2000);
out.rn_changeset = releaseNoteBrief(csRepo, ["packages/core/src/a.ts"]);
out.rn_changeset_root = releaseNoteBrief(csRepo, []);
out.rn_towncrier = releaseNoteBrief(mk("tc", { "pyproject.toml": '[tool.towncrier]\ndirectory = "docs/news"\n', "docs/news/12.bugfix.md": "z" }), []);
out.rn_changelogd = releaseNoteBrief(mk("cd", { "changelog.d/20240101_fix.md": "z" }), []);
out.rn_newsfrag = releaseNoteBrief(mk("nf", { "newsfragments/7.feature.rst": "z" }), []);
out.rn_changie = releaseNoteBrief(mk("ch", { ".changes/unreleased/Fixed-1.yaml": "z" }), []);
out.rn_none = releaseNoteBrief(mk("no", { "package.json": '{"name":"p"}', "CHANGELOG.md": "# c" }), []) === "" ? "empty" : "present";
const bp = (rm: string, task: string) => buildImplementBrief(task, null, [], rm);
const b1 = bp(out.rn_changeset as string, "task one"), b2 = bp("", "a different task entirely");
const cut = (b: string) => b.slice(0, b.indexOf(FIXED_RULES) + FIXED_RULES.length);
out.prefix_stable = b1.includes(FIXED_RULES) && b2.includes(FIXED_RULES) && cut(b1) === cut(b2) && !FIXED_RULES.includes("Release-note convention") && b1.indexOf("Release-note convention") > FIXED_RULES.length ? "yes" : "no";
out.rules = ["read the whole function", "sibling branches", "fix the issue prefers", "never npm test", "release-note fragment a repository convention"].map((k) => FIXED_RULES.includes(k) ? "y" : "n").join("");
// L3 fragment writer: deterministic release-note fragment from the repo's own convention (LOKI_E10_SCAFFOLD).
const { writeReleaseNoteFragment: wf, summaryNote, taskForbidsReleaseNote, fragmentWriterOn, fragmentNoticeLine } = await import(join(SRC, "project_model/conventions.ts"));
const { readFileSync: rf, existsSync: ex, readdirSync: rd } = await import("node:fs");
const csFiles = (extra: Record<string, string> = {}) => ({ ".changeset/config.json": '{"ignore":["@acme/ignored"]}', ".changeset/old.md": '---\n"@acme/core": patch\n---\n\nOlder fix.\n', "package.json": '{"name":"root","private":true,"workspaces":["packages/*"]}', "packages/core/package.json": '{"name":"@acme/core"}', "packages/core/src/a.ts": "export const a = 1;\n", "packages/priv/package.json": '{"name":"@acme/priv","private":true}', "packages/priv/src/p.ts": "x\n", "packages/ignored/package.json": '{"name":"@acme/ignored"}', "packages/ignored/src/i.ts": "x\n", "fixtures/demo/package.json": '{"name":"demo-fixture"}', "fixtures/demo/d.ts": "x\n", ...extra });
const TITLE = "Fix wrong total when the invoice has no lines (#12)", SUMMARY = "I read the code.\n\nThe total now returns 0 for an invoice without line items instead of NaN.\n\nLOKI_DONE";
const w1 = mk("w1", csFiles()), r1 = wf(w1, ["packages/core/src/a.ts"], TITLE, SUMMARY, { tools: false }) as { path?: string; body?: string; validated?: string; skipped?: string };
out.fw_path = r1.path ?? `skipped:${r1.skipped}`;
const t1 = r1.path ? rf(join(w1, r1.path), "utf8") : "";
out.fw_front = t1.startsWith('---\n"@acme/core": patch\n---\n\n') ? "ok" : `bad:${JSON.stringify(t1)}`;
out.fw_body = t1.endsWith("Fix wrong total when the invoice has no lines. The total now returns 0 for an invoice without line items instead of NaN.\n") ? "ok" : `bad:${JSON.stringify(t1)}`;
out.fw_validated = r1.validated;
const w1q = mk("w1q", csFiles({ ".changeset/old.md": "---\n'@acme/core': patch\n---\n\nOlder fix.\n" })), r1q = wf(w1q, ["packages/core/src/a.ts"], TITLE, "", { tools: false }) as { path?: string };
out.fw_quote = r1q.path && rf(join(w1q, r1q.path), "utf8").startsWith("---\n'@acme/core': patch") ? "ok" : "bad";
const skip = (name: string, repo: string, files: string[], task = TITLE, sum = SUMMARY) => { const r = wf(repo, files, task, sum, { tools: false }) as { skipped?: string; path?: string }; return r.skipped ? "skipped" : `wrote:${r.path}`; };
out.fw_no_task = skip("a", mk("w2", csFiles()), ["packages/core/src/a.ts"], "Fix the total, no changelog needed");
out.fw_has_frag = skip("b", mk("w3", csFiles({ ".changeset/mine.md": "---\n'@acme/core': patch\n---\n\nx\n" })), ["packages/core/src/a.ts", ".changeset/mine.md"]);
out.fw_no_conv = skip("c", mk("w4", { "package.json": '{"name":"p"}', "CHANGELOG.md": "# c", "a.ts": "x" }), ["a.ts"]);
out.fw_tests_only = skip("d", mk("w5", csFiles({ "packages/core/src/a.test.ts": "x\n" })), ["packages/core/src/a.test.ts"]);
out.fw_docs_only = skip("e", mk("w6", csFiles({ "packages/core/README.md": "x\n" })), ["packages/core/README.md"]);
out.fw_private = skip("f", mk("w7", csFiles()), ["packages/priv/src/p.ts"]);
out.fw_ignored = skip("g", mk("w8", csFiles()), ["packages/ignored/src/i.ts"]);
out.fw_not_workspace = skip("h", mk("w9", csFiles()), ["fixtures/demo/d.ts"]);
out.fw_deleted = skip("i", mk("w10", csFiles()), ["packages/core/src/gone.ts"]);
out.fw_no_title = skip("j", mk("w11", csFiles()), ["packages/core/src/a.ts"], "x", "LOKI_DONE");
out.fw_other_kind = skip("k", mk("w12", { "changelog.d/1.md": "z", "a.ts": "x" }), ["a.ts"]);
const w13 = mk("w13", csFiles()); const r13 = wf(w13, ["packages/core/src/a.ts"], "Add a --json flag to the exporter", "", { tools: false }) as { path?: string };
// untracked generated output is not a code change; tracked changes and real new files are (git fixture)
const { spawnSync: sp } = await import("node:child_process");
const gitRepo = (name: string, extra: Record<string, string> = {}) => { const d = mk(name, csFiles(extra)); for (const a of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]]) sp("git", a, { cwd: d }); return d; };
const addFiles = (d: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c); };
const gen1 = gitRepo("gen1"); addFiles(gen1, { "packages/core/src/api.gen.ts": "export const x = 1;\n", "packages/core/src/schema.ts": "// @generated by codegen\nexport const s = 1;\n", "packages/core/src/query.min.js": "x" });
out.fw_gen_untracked = skip("q", gen1, ["packages/core/src/api.gen.ts", "packages/core/src/schema.ts", "packages/core/src/query.min.js"]);
const gen2 = gitRepo("gen2"); addFiles(gen2, { "packages/core/src/a.ts": "export const a = 2;\n" });
out.fw_gen_tracked_edit = skip("r", gen2, ["packages/core/src/a.ts"]).startsWith("wrote") ? "wrote" : "skipped";
const gen3 = gitRepo("gen3"); addFiles(gen3, { "packages/core/src/b.ts": "export const b = 1;\n", "packages/core/src/api.gen.ts": "x\n" });
out.fw_gen_new_real = skip("s", gen3, ["packages/core/src/b.ts", "packages/core/src/api.gen.ts"]).startsWith("wrote") ? "wrote" : "skipped";
const gen4 = gitRepo("gen4", { "packages/core/src/old.gen.ts": "export const o = 1;\n" }); addFiles(gen4, { "packages/core/src/old.gen.ts": "export const o = 2;\n" });
out.fw_gen_tracked_generated = skip("t", gen4, ["packages/core/src/old.gen.ts"]).startsWith("wrote") ? "wrote" : "skipped";
out.fw_minor = r13.path && rf(join(w13, r13.path), "utf8").includes('"@acme/core": minor') ? "ok" : "bad";
// the repo's own tool judges: a stand-in changeset binary that rejects removes the fragment; one that passes marks it validated
const stub = (code: number, msg: string) => csFiles({ "node_modules/.bin/changeset": `#!/bin/sh\necho '${msg}'\nexit ${code}\n` });
const w14 = mk("w14", stub(1, "Error: Found changeset x for package @acme/core which is not in the workspace")); chmodSync(join(w14, "node_modules/.bin/changeset"), 0o755);
const r14 = wf(w14, ["packages/core/src/a.ts"], TITLE, SUMMARY) as { skipped?: string }; out.fw_rejected = r14.skipped && rd(join(w14, ".changeset")).filter((n: string) => n.startsWith("fix-")).length === 0 ? "removed" : "kept";
const w15 = mk("w15", stub(1, "Error: Failed to find where HEAD diverged from main")); chmodSync(join(w15, "node_modules/.bin/changeset"), 0o755);
const r15 = wf(w15, ["packages/core/src/a.ts"], TITLE, SUMMARY) as { validated?: string }; out.fw_env_error = r15.validated === "unavailable" && rd(join(w15, ".changeset")).some((n: string) => n.startsWith("fix-")) ? "kept" : "dropped";
const w16 = mk("w16", stub(0, "ok")); chmodSync(join(w16, "node_modules/.bin/changeset"), 0o755);
out.fw_tool_ok = (wf(w16, ["packages/core/src/a.ts"], TITLE, SUMMARY) as { validated?: string }).validated;
out.fw_internal = ["chore: remove dead code", "refactor(core): split the loader", "docs: explain the flag", "ci: cache deps", "Bump lodash from 1 to 2", "Update dependency vitest to v3", "Merge branch main", "Revert the loader change", "test: more async cases", "build!: drop node 16"].map((t) => skip("m", mk(`wi${t.length}`, csFiles()), ["packages/core/src/a.ts"], t, "")).join(",");
out.fw_internal_ok = ["fix: wrong total when the invoice is empty", "feat(export): add a --json flag", "perf: faster parse of large invoices"].map((t) => skip("n", mk(`wj${t.length}`, csFiles()), ["packages/core/src/a.ts"], t, "")[0]).join("");
const w23 = mk("w23", csFiles()); const r23 = wf(w23, ["packages/core/src/a.ts"], "feat(export): add a --json flag to the exporter", "", { tools: false }) as { path?: string };
out.fw_strip = r23.path && rf(join(w23, r23.path), "utf8").endsWith("\n\nadd a --json flag to the exporter.\n") && rf(join(w23, r23.path), "utf8").includes('"@acme/core": minor') ? "ok" : `bad:${r23.path && rf(join(w23, r23.path), "utf8")}`;
const w24 = mk("w24", csFiles({ ".changeset/old.md": '---\n"@acme/core": patch\n---\n\nfix: older fix\n' })); const r24 = wf(w24, ["packages/core/src/a.ts"], "fix: wrong total when the invoice is empty", "", { tools: false }) as { path?: string };
out.fw_keep_prefix = r24.path && rf(join(w24, r24.path), "utf8").endsWith("\n\nfix: wrong total when the invoice is empty\n") ? "ok" : "bad";
// containment: a directory that resolves outside the repo never receives a write
const { symlinkSync } = await import("node:fs");
mk("wo-out", { "7.feature.rst": "x\n" }); const wo = mk("wo1", { "pyproject.toml": '[tool.towncrier]\ndirectory = "../wo-out"\n', "pkg/mod.py": "x = 1\n" });
out.fw_out_towncrier = (wf(wo, ["pkg/mod.py"], "Fix crash when the cache is empty (#42)", "", { tools: false }) as { skipped?: string }).skipped && !ex(join(T, "rn", "wo-out", "42.bugfix.rst")) ? "skipped" : "wrote";
mk("sl-real", { "config.json": "{}", "old.md": "---\n\"@acme/core\": patch\n---\n\nOlder.\n" });
const sl = mk("sl1", { "package.json": '{"name":"@acme/core"}', "src/a.ts": "x\n" }); symlinkSync(join(T, "rn", "sl-real"), join(sl, ".changeset"));
out.fw_out_symlink = skip("o", sl, ["src/a.ts"]) === "skipped" && rd(join(T, "rn", "sl-real")).length === 2 ? "skipped" : "wrote";
out.fw_ignore_glob = skip("p", mk("wg", csFiles({ ".changeset/config.json": '{"ignore":["@acme/ign*"]}' })), ["packages/ignored/src/i.ts"]);
// towncrier
const tcFiles = (extra: Record<string, string> = {}) => ({ "pyproject.toml": '[tool.towncrier]\ndirectory = "changes"\n', "changes/7.feature.rst": "Added a thing.\n", "changes/_template.rst": "{{ text }}\n", "changes/README.rst": "notes\n", "pkg/mod.py": "x = 1\n", ...extra });
const tw = (repo: string, task: string, files = ["pkg/mod.py"]) => wf(repo, files, task, "", { tools: false }) as { path?: string; skipped?: string };
const w17 = mk("w17", tcFiles()); const r17 = tw(w17, "Fix crash when the cache is empty (#42)");
out.tc_path = r17.path ?? `skipped:${r17.skipped}`; out.tc_text = r17.path ? rf(join(w17, r17.path), "utf8") : "";
out.tc_no_issue = tw(mk("w18", tcFiles()), "Fix crash when the cache is empty").skipped ? "skipped" : "wrote";
out.tc_unclear = tw(mk("w19", tcFiles()), "Rework the cache layout for clarity (#43)").skipped ? "skipped" : "wrote";
out.tc_dup = tw(mk("w20", tcFiles({ "changes/42.bugfix.rst": "Old.\n" })), "Fix crash when the cache is empty (#42)").skipped ? "skipped" : "wrote";
out.tc_no_example = tw(mk("w21", { "pyproject.toml": '[tool.towncrier]\ndirectory = "changes"\n', "changes/.gitkeep": "", "pkg/mod.py": "x" }), "Fix crash when the cache is empty (#42)").skipped ? "skipped" : "wrote";
out.tc_orphan = ((r) => r.path && /\/\+fix-crash-when-the-cache-is\.bugfix\.rst$/.test(r.path) ? "ok" : `bad:${r.path ?? r.skipped}`)(tw(mk("w22", tcFiles({ "changes/+abc.feature.rst": "Added.\n" })), "Fix crash when the cache is empty"));
// summaryNote and the task veto
out.sn_pick = summaryNote("Done.\n\nI changed the loader.\n\nThe loader now skips unreadable files instead of aborting the whole scan.\n\nLOKI_DONE", "Fix loader crash");
out.sn_chatter = summaryNote("Running the unit suite passes in every package now.\n\nLet me know if you want more.\n\nLOKI_DONE", "Fix loader crash") === "" ? "empty" : "picked";
out.sn_restate = summaryNote("Fixed the loader crash when a file is unreadable.", "Fix the loader crash when a file is unreadable") === "" ? "empty" : "picked";
out.sn_table = summaryNote("| a | b |\n| - | - |\n\n```\ncode here is long enough to count as text\n```\n", "Fix x") === "" ? "empty" : "picked";
out.veto = [taskForbidsReleaseNote("Fix x, no changelog entry"), taskForbidsReleaseNote("skip the changeset"), taskForbidsReleaseNote("do not add a news fragment"), taskForbidsReleaseNote("Update the changelog generator to sort entries"), taskForbidsReleaseNote("Fix the release notes page")].join(",");
{ const { renderReviewerBody } = await import(join(SRC, "e10ext/reviewer_body.ts")), L = fragmentNoticeLine(".changeset/x.md");
  const body = (outputs: Record<string, Record<string, unknown>>) => renderReviewerBody({ verdict: "VERIFIED", draftReason: null, notProven: [], receiptPath: null, receiptSha256: null, signed: null, runId: "r", outputs }, {}, "0.0.0");
  out.pr_line = [body({ implement: { scaffold: { path: ".changeset/x.md", kind: "changeset" } } }).includes(`- ${L}`), body({ implement: {} }).includes("Loki added")].join(","); }
out.knob = [fragmentWriterOn({}), fragmentWriterOn({ LOKI_E10_SCAFFOLD: "1" }), fragmentWriterOn({ LOKI_E10_SCAFFOLD: "0" })].join(",");
if (process.env.FW_REAL_CS) { const r = wf(process.env.FW_REAL_CS, ["packages/core/src/a.ts"], TITLE, SUMMARY) as { validated?: string; skipped?: string }; out.fw_real_cs = r.validated ?? `skipped:${r.skipped}`; } else out.fw_real_cs = "offline";
if (process.env.FW_REAL_TC) { const r = wf(process.env.FW_REAL_TC, ["pkg/mod.py"], TITLE, SUMMARY) as { validated?: string; skipped?: string }; out.fw_real_tc = r.validated ?? `skipped:${r.skipped}`; } else out.fw_real_tc = "offline";
console.log(JSON.stringify(out));
TS

# Real-tool fixtures for the fragment writer: the repo's own changeset and towncrier, installed from the registry; both skip cleanly offline.
export FW_REAL_CS="" FW_REAL_TC=""
if command -v npm >/dev/null 2>&1; then
    mkdir -p "$T/real-cs/packages/core/src" "$T/real-cs/.changeset"
    printf '{"name":"root","private":true,"workspaces":["packages/*"]}\n' > "$T/real-cs/package.json"
    printf '{"name":"@acme/core","version":"1.0.0"}\n' > "$T/real-cs/packages/core/package.json"
    printf 'export const a = 1;\n' > "$T/real-cs/packages/core/src/a.ts"
    printf '{"commit":false,"access":"public","baseBranch":"main","ignore":[]}\n' > "$T/real-cs/.changeset/config.json"
    printf -- '---\n"@acme/core": patch\n---\n\nOlder fix.\n' > "$T/real-cs/.changeset/old.md"
    printf 'node_modules\n' > "$T/real-cs/.gitignore"
    if (cd "$T/real-cs" && timeout 120 npm install --no-audit --no-fund --silent @changesets/cli@2 >/dev/null 2>&1 && [ -x node_modules/.bin/changeset ]); then
        git -C "$T/real-cs" init -q -b main && git -C "$T/real-cs" add -A . && git -C "$T/real-cs" -c user.name=c -c user.email=c@x commit -q -m base && FW_REAL_CS="$T/real-cs"
    fi
fi
if command -v python3 >/dev/null 2>&1 && timeout 60 python3 -I -m venv "$T/tc-venv" >/dev/null 2>&1 && timeout 120 "$T/tc-venv/bin/pip" install -q towncrier >/dev/null 2>&1 && [ -x "$T/tc-venv/bin/towncrier" ]; then
    mkdir -p "$T/real-tc/changes" "$T/real-tc/.venv/bin" "$T/real-tc/pkg"
    ln -s "$T/tc-venv/bin/towncrier" "$T/real-tc/.venv/bin/towncrier"
    printf '[tool.towncrier]\nname = "demo"\ndirectory = "changes"\n' > "$T/real-tc/pyproject.toml"
    printf 'Added a thing.\n' > "$T/real-tc/changes/7.feature.rst"; printf 'x = 1\n' > "$T/real-tc/pkg/mod.py"
    FW_REAL_TC="$T/real-tc"
fi

probe="$(bun "$T/probe.ts" "$SRC" "$T" "$CTX" 2>"$T/probe.err")"
[ -n "$probe" ] || { bad "probe produced no output: $(tail -5 "$T/probe.err")"; finish; exit $?; }
get() { python3 -I -c 'import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print(v)' "$probe" "$1"; }
eqv() { local v; v="$(get "$1")"; [ "$v" = "$2" ] && ok "$3 ($1=$v)" || bad "$3 ($1: got '$v', want '$2')"; }

for s in maven gradle dotnet go rust; do eqv "rank_$s" first "L020 $s: the Calc source ranks first for a task naming it"; done
for s in maven gradle dotnet go rust; do eqv "unnamed_$s" top2 "L020 $s: repo map symbols (Calc.add, Calculator.Add on dotnet) put the Calc source in the top two when the task names no file (a same-score test file can tie)"; done
eqv no_rank_block omitted "L020 nothing ranks: no Relevant files block (no ls-files head)"

cov_o="$(get cov_opus)"; cov_h="$(get cov_haiku)"
echo "    coverage of the ts-invoice solution (files, function bodies): opus brief $cov_o, haiku brief $cov_h"
eqv cov_opus "2/3 0/3" "L021 baseline: the Opus brief names 2 of 3 solution files and carries no solution function body"
eqv cov_haiku "3/3 3/3" "L021 haiku brief: all 3 solution files named and all 3 solution function bodies inline"
python3 -I -c 'import sys; o=sys.argv[1].split(); h=sys.argv[2].split(); f=lambda s:int(s.split("/")[0]); sys.exit(0 if f(h[0])>f(o[0]) and f(h[1])>f(o[1]) else 1)' "$cov_o" "$cov_h" \
    && ok "L021 coverage of solution files and functions rises" || bad "L021 coverage did not rise ($cov_o -> $cov_h)"
eqv opus_golden identical "L021 Opus brief is byte-identical to the pre-L021 golden"
eqv pack_present yes "L021 haiku brief carries the context pack"
eqv pack_anchor yes "L021 pack bodies carry file:line anchors (src/money.ts reached through the callee hop)"
eqv pack_tokens_exact ok "L021 pack tokens recorded and within the 6000 budget"
echo "    pack spans: $(get pack_spans)"
eqv big_6000 within "L021 budget holds on large files (6000)"
eqv big_800 within "L021 budget holds on large files (800)"
eqv diet_default_on yes "E6 the pack diet is on by default and LOKI_E10_PACK_DIET=0 opts out"
eqv diet_no_fill yes "E6 diet: a task naming nothing keeps its single best definition, not the fill of matching ones (under half the tokens)"
eqv diet_named_only yes "E6 diet: a task naming one definition keeps that span only"
eqv diet_keeps_solution yes "E6 diet: ts-invoice keeps invoiceTotal and roundCents (callee) but drops RATES, a second-hop constant: the known cost, 3/3 files 2/3 bodies, fewer tokens"
eqv diet_no_tests yes "E6 diet: no test file spans in the pack"
eqv tiny_null yes "L021 a budget too small for any body sends no pack (not an empty header)"
eqv cov_record "0.667 0.5 3 3" "L022 contextCoverage: recall 2/3, precision 2/4, reads 3 (test and added files excluded, a deleted file counted)"
eqv stream_reads 3 "L022 stream parser: 3 reads before the first edit (a repeated snapshot counts once, a later read not at all)"
eqv median "0.5 3 4" "L022 median context recall over sealed runs (an unmeasured run counted as considered only)"

rn() { local v; v="$(get "$1")"; case "$v" in *"$2"*) ok "$3";; *) bad "$3 ($1: got '$v', want it to contain '$2')";; esac; }
rn rn_changeset '"@acme/core": patch' "L3 changeset: names the package of the relevant file, not the root"
rn rn_changeset 'newest example: .changeset/new-fix.md' "L3 changeset: newest example by mtime, README excluded"
rn rn_changeset_root '"rootpkg": patch' "L3 changeset: no relevant file falls back to the root package name"
rn rn_towncrier 'towncrier, docs/news/' "L3 towncrier: directory key read from [tool.towncrier]"
rn rn_towncrier 'docs/news/12.bugfix.md' "L3 towncrier: example fragment named"
rn rn_changelogd 'changelog.d/20240101_fix.md' "L3 changelog.d detected"
rn rn_newsfrag 'newsfragments/7.feature.rst' "L3 newsfragments detected"
rn rn_changie '.changes/unreleased/Fixed-1.yaml' "L3 changie .changes/unreleased detected"
eqv rn_none empty "L3 a repo with only CHANGELOG.md gets no fragment line"
eqv prefix_stable yes "L3/L5 the rule prefix is byte-identical across two runs; the convention line sits after it, never inside it"
eqv rules yyyyy "L5 FIXED_RULES carries the read-whole-function, preferred-fix, targeted-tests and release-note rules"
eqv fw_path ".changeset/fix-wrong-total-when-the-invoice.md" "FW changeset: a fragment is written next to the repo's own, named from the title"
eqv fw_front ok "FW changeset: front matter names the workspace package of the changed file (not the private root), double quotes as in the newest example"
eqv fw_body ok "FW changeset: body is the title plus one maintainer-style sentence from the implement summary"
eqv fw_quote ok "FW changeset: a single-quoted example gives a single-quoted fragment"
eqv fw_validated unavailable "FW changeset: no repo tool present reports validated=unavailable and still writes"
eqv fw_minor ok "FW changeset: a feature title bumps minor"
eqv fw_out_towncrier skipped "FW containment: a towncrier directory key of ../x writes nothing outside the repo"
eqv fw_out_symlink skipped "FW containment: a .changeset symlink to an outside directory is never written through"
eqv fw_ignore_glob skipped "FW: a glob entry in the changeset ignore list vetoes the package"
eqv fw_internal "skipped,skipped,skipped,skipped,skipped,skipped,skipped,skipped,skipped,skipped" "FW: internal-change titles (chore, refactor, docs, ci, test, build, bump, dependency update, merge, revert) write nothing"
eqv fw_internal_ok "www" "FW: fix, feat and perf titles still write"
eqv fw_strip ok "FW: a conventional prefix is dropped from the body and still decides the bump (feat -> minor)"
eqv fw_keep_prefix ok "FW: a conventional prefix is kept when the repo's own newest fragment carries one"
eqv fw_no_task skipped "FW veto: the task says no changelog, nothing is written"
eqv fw_has_frag skipped "FW: the diff already carries a fragment, nothing is written"
eqv fw_no_conv skipped "FW: a repo with only CHANGELOG.md has no convention, nothing is written"
eqv fw_tests_only skipped "FW: a test-only change writes nothing"
eqv fw_gen_untracked skipped "FW: untracked generated files (.gen.ts, @generated header, .min.js) never trigger a fragment"
eqv fw_gen_tracked_edit wrote "FW: an edit to a tracked file still writes a fragment"
eqv fw_gen_new_real wrote "FW: a new real source file writes a fragment even beside generated output"
eqv fw_gen_tracked_generated wrote "FW: a tracked change counts even when the file is generated"
eqv fw_docs_only skipped "FW: a docs-only change writes nothing"
eqv fw_private skipped "FW: a private package is never named"
eqv fw_ignored skipped "FW: a package in the changeset config ignore list is never named"
eqv fw_not_workspace skipped "FW: a named package outside the workspace globs is never named"
eqv fw_deleted skipped "FW: a path that no longer exists counts as no change"
eqv fw_no_title skipped "FW: no usable title and no usable summary writes nothing"
eqv fw_other_kind skipped "FW: a convention it cannot follow exactly (changelog.d) writes nothing"
eqv fw_rejected removed "FW tool: changeset status rejecting the fragment removes it"
eqv fw_env_error kept "FW tool: an environmental changeset error (no main branch) neither removes nor blocks the write"
eqv fw_tool_ok ok "FW tool: changeset status exit 0 marks the fragment validated"
eqv tc_path "changes/42.bugfix.rst" "FW towncrier: <issue>.<type><ext> taken from the task number and the example's extension"
eqv tc_text "Fix crash when the cache is empty." "FW towncrier: one-line body"
eqv tc_no_issue skipped "FW towncrier: no issue number and no orphan convention writes nothing"
eqv tc_unclear skipped "FW towncrier: an unclear change type writes nothing"
eqv tc_dup skipped "FW towncrier: a fragment for the same issue and type already exists"
eqv tc_no_example skipped "FW towncrier: no example fragment to take the naming from writes nothing"
eqv tc_orphan ok "FW towncrier: an orphan-style example gives a +slug fragment without an issue"
eqv sn_pick "The loader now skips unreadable files instead of aborting the whole scan" "FW summary: the maintainer-style sentence is picked over narration and markers"
eqv sn_chatter empty "FW summary: test-status and sign-off chatter yields nothing"
eqv sn_restate empty "FW summary: a sentence that restates the title yields nothing"
eqv sn_table empty "FW summary: tables and code fences yield nothing"
eqv veto "true,true,true,false,false" "FW veto: no/skip/do-not phrasings forbid, a task about changelogs or release notes does not"
eqv pr_line "true,false" "FW notice: the PR body carries the added-fragment line only when the writer wrote one"
eqv knob "true,true,false" "FW knob: the writer is on by default and LOKI_E10_SCAFFOLD=0 opts out"
case "$(get fw_real_cs)" in offline) ok "FW real changeset: skipped (registry unreachable)";; ok) ok "FW real changeset: the repo's own changeset status accepts the written fragment";; *) bad "FW real changeset: $(get fw_real_cs)";; esac
case "$(get fw_real_tc)" in offline) ok "FW real towncrier: skipped (registry unreachable)";; ok) ok "FW real towncrier: towncrier build --draft renders the written fragment";; *) bad "FW real towncrier: $(get fw_real_tc)";; esac

# ---- end to end on the stub provider ----
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 300)
TASK="$(cat "$CTX/ts-invoice/task.txt")"
run_e2e() { # run_e2e <name> [env...] -> REPO RUNDIR OUT
    local name="$1"; shift
    REPO="$T/e2e-$name"
    mkdir -p "$REPO"
    cp -R "$CTX/ts-invoice/repo"/. "$REPO"
    printf '// LOKI_STUB_INSERT\n' >> "$REPO/src/invoice.ts"
    [ -n "${E2E_PREP:-}" ] && "$E2E_PREP" "$REPO"
    git -C "$REPO" init -q -b main && git -C "$REPO" config user.name e2e && git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add -A . && git -C "$REPO" commit -q -m base
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SESSION_MODEL \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET=src/invoice.ts E2E_STUB_SNIPPET='export const GST_RATE = 0.05;' \
        E2E_STUB_LOG="$T/$name.stub.log" E2E_STUB_PROMPT_LOG="$T/$name.prompt" LOKI_RECEIPT_SIGNING_KEY_FILE="$T/$name.pem" \
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr 2>&1)"
    RUNDIR="$(dirname "$(ls "$REPO"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")"
}
ev() { # ev <stage> <python expr over d (the stage.completed data)>
    python3 -I -c 'import json,sys
d=None
for l in open(sys.argv[1]):
    try: e=json.loads(l)
    except Exception: continue
    if e.get("type")=="stage.completed" and e.get("stage")==sys.argv[2]: d=e.get("data") or {}
print(eval(sys.argv[3]) if d is not None else "no-event")' "$RUNDIR/events.jsonl" "$1" "$2" 2>&1
}

run_e2e haiku LOKI_SESSION_MODEL=haiku
if [ -f "$RUNDIR/events.jsonl" ]; then
    has "e2e haiku: the implement prompt carries the context pack" "$(cat "$T/haiku.prompt.implement0" 2>/dev/null)" "Code that matters"
    has "e2e haiku: the pack anchors src/money.ts" "$(cat "$T/haiku.prompt.implement0" 2>/dev/null)" "--- src/money.ts:"
    v="$(ev implement '"src/invoice.ts" in d.get("brief_files", []) and "src/money.ts" in d.get("brief_files", [])')"; [ "$v" = True ] && ok "e2e haiku: implement stage.completed carries brief_files" || bad "e2e haiku: brief_files missing ($v)"
    v="$(ev implement 'all(k in s for s in d["context_pack"]["spans"] for k in ("path","start","end")) and d["context_pack"]["tokens"] <= 6000')"; [ "$v" = True ] && ok "e2e haiku: implement stage.completed records the pack's paths and line ranges" || bad "e2e haiku: context_pack record missing ($v)"
    v="$(ev seal 'd.get("context", {}).get("context_recall")')"; [ "$v" = 1 ] && ok "e2e haiku: seal event carries context_recall 1" || bad "e2e haiku: seal context_recall was $v"
    v="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("context",{}).get("context_recall"))' "$RUNDIR/receipt.json" 2>&1)"; [ "$v" = 1 ] && ok "e2e haiku: receipt records context_recall 1" || bad "e2e haiku: receipt context_recall was $v"
else
    bad "e2e haiku: no run events"; printf '%s\n' "$OUT" | tail -30 | sed 's/^/    | /'
fi

run_e2e default
if [ -f "$RUNDIR/events.jsonl" ]; then
    case "$(cat "$T/default.prompt.implement0" 2>/dev/null)" in *"Code that matters"*) bad "e2e default model: the prompt carries a pack" ;; "") bad "e2e default model: no implement prompt captured" ;; *) ok "e2e default model: no pack in the implement prompt" ;; esac
    v="$(ev implement '"src/invoice.ts" in d.get("brief_files", []) and "context_pack" not in d')"; [ "$v" = True ] && ok "e2e default model: brief_files recorded, no context_pack" || bad "e2e default model: record wrong ($v)"
    v="$(ev seal 'd.get("context", {}).get("context_recall")')"; [ "$v" = 1 ] && ok "e2e default model: seal event carries context_recall 1" || bad "e2e default model: seal context_recall was $v"
    st="$(cd "$REPO" && bash "$ROOT/bin/loki" stats --outcomes --json 2>/dev/null)"
    v="$(python3 -I -c 'import json,sys; c=json.loads(sys.argv[1])["context_recall"]; print(c["median"], c["n"])' "$st" 2>&1)"; [ "$v" = "1 1" ] && ok "loki stats --outcomes --json reports median context recall ($v)" || bad "loki stats --outcomes --json context_recall: $v"
else
    bad "e2e default model: no run events"; printf '%s\n' "$OUT" | tail -30 | sed 's/^/    | /'
fi

prep_changeset() { # a public package that keeps changesets (the fixture's own manifest is private)
    mkdir -p "$1/.changeset"
    printf '{ "name": "billing", "type": "module" }\n' > "$1/package.json"
    printf '{"ignore":[]}\n' > "$1/.changeset/config.json"
    printf -- '---\n"billing": patch\n---\n\nOlder fix.\n' > "$1/.changeset/old.md"
}
frag_in_history() { git -C "$REPO" log --all --name-only --format= 2>/dev/null | grep -c '^\.changeset/.*\.md$'; }
scaffold_events() { grep -c '"type":"scaffold.applied"' "$RUNDIR/events.jsonl" 2>/dev/null; }
E2E_PREP=prep_changeset run_e2e fragon
if [ -f "$RUNDIR/events.jsonl" ]; then
    v="$(scaffold_events)"; [ "$v" = 1 ] && ok "e2e fragment writer on: one scaffold.applied event" || bad "e2e fragment writer on: scaffold.applied events=$v"
    v="$(python3 -I -c 'import json,sys
for l in open(sys.argv[1]):
    e=json.loads(l)
    if e.get("type")=="scaffold.applied": d=e["data"]; print(d["path"].startswith(".changeset/") and d["kind"]=="changeset" and e["stage"]=="implement")' "$RUNDIR/events.jsonl" 2>&1)"; [ "$v" = True ] && ok "e2e fragment writer on: the event names the written changeset" || bad "e2e fragment writer on: scaffold.applied record ($v)"
    v="$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(any(n.startswith("Loki added .changeset/") and n.endswith("delete it if this change needs no release note (LOKI_E10_SCAFFOLD=0 turns this off).") for n in r.get("not_proven",[])))' "$RUNDIR/receipt.json" 2>&1)"; [ "$v" = True ] && ok "e2e fragment writer on: the receipt carries the added-fragment line" || bad "e2e fragment writer on: receipt lacks the added-fragment line ($v)"
    [ "$(frag_in_history)" -ge 2 ] && ok "e2e fragment writer on: the fragment is part of the run's commit" || bad "e2e fragment writer on: no new .changeset fragment in the run's commits"
else
    bad "e2e fragment writer on: no run events"; printf '%s\n' "$OUT" | tail -30 | sed 's/^/    | /'
fi
E2E_PREP=prep_changeset run_e2e fragoff LOKI_E10_SCAFFOLD=0
if [ -f "$RUNDIR/events.jsonl" ]; then
    [ "$(scaffold_events)" = 0 ] && ok "e2e fragment writer =0: no scaffold event" || bad "e2e fragment writer off: a scaffold event was written"
    [ "$(frag_in_history)" = 1 ] && ok "e2e fragment writer =0: no fragment added" || bad "e2e fragment writer off: a fragment was added"
else
    bad "e2e fragment writer off: no run events"
fi

finish
