#!/usr/bin/env bash
# OTEL-2b: the documented OpenTelemetry Collector config and its fixture.
#
# Offline only (a YAML parse, shape checks and a node run of the pure mapper;
# no network; a collector binary is optional, see step 4). Asserts:
#   1. config/otel-collector/loki-collector.yaml parses and has the receiver,
#      processor, exporters and traces pipeline the doc promises;
#   2. every credential-bearing field is an ${env:NAME} placeholder, never a
#      literal, and no key-looking literal appears anywhere in the file;
#   2b. with a single vendor listed and the other vendors' variables unset,
#      every required field still resolves to a non-empty, non-key-shaped default;
#   3. the deterministic fixture (fixed ids and timestamps) maps to the golden
#      span descriptors byte for byte.
# Fail-closed: no python3/PyYAML or no node is an unmeasured config.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="${OTEL_COLLECTOR_CONFIG:-$REPO_ROOT/config/otel-collector/loki-collector.yaml}"
FIX="$REPO_ROOT/tests/fixtures/otel"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
die() { bad "$1"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }

echo "TEST: OTel collector config and deterministic fixture"

command -v python3 >/dev/null 2>&1 || die "python3 unavailable"
command -v node >/dev/null 2>&1 || die "node unavailable"
python3 -I -c 'import yaml' 2>/dev/null || die "PyYAML unavailable -- config unmeasurable; fails closed"
[ -f "$CFG" ] || die "collector config missing: $CFG"

CHECK_OUT="$(python3 -I - "$CFG" <<'PY' 2>&1
import re, sys, yaml
path = sys.argv[1]
raw = open(path).read()
errs = []
try:
    cfg = yaml.safe_load(raw)
except Exception as e:
    print("PARSE: " + str(e)); sys.exit(0)
if not isinstance(cfg, dict):
    print("SHAPE: top level is not a mapping"); sys.exit(0)

recv = (cfg.get("receivers") or {}).get("otlp") or {}
if "http" not in (recv.get("protocols") or {}):
    errs.append("SHAPE: receivers.otlp.protocols.http missing")
if "batch" not in (cfg.get("processors") or {}):
    errs.append("SHAPE: processors.batch missing")
exps = cfg.get("exporters") or {}
for need in ("otlphttp/grafana", "otlphttp/honeycomb", "datadog"):
    if need not in exps:
        errs.append("SHAPE: exporters." + need + " missing")
tr = ((cfg.get("service") or {}).get("pipelines") or {}).get("traces") or {}
if tr.get("receivers") != ["otlp"]:
    errs.append("SHAPE: traces pipeline receivers != [otlp]")
if "batch" not in (tr.get("processors") or []):
    errs.append("SHAPE: traces pipeline lacks batch")
for e in tr.get("exporters") or []:
    if e not in exps:
        errs.append("SHAPE: pipeline exporter not defined: " + e)

PLACEHOLDER = re.compile(r"^\$\{env:([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}$")
def cred(path, v):
    m = PLACEHOLDER.match(str(v))
    if not m:
        errs.append("SECRET: " + path + " is not an ${env:NAME} placeholder")
        return
    dflt = m.group(2)
    if dflt is not None and (re.search(r"[A-Za-z0-9+/=_-]{16,}", dflt) or len(dflt) > 40):
        errs.append("SECRET: " + path + " default is key-shaped: " + dflt)
g = (exps.get("otlphttp/grafana") or {})
cred("grafana.headers.Authorization", (g.get("headers") or {}).get("Authorization"))
h = (exps.get("otlphttp/honeycomb") or {})
cred("honeycomb.headers.x-honeycomb-team", (h.get("headers") or {}).get("x-honeycomb-team"))
d = (exps.get("datadog") or {}).get("api") or {}
cred("datadog.api.key", d.get("key"))

# Subset case: with only one vendor listed and every other vendor's variables
# unset, the collector still validates every defined exporter, so each required
# field must resolve to a non-empty inert default. Only the listed vendor's
# own variables are ever set.
def resolve(v):
    m = PLACEHOLDER.match(str(v))
    return (m.group(2) or "") if m else str(v)
req = {
    "otlphttp/grafana": [("endpoint", (exps.get("otlphttp/grafana") or {}).get("endpoint"))],
    "otlphttp/honeycomb": [("endpoint", (exps.get("otlphttp/honeycomb") or {}).get("endpoint"))],
    "datadog": [("api.key", d.get("key")), ("api.site", d.get("site"))],
}
for vendor, fields in req.items():
    for name, v in fields:
        if v is None or resolve(v) == "":
            errs.append("SUBSET: " + vendor + " " + name + " is empty when its variables are unset")

# Belt and braces over the raw text: no long opaque token anywhere.
for n, line in enumerate(raw.splitlines(), 1):
    code = line.split("#", 1)[0]
    if re.search(r"[A-Za-z0-9+/=_-]{32,}", code):
        errs.append("SECRET: line %d holds a long opaque literal" % n)
print("\n".join(errs) if errs else "CLEAN")
PY
)"
if [ "$CHECK_OUT" = "CLEAN" ]; then
    ok "config parses; receiver, batch, three exporters and traces pipeline present"
    ok "every credential field is an env placeholder; no opaque literal"
else
    while IFS= read -r l; do bad "$l"; done <<< "$CHECK_OUT"
fi

# Deterministic fixture -> golden span descriptors (pure mapper, no clock).
GOT="$(node -e '
const fs=require("fs");
const {mapRunEvents}=require(process.argv[1]+"/src/observability/genai-spans");
const ev=fs.readFileSync(process.argv[1]+"/tests/fixtures/otel/run-events.jsonl","utf8").trim().split("\n").map(JSON.parse);
console.log(JSON.stringify(mapRunEvents(ev).map(s=>({...s,startNs:String(s.startNs),endNs:String(s.endNs)})),null,2));
' "$REPO_ROOT" 2>&1)"
if [ "$GOT" = "$(cat "$FIX/expected-spans.json")" ]; then
    ok "fixture maps to the golden span descriptors byte for byte"
else
    bad "fixture output differs from tests/fixtures/otel/expected-spans.json"
fi
GOT2="$(node -e '
const fs=require("fs");
const {mapRunEvents}=require(process.argv[1]+"/src/observability/genai-spans");
const ev=fs.readFileSync(process.argv[1]+"/tests/fixtures/otel/run-events.jsonl","utf8").trim().split("\n").map(JSON.parse);
console.log(JSON.stringify(mapRunEvents(ev).map(s=>({...s,startNs:String(s.startNs),endNs:String(s.endNs)})),null,2));
' "$REPO_ROOT" 2>&1)"
if [ "$GOT" = "$GOT2" ]; then
    ok "second mapper run is identical (deterministic)"
else
    bad "mapper output differs between two runs"
fi

# Optional: a real collector validates the file with only one vendor's variable
# set. SKIPPED (not passed) when the binary is absent.
if command -v otelcol-contrib >/dev/null 2>&1; then
    if env -i PATH="$PATH" HONEYCOMB_API_KEY=dummy otelcol-contrib validate --config "$CFG" >/dev/null 2>&1; then
        ok "otelcol-contrib validate passes with only HONEYCOMB_API_KEY set"
    else
        bad "otelcol-contrib validate fails with only HONEYCOMB_API_KEY set"
    fi
else
    echo "SKIP: otelcol-contrib not on PATH; collector validate not run"
fi

echo "  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
