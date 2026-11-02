#!/usr/bin/env bash
# L002 outcome metrics, hermetic: 20 fixture engine10 runs (two repos) are written as signed
# .loki/runs/<id>/events.jsonl files, then read three ways and checked against numbers worked
# out by hand from the fixture table below:
#   projection: every run's fix_rounds, escalations, sessions, input/cache-read/cache-creation tokens
#               (from GET /v1/runs after POST /v1/ingest, and from `loki stats --outcomes --json`)
#               equals a jq count or sum over that run's events.jsonl, and input_tokens excludes cache tokens.
#   outcomes:   GET /v1/stats/outcomes and `loki stats --outcomes --json` (the real bin/loki, committed
#               bundle) both report the hand-computed cost per VERIFIED run, sessions p50/p90, fix rounds,
#               escalations, cache-read share, first-pass rate and wall_s p50/p95 by size, each with its n,
#               for the whole set and per repo; ?repo= and an empty window read "not measured" with n = 0.
#   cost/repos: GET /v1/cost/repos usd_per_verified uses the same definition (ALREADY_SATISFIED excluded),
#               and grep finds one implementation of the per-verified division.
#
# Fixture table (usd and tokens are per session; every finished run is sealed and signed with the
# test HOME's key, except r09 which is signed with a key no one configured):
#   id  repo  verdict            sess  usd   fix  esc  size    wall  tokens in/cr/cc
#   r01 api   VERIFIED           2     0.10  0    0    small   60    100/300/100
#   r02 api   VERIFIED           3     0.10  1    1r   normal  120   100/300/100
#   r03 api   VERIFIED           4     0.20  2    0    normal  240   100/300/100
#   r04 api   FAILED             5     0.10  2    1+1r normal  300   100/300/100
#   r05 api   PARTIAL            3     0.10  1    0    small   90    100/300/100
#   r06 api   ALREADY_SATISFIED  1     0.05  0    0    small   30    100/300/100
#   r07 api   VERIFIED           2     none  0    0    small   45    none
#   r08 api   SPEC_CONFLICT      1     0.05  0    1    large   20    100/300/100
#   r09 api   VERIFIED unchecked 2     0.10  0    0    normal  100   100/300/100
#   r10 api   (running)          1     0.10  0    0    small   -     100/300/100
#   r11 api   FAILED, tampered   2     0.10  1    0    normal  150   100/300/100
#   r12 api   VERIFIED           1     0.30  0    0    (none)  80    200/0/0
#   r13 web   VERIFIED           2     0.25  0    0    small   50    50/150/50
#   r14 web   VERIFIED           3     0.25  1    1r   normal  200   50/150/50
#   r15 web   FAILED             4     0.25  2    1    normal  400   50/150/50
#   r16 web   PARTIAL            2     none  1    0    small   70    50/150/50
#   r17 web   ALREADY_SATISFIED  1     0.10  0    0    small   25    50/150/50
#   r18 web   VERIFIED           2     0.25  0    0    large   500   50/150/50
#   r19 web   FAILED             3     0.25  2    2r   large   600   50/150/50
#   r20 web   VERIFIED           1     0.25  0    0    small   40    50/150/50
#   (esc: a number of `escalated` events, "r" a `route.escalated` event)
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. packages/control-plane/src/server/runs.ts projectRun: inputTokens adds the cache tokens back in.
#   2. packages/control-plane/src/server/routes/stats.ts costPerVerified: count ALREADY_SATISFIED as verified.
#   3. packages/control-plane/src/server/routes/stats.ts pct: Math.ceil the rank instead of round half to even.
#   4. packages/control-plane/src/server/routes/stats.ts computeOutcomes: first pass ignores fix rounds.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need jq
need python3
cd "$ROOT" || exit 2
[ -d "$ROOT/packages/control-plane/node_modules" ] || { echo "outcome-metrics: run 'bun install --cwd loki-ts --frozen-lockfile' first (it installs packages/control-plane)" >&2; exit 2; }
unset LOKI_DIR LOKI_RECEIPT_SIGNING_KEY LOKI_RECEIPT_SIGNING_KEY_FILE LOKI_CP_RECEIPT_PUBKEYS LOKI_RECEIPT_RETIRED_PUBKEYS

