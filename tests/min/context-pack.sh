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
#                   run on the provider default model (LOKI_AUTO_ROUTE=0) sends no pack but still records brief_files and the coverage.
#   loki stats --outcomes --json reports the median context recall of those runs.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/context_pack.ts: drop the callee hop (the `for (let hop` loop); the haiku brief loses
#      src/money.ts and roundCents, so the coverage assertions fail.
#   2. loki-ts/src/util/context_pack.ts: `if (used + c > budgetBytes) return false;` deleted; the budget legs fail.
#   3. loki-ts/src/engine10/stages/implement.ts: drop `brief_files: bc.files` from the stage data (rebuild dist);
#      the end-to-end brief_files and context_recall assertions fail.
#   4. loki-ts/src/engine10/repomap.ts: SOURCE_EXT back to ts|tsx|js|jsx|mjs|cjs|py; the L020 ranking legs fail.

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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const opus = briefRecord(ictx, deps, "claude-opus-4-6"), haiku = briefRecord(ictx, deps, "haiku");
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
console.log(JSON.stringify(out));
TS

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
eqv tiny_null yes "L021 a budget too small for any body sends no pack (not an empty header)"
eqv cov_record "0.667 0.5 3 3" "L022 contextCoverage: recall 2/3, precision 2/4, reads 3 (test and added files excluded, a deleted file counted)"
eqv stream_reads 3 "L022 stream parser: 3 reads before the first edit (a repeated snapshot counts once, a later read not at all)"
eqv median "0.5 3 4" "L022 median context recall over sealed runs (an unmeasured run counted as considered only)"

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

run_e2e default LOKI_AUTO_ROUTE=0 # the provider default model; with no pin auto routing runs Haiku, which gets the pack like the haiku leg
if [ -f "$RUNDIR/events.jsonl" ]; then
    case "$(cat "$T/default.prompt.implement0" 2>/dev/null)" in *"Code that matters"*) bad "e2e default model: the prompt carries a pack" ;; "") bad "e2e default model: no implement prompt captured" ;; *) ok "e2e default model: no pack in the implement prompt" ;; esac
    v="$(ev implement '"src/invoice.ts" in d.get("brief_files", []) and "context_pack" not in d')"; [ "$v" = True ] && ok "e2e default model: brief_files recorded, no context_pack" || bad "e2e default model: record wrong ($v)"
    v="$(ev seal 'd.get("context", {}).get("context_recall")')"; [ "$v" = 1 ] && ok "e2e default model: seal event carries context_recall 1" || bad "e2e default model: seal context_recall was $v"
    st="$(cd "$REPO" && bash "$ROOT/bin/loki" stats --outcomes --json 2>/dev/null)"
    v="$(python3 -I -c 'import json,sys; c=json.loads(sys.argv[1])["context_recall"]; print(c["median"], c["n"])' "$st" 2>&1)"; [ "$v" = "1 1" ] && ok "loki stats --outcomes --json reports median context recall ($v)" || bad "loki stats --outcomes --json context_recall: $v"
else
    bad "e2e default model: no run events"; printf '%s\n' "$OUT" | tail -30 | sed 's/^/    | /'
fi

finish
