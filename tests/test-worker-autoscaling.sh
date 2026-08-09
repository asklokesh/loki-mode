#!/usr/bin/env bash
# Workers autoscale on QUEUE DEPTH, and the HPA does not fight the Deployment.
#
# THE SCALING SIGNAL IS THE WHOLE POINT. A worker spends nearly all of a build
# waiting on a model API, so it is idle by CPU measure for most of its working
# life. A CPU-targeted HPA therefore reads a SATURATED cluster as an underused
# one and scales it DOWN exactly when the backlog is growing. Test 3 pins the
# metric so nobody "fixes" this by reaching for the familiar CPU target.
#
# TEST 2 IS THE OTHER LOAD-BEARING ONE. If the Deployment keeps a templated
# `replicas` while an HPA owns the same field, every `helm upgrade` resets the
# count the HPA just chose and the two fight on every sync. That presents as
# mysterious scaling thrash, not as a chart bug, so it is asserted directly.
#
# VACUITY GUARD: PyYAML is NOT stdlib. A previous helm test in this repo let
# every parse raise, swallowed the traceback, compared empty strings and
# accused a correct chart. Here the parser is checked FIRST and the suite skips
# with a named reason rather than passing on nothing.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/helm/loki-mode"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: worker autoscaling scales on queue depth, not CPU"

command -v helm >/dev/null 2>&1 || {
  echo "  SKIP: helm not installed -- chart not rendered, nothing measured"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }
python3 -c "import yaml" 2>/dev/null || {
  echo "  SKIP: PyYAML not installed -- cannot parse rendered manifests"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }
[ -d "$CHART" ] || { echo "  FAIL: chart missing at $CHART"; exit 1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-hpa.XXXXXX")"
trap 'rm -rf "$W" 2>/dev/null || true' EXIT INT TERM

helm template t "$CHART" > "$W/off.yaml" 2>"$W/off.err" || {
  echo "  FAIL: chart does not render with defaults"; sed -n 1,3p "$W/off.err"; exit 1; }
helm template t "$CHART" --set worker.autoscaling.enabled=true > "$W/on.yaml" 2>"$W/on.err" || {
  echo "  FAIL: chart does not render with autoscaling on"; sed -n 1,3p "$W/on.err"; exit 1; }

# Non-empty renders, or every assertion below would be vacuous.
if [ -s "$W/off.yaml" ] && [ -s "$W/on.yaml" ]; then
  ok "both configurations render non-empty manifests"
else
  bad "a render was empty -- assertions would be vacuous"
  echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
fi

_probe() {
python3 - "$1" "$2" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
want = sys.argv[2]
hpa = [d for d in docs if d.get("kind") == "HorizontalPodAutoscaler"]
wdep = [d for d in docs if d.get("kind") == "Deployment"
        and "worker" in (d.get("metadata", {}).get("name") or "")]
if want == "hpa_count":
    print(len(hpa))
elif want == "worker_has_replicas":
    print("yes" if (wdep and "replicas" in (wdep[0].get("spec") or {})) else "no")
elif want == "metric_name":
    if not hpa: print(""); raise SystemExit
    m = (hpa[0]["spec"]["metrics"] or [{}])[0]
    print(m.get("external", {}).get("metric", {}).get("name", ""))
elif want == "metric_type":
    if not hpa: print(""); raise SystemExit
    print((hpa[0]["spec"]["metrics"] or [{}])[0].get("type", ""))
elif want == "scaledown_window":
    if not hpa: print(""); raise SystemExit
    print(hpa[0]["spec"].get("behavior", {}).get("scaleDown", {})
          .get("stabilizationWindowSeconds", ""))
elif want == "scaleup_window":
    if not hpa: print(""); raise SystemExit
    print(hpa[0]["spec"].get("behavior", {}).get("scaleUp", {})
          .get("stabilizationWindowSeconds", ""))
elif want == "target_ref":
    if not hpa: print(""); raise SystemExit
    print(hpa[0]["spec"]["scaleTargetRef"]["name"])
elif want == "worker_dep_name":
    print(wdep[0]["metadata"]["name"] if wdep else "")
PY
}

# --- 1. Off by default (the metrics adapter is a real prerequisite) ---------
# An HPA shipped on by default would silently never scale without an adapter --
# worse than none, because it LOOKS like capacity management.
if [ "$(_probe "$W/off.yaml" hpa_count)" = "0" ]; then
  ok "no HPA by default (the External metric needs an adapter first)"
else
  bad "an HPA renders by default -- it would never scale without an adapter"
fi
if [ "$(_probe "$W/off.yaml" worker_has_replicas)" = "yes" ]; then
  ok "the default path still sets an explicit replica count"
else
  bad "no replicas and no HPA -- the worker count would be unmanaged"
fi

# --- 2. THE CONFLICT: replicas must be OMITTED when the HPA owns them -------
if [ "$(_probe "$W/on.yaml" hpa_count)" = "1" ]; then
  ok "enabling autoscaling renders exactly one HPA"
else
  bad "autoscaling enabled did not render exactly one HPA"
fi
if [ "$(_probe "$W/on.yaml" worker_has_replicas)" = "no" ]; then
  ok "the Deployment omits replicas when the HPA owns them (no sync thrash)"
else
  bad "replicas and an HPA both set -- every helm upgrade would fight the HPA"
fi

# --- 3. THE SIGNAL: queue depth, never CPU ---------------------------------
_mt="$(_probe "$W/on.yaml" metric_type)"
_mn="$(_probe "$W/on.yaml" metric_name)"
if [ "$_mt" = "External" ] && printf '%s' "$_mn" | grep -q "queue"; then
  ok "scales on an External queue metric ($_mn)"
else
  bad "metric is type=$_mt name=$_mn -- expected an External queue metric"
fi
if printf '%s' "$_mn" | grep -qi "cpu" || grep -qi "name: cpu" "$W/on.yaml"; then
  bad "a CPU target is present -- it would scale a saturated cluster DOWN"
else
  ok "no CPU target (a model-blocked worker is idle by CPU measure)"
fi

# --- 4. Scale-down is slower than scale-up ---------------------------------
# Killing a worker mid-build destroys that build, and a brief lull is not
# evidence the backlog is gone. Asserted as a RELATION, so retuning either
# number keeps the guarantee.
_up="$(_probe "$W/on.yaml" scaleup_window)"
_down="$(_probe "$W/on.yaml" scaledown_window)"
if [ -n "$_up" ] && [ -n "$_down" ] && [ "$_down" -gt "$_up" ]; then
  ok "scale-down (${_down}s) is slower than scale-up (${_up}s)"
else
  bad "scale-down ${_down}s is not slower than scale-up ${_up}s -- builds would be killed on a lull"
fi

# --- 5. The HPA targets the worker Deployment that actually exists ----------
# A typo'd scaleTargetRef renders fine and silently scales nothing.
_ref="$(_probe "$W/on.yaml" target_ref)"
_dep="$(_probe "$W/on.yaml" worker_dep_name)"
if [ -n "$_ref" ] && [ "$_ref" = "$_dep" ]; then
  ok "the HPA targets the rendered worker Deployment ($_ref)"
else
  bad "HPA targets '$_ref' but the worker Deployment is '$_dep' -- it would scale nothing"
fi

# --- 6. The receiver actually SERVES the metric the HPA asks for -----------
# Without this the chart is internally consistent and still useless: the
# adapter would have nothing to read.
if grep -q "queue_saturation" "$REPO_ROOT/autonomy/trigger-server.py"; then
  ok "the receiver exposes queue_saturation for the adapter to scrape"
else
  bad "nothing serves queue_saturation -- the HPA metric would never resolve"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