echo "TEST: outcome metrics over 20 fixture runs"

REPO="$T/repo"
mkdir -p "$REPO/.loki/runs" "$HOME/.loki/keys"

cat > "$T/gen.ts" <<'TS'
// Writes the fixture runs. Envelopes are serialised in the engine's key order and sealed the way
// the supervisor seals them (receipt.sealed, run.completed, log.sealed over the bytes before it).
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [runsDir, keyFile] = process.argv.slice(2) as [string, string];
const mine = generateKeyPairSync("ed25519"), stranger = generateKeyPairSync("ed25519");
writeFileSync(keyFile, mine.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const kidOf = (pub: import("node:crypto").KeyObject) => createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${pub.export({ format: "jwk" }).x}"}`).digest("base64url");
type F = [id: string, repo: string, verdict: string | null, sess: number, usd: number | null, fix: number, esc: number, resc: number, size: string | null, wall: number | null, tok: [number, number, number] | null, flags?: string];
const A = "acme/api", B = "acme/web", TA: [number, number, number] = [100, 300, 100], TB: [number, number, number] = [50, 150, 50];
const fixtures: F[] = [
  ["r01", A, "VERIFIED", 2, 0.10, 0, 0, 0, "small", 60, TA],
  ["r02", A, "VERIFIED", 3, 0.10, 1, 0, 1, "normal", 120, TA],
  ["r03", A, "VERIFIED", 4, 0.20, 2, 0, 0, "normal", 240, TA],
  ["r04", A, "FAILED", 5, 0.10, 2, 1, 1, "normal", 300, TA],
  ["r05", A, "PARTIAL", 3, 0.10, 1, 0, 0, "small", 90, TA],
  ["r06", A, "ALREADY_SATISFIED", 1, 0.05, 0, 0, 0, "small", 30, TA],
  ["r07", A, "VERIFIED", 2, null, 0, 0, 0, "small", 45, null],
  ["r08", A, "SPEC_CONFLICT", 1, 0.05, 0, 1, 0, "large", 20, TA],
  ["r09", A, "VERIFIED", 2, 0.10, 0, 0, 0, "normal", 100, TA, "stranger"],
  ["r10", A, null, 1, 0.10, 0, 0, 0, "small", null, TA],
  ["r11", A, "FAILED", 2, 0.10, 1, 0, 0, "normal", 150, TA, "tampered"],
  ["r12", A, "VERIFIED", 1, 0.30, 0, 0, 0, null, 80, [200, 0, 0]],
  ["r13", B, "VERIFIED", 2, 0.25, 0, 0, 0, "small", 50, TB],
  ["r14", B, "VERIFIED", 3, 0.25, 1, 0, 1, "normal", 200, TB],
  ["r15", B, "FAILED", 4, 0.25, 2, 1, 0, "normal", 400, TB],
  ["r16", B, "PARTIAL", 2, null, 1, 0, 0, "small", 70, TB],
  ["r17", B, "ALREADY_SATISFIED", 1, 0.10, 0, 0, 0, "small", 25, TB],
  ["r18", B, "VERIFIED", 2, 0.25, 0, 0, 0, "large", 500, TB],
  ["r19", B, "FAILED", 3, 0.25, 2, 0, 2, "large", 600, TB],
  ["r20", B, "VERIFIED", 1, 0.25, 0, 0, 0, "small", 40, TB],
];
fixtures.forEach(([id, repo, verdict, sess, usd, fix, esc, resc, size, wall, tok, flags], i) => {
  const run = `om-${id}`, day = String(i + 1).padStart(2, "0"), lines: string[] = [];
  const add = (type: string, stage: string | null, data: Record<string, unknown>) =>
    lines.push(JSON.stringify({ v: 1, seq: lines.length, ts: `2026-10-${day}T10:${String(Math.floor(lines.length / 60)).padStart(2, "0")}:${String(lines.length % 60).padStart(2, "0")}.000Z`, run, type, stage, data }));
  add("run.started", null, { origin_repo: repo, task_source: "text", provider: "claude", model: "sonnet" });
  if (size) add("variant", null, { size, reasons: ["fixture"] });
  for (let s = 0; s < sess; s++) {
    add("session.started", "implement", { session_id: `${run}-s${s}`, provider: "claude", model: "sonnet", pgid: null });
    add("cost", "implement", { session_id: `${run}-s${s}`, model: "sonnet", ...(usd === null ? {} : { usd }), ...(tok ? { input_tokens: tok[0], output_tokens: 10, cache_read_tokens: tok[1], cache_creation_tokens: tok[2] } : {}) });
  }
  for (let k = 1; k <= fix; k++) add("fix.round", "fix", { round: k });
  for (let k = 0; k < resc; k++) add("route.escalated", "fix", { from: "haiku", to: "sonnet" });
  for (let k = 0; k < esc; k++) add("escalated", null, { stop: "fixture stop" });
  if (flags === "tampered") add("tamper.detected", null, { reason: "fixture" });
  if (verdict !== null) {
    const key = flags === "stranger" ? stranger : mine, kid = kidOf(key.publicKey);
    add("receipt.sealed", "seal", { verdict, signed: true, kid, receipt_sha256: createHash("sha256").update(run).digest("hex"), path: `.loki/runs/${run}/receipt.json` });
    add("run.completed", null, { verdict, not_proven: [], cost_usd: usd === null ? null : Math.round(usd * sess * 1e6) / 1e6, wall_s: wall });
    const sha = createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
    add("log.sealed", null, { tampered: false, kid, events_sha256: sha, sig: sign(null, Buffer.from(`${sha}:false`), key.privateKey).toString("base64url") });
  }
  mkdirSync(join(runsDir, run), { recursive: true });
  writeFileSync(join(runsDir, run, "events.jsonl"), lines.join("\n") + "\n");
});
TS

cat > "$T/cp.ts" <<'TS'
// Ingests every fixture run into an in-memory control plane and prints what its routes return.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [root, runsDir] = process.argv.slice(2) as [string, string];
const { createApp } = await import(join(root, "packages/control-plane/src/server/app.ts"));
const { app } = createApp({ dbPath: ":memory:" });
for (const id of readdirSync(runsDir).sort()) {
  const evs = readFileSync(join(runsDir, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const r = await app.request("/v1/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "fixture-src", run_id: id, events: evs }) });
  if (r.status !== 200) { console.error(`ingest ${id}: ${r.status} ${await r.text()}`); process.exit(1); }
}
const get = async (p: string) => (await app.request(p)).json();
console.log(JSON.stringify({
  outcomes: await get("/v1/stats/outcomes"),
  repo_web: await get("/v1/stats/outcomes?repo=acme/web"),
  empty: await get("/v1/stats/outcomes?since=2030-01-01"),
  repos: await get("/v1/cost/repos"),
  runs: (await get("/v1/runs?limit=200")).runs,
}));
process.exit(0);
TS

bun "$T/gen.ts" "$REPO/.loki/runs" "$HOME/.loki/keys/receipt-ed25519.pem" >"$T/gen.out" 2>&1 \
    && ok "wrote $(ls "$REPO/.loki/runs" | wc -l | tr -d ' ') fixture runs" || { bad "fixture generator failed: $(tail -5 "$T/gen.out")"; finish; exit $?; }

# Ground truth per run: jq counts and sums over its events.jsonl.
for d in "$REPO"/.loki/runs/*/; do
    jq -s --arg id "$(basename "$d")" '{run_id: $id,
        fix_rounds: map(select(.type == "fix.round")) | length,
        escalations: map(select(.type == "escalated" or .type == "route.escalated")) | length,
        sessions: map(select(.type == "cost")) | length,
        input_tokens: (map(select(.type == "cost") | .data.input_tokens // 0) | add // 0),
        cache_read_tokens: (map(select(.type == "cost") | .data.cache_read_tokens // 0) | add // 0),
        cache_creation_tokens: (map(select(.type == "cost") | .data.cache_creation_tokens // 0) | add // 0),
        tampered: (map(select(.type == "tamper.detected")) | length > 0)}' "$d/events.jsonl"
done | jq -s . > "$T/jq.json" || bad "jq over events.jsonl failed"

(cd "$T" && bun "$T/cp.ts" "$ROOT" "$REPO/.loki/runs") >"$T/cp.json" 2>"$T/cp.err" \
    && ok "control plane ingested the fixture runs" || bad "control plane run failed: $(tail -5 "$T/cp.err")"

(cd "$REPO" && LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js" bash "$ROOT/bin/loki" stats --outcomes --json) >"$T/cli.json" 2>"$T/cli.err" \
    && ok "loki stats --outcomes --json exits 0" || bad "loki stats --outcomes --json failed: $(tail -5 "$T/cli.err")"
(cd "$REPO" && LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js" bash "$ROOT/bin/loki" stats --outcomes) >"$T/cli.txt" 2>&1
sed 's/^/    | /' "$T/cli.txt"
has "text output names the cost per VERIFIED run" "$(cat "$T/cli.txt")" 'Cost per VERIFIED run   $0.81875 '
(cd "$REPO" && LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js" bash "$ROOT/bin/loki" stats --outcomes --since 2030-01-01) >"$T/cli-empty.txt" 2>&1
has "an empty window reads not measured" "$(cat "$T/cli-empty.txt")" 'First-pass rate         not measured'

python3 -I - "$T/jq.json" "$T/cp.json" "$T/cli.json" <<'PY' > "$T/py.out" 2>&1
import json, sys
jqr = {r["run_id"]: r for r in json.load(open(sys.argv[1]))}
cp = json.load(open(sys.argv[2]))
cli = json.load(open(sys.argv[3]))
fails = []
def eq(what, got, want):
    ok = (abs(got - want) < 1e-9) if isinstance(want, float) and isinstance(got, (int, float)) else got == want
    print(("PASS " if ok else "FAIL ") + f"{what}: got {got!r}, want {want!r}")
    if not ok: fails.append(what)

# 1. Projection columns equal jq over events.jsonl (CP /v1/runs and the CLI's runs[]).
cpr = {r["run_id"]: r for r in cp["runs"]}
clr = {r["run_id"]: r for r in cli["runs"]}
eq("CP holds every fixture run", sorted(cpr), sorted(jqr))
eq("CLI reads every fixture run", sorted(clr), sorted(jqr))
for rid, j in sorted(jqr.items()):
    for src, rows, sk in (("cp", cpr, "total_sessions"), ("cli", clr, "sessions")):
        r = rows.get(rid, {})
        for k in ("fix_rounds", "escalations", "input_tokens", "cache_read_tokens", "cache_creation_tokens"):
            eq(f"{src} {rid} {k} == jq", r.get(k), j[k])
        # A tampered log reports no trusted session or cost figure (engine10 partialCost), so it is 0 by design.
        eq(f"{src} {rid} sessions == jq", r.get(sk), 0 if j["tampered"] else j["sessions"])
eq("cp r12 input_tokens excludes cache tokens", cpr["om-r12"]["input_tokens"], 200)
eq("cp r01 input_tokens excludes cache tokens", cpr["om-r01"]["input_tokens"], 200)
eq("cp r01 cache_read_share", cpr["om-r01"]["cache_read_share"], 0.6)

# 2. Outcomes, hand-computed from the fixture table (see the header).
ALL = {
    "runs_finished": 19, "runs_tampered": 1,
    "sessions": {"p50": 2, "p90": 4, "n": 18, "label": "measured"},
    "fix_rounds": {"total": 12, "mean": 0.666667, "n": 18, "label": "measured"},
    "escalations": {"total": 8, "mean": 0.444444, "n": 18, "label": "measured"},
    "cache_read_share": {"value": 0.592105, "n": 17, "label": "measured", "cache_read_tokens": 9000, "input_tokens_total": 15200},
    "cost_per_verified_usd": {"value": 0.81875, "n": 8, "label": "measured", "spend_usd": 6.55, "priced_runs": 16, "unpriced_runs": 2, "verified_runs": 9},
    "first_pass_rate": {"value": 0.375, "n": 16, "label": "measured", "first_pass_runs": 6},
    "wall_s": {"all": {"p50": 85, "p95": 500, "n": 18, "label": "measured"}, "by_size": {
        "large": {"p50": 500, "p95": 600, "n": 3, "label": "measured"},
        "normal": {"p50": 220, "p95": 400, "n": 6, "label": "measured"},
        "small": {"p50": 47.5, "p95": 90, "n": 8, "label": "measured"},
        "unknown": {"p50": 80, "p95": 80, "n": 1, "label": "measured"}}},
}
WEB = {
    "runs_finished": 8, "runs_tampered": 0,
    "sessions": {"p50": 2, "p90": 3, "n": 8, "label": "measured"},
    "fix_rounds": {"total": 6, "mean": 0.75, "n": 8, "label": "measured"},
    "escalations": {"total": 4, "mean": 0.5, "n": 8, "label": "measured"},
    "cache_read_share": {"value": 0.6, "n": 8, "label": "measured", "cache_read_tokens": 2700, "input_tokens_total": 4500},
    "cost_per_verified_usd": {"value": 0.9625, "n": 4, "label": "measured", "spend_usd": 3.85, "priced_runs": 7, "unpriced_runs": 1, "verified_runs": 4},
    "first_pass_rate": {"value": 0.428571, "n": 7, "label": "measured", "first_pass_runs": 3},
    "wall_s": {"all": {"p50": 135, "p95": 600, "n": 8, "label": "measured"}, "by_size": {
        "large": {"p50": 550, "p95": 600, "n": 2, "label": "measured"},
        "normal": {"p50": 300, "p95": 400, "n": 2, "label": "measured"},
        "small": {"p50": 45, "p95": 70, "n": 4, "label": "measured"}}},
}
API_PART = {"cost_per_verified_usd": {"value": 0.675, "n": 4, "label": "measured", "spend_usd": 2.7, "priced_runs": 9, "unpriced_runs": 1, "verified_runs": 5},
            "first_pass_rate": {"value": 0.333333, "n": 9, "label": "measured", "first_pass_runs": 3}}
def walk(prefix, got, want):
    if isinstance(want, dict):
        if not isinstance(got, dict): return eq(prefix, got, want)
        eq(f"{prefix} keys", sorted(got), sorted(want)) if prefix.endswith("by_size") else None
        for k, v in want.items(): walk(f"{prefix}.{k}", got.get(k), v)
    else:
        eq(prefix, got, float(want) if isinstance(want, float) else want)
for src, doc in (("cp", cp["outcomes"]), ("cli", cli)):
    walk(f"{src} all", doc, ALL)
    walk(f"{src} by_repo[acme/web]", doc["by_repo"].get("acme/web"), WEB)
    walk(f"{src} by_repo[acme/api]", doc["by_repo"].get("acme/api"), API_PART)
walk("cp ?repo=acme/web", cp["repo_web"], {k: v for k, v in WEB.items()})
e = cp["empty"]
for k in ("sessions", "fix_rounds", "cache_read_share", "cost_per_verified_usd", "first_pass_rate"):
    eq(f"empty window {k} n", e[k]["n"], 0); eq(f"empty window {k} label", e[k]["label"], "not measured")
eq("empty window wall_s label", e["wall_s"]["all"]["label"], "not measured")
eq("empty window cost value is null", e["cost_per_verified_usd"]["value"], None)

# 3. /v1/cost/repos uses the same per-verified definition.
rows = {r["repo"]: r for r in cp["repos"]["rows"]}
eq("cost/repos acme/web usd_per_verified", rows["acme/web"]["usd_per_verified"], 0.9625)
eq("cost/repos acme/web verified_runs (ALREADY_SATISFIED excluded)", rows["acme/web"]["verified_runs"], 4)
eq("cost/repos acme/api usd_per_verified", rows["acme/api"]["usd_per_verified"], 0.675)
eq("cost/repos acme/api usd_per_verified_n", rows["acme/api"]["usd_per_verified_n"], 4)
print(f"py: {len(fails)} failed")
sys.exit(1 if fails else 0)
PY
py_rc=$?
n_checks="$(grep -c '^PASS ' "$T/py.out")"
if [ "$py_rc" -eq 0 ]; then ok "all $n_checks value checks match jq and the hand-computed numbers"; else bad "value checks failed: $(grep '^FAIL ' "$T/py.out" | head -12 | tr '\n' ';')"; fi

# One implementation of the per-verified division: costPerVerified in routes/stats.ts; cost.ts reads it.
defs="$(grep -rn 'function costPerVerified' packages/control-plane/src loki-ts/src | wc -l | tr -d ' ')"
DIV='[A-Za-z0-9_)] */ *(a\.)?(verified|pricedVerified)\b' # an expression divided by a verified count (the old cost.ts read a.usd / a.verified)
divs="$(grep -rnE "$DIV" packages/control-plane/src loki-ts/src | wc -l | tr -d ' ')"
[ "$defs" = "1" ] && ok "one costPerVerified definition" || bad "costPerVerified is defined $defs times"
[ "$divs" = "1" ] && ok "one place divides spend by verified runs" || bad "found $divs per-verified divisions: $(grep -rnE "$DIV" packages/control-plane/src loki-ts/src | head -3)"
grep -q 'costPerVerified(rs)' packages/control-plane/src/server/routes/cost.ts && ok "/v1/cost/repos reads costPerVerified" || bad "/v1/cost/repos does not read costPerVerified"

# Prices: loki-ts/data/model-pricing.json is the one table the engine reads, imported so the bundle carries it (a
# runtime read from dist/loki.js looked in a directory that does not exist). Every engine price equals its JSON row,
# the estimate table for codex/cline/aider prices a current id from it and leaves an older id unpriced (null dollars,
# so a cap warns) instead of charging the current family rate, and no TS file reads the JSON at run time.
# Planted defects: spread FROM_PRICING_JSON instead of VERSIONED_IDS in price_table.ts (claude-3-5-haiku is then priced
# at $0.10/$0.50) and the "older id unpriced" case fails; put back a readFileSync of model-pricing.json in
# model_routes.ts and the one-reader check fails.
pr="$(cd "$ROOT/loki-ts" && bun -e '
const j = (await import("./data/model-pricing.json", { with: { type: "json" } })).default;
const { PRICING, loadDefaultMaxCostUsd } = await import("./src/runner/budget.ts");
const { priceFor } = await import("./src/providers/price_table.ts");
const { buildProviderCost } = await import("./src/providers/provider_cost.ts");
const { inferenceGeoMultiplier } = await import("./src/providers/model_routes.ts");
const rows = Object.entries(j.pricing);
const same = rows.every(([k, v]) => PRICING[k] && PRICING[k].input === v.input && PRICING[k].output === v.output && PRICING[k].cache_read === v.cache_read) && Object.keys(PRICING).length === rows.length;
const cur = ["claude-haiku-5-5", "claude-opus-5-5", "gpt-5.6-luna"].every((m) => { const p = priceFor(m); const r = j.pricing[m] ?? j.pricing[m.split("-")[1]]; return p.matched && p.price.input === r.input && p.price.output === r.output; });
const old = ["claude-3-5-haiku-20241022", "claude-3-opus-20240229", "claude-3-5-sonnet-20241022"].every((m) => buildProviderCost("codex", m, "x".repeat(400), "y".repeat(400))?.total_cost_usd === null);
console.log([same, cur, old, loadDefaultMaxCostUsd() === j.default_max_cost_usd, inferenceGeoMultiplier({ LOKI_INFERENCE_GEO: "us" }) === j.inference_geo_multipliers.us].join(" "));' 2>&1)"
[ "$pr" = "true true true true true" ] && ok "prices: engine table equals the JSON; current ids priced from it; older ids unpriced; cap and geo multiplier from it" || bad "prices (engine=json current older cap geo): $pr"
readers="$(grep -rln 'model-pricing' loki-ts/src | xargs grep -l 'readFileSync' | xargs grep -n 'model-pricing.json"' | grep -v '^[^:]*:[0-9]*:import ' || true)"
[ -z "$readers" ] && ok "no loki-ts/src file reads model-pricing.json at run time" || bad "runtime readers of model-pricing.json: $readers"

finish
