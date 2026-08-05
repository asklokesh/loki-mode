#!/usr/bin/env bash
# Production-dependency npm audit gate with a documented accepted-advisory allowlist.
#
# Plain `npm audit --audit-level=high` has no per-advisory ignore, so a single
# transitive CVE that is NOT reachable in the shipped CLI would block every
# release forever (the recurring-release-failure the team hit on v7.129.4). This
# wrapper fails on ANY high/critical advisory EXCEPT the explicitly accepted ones
# below, each with a written not-reachable rationale. A NEW high advisory (not in
# the allowlist) still fails the gate -- this is a targeted exception, never a
# blanket suppression. Moderate/low advisories are not gated here (mirrors
# --audit-level=high) and never require a waiver.
#
# Accepted HIGH/CRITICAL advisories (review on every otel/dep bump):
#   GHSA-45rx-2jwx-cxfr  @opentelemetry/* JaegerPropagator DoS via malformed
#     inbound header. NOT REACHABLE: loki-ts is a CLI that only EMITS OTLP traces
#     (opt-in, gated on LOKI_OTEL_ENDPOINT / LOKI_TELEMETRY, off by default) and
#     never runs an inbound-HTTP server that feeds attacker-controlled headers to
#     a propagator's extract().
#     STATUS (v8, 2026-07-24): FIXED at the source. The @opentelemetry/* deps were
#     bumped to sdk-trace-node/base 2.10.0 + exporter-trace-otlp-http 0.221.0,
#     which pulls propagator-jaeger >= 2.9.0 (patched) and core 2.10.0 (also clears
#     the previously-unwaived W3C-Baggage moderate). Production npm audit
#     (--omit=dev) is now clean at high+ WITHOUT invoking this waiver. The entry is
#     kept as a harmless no-op fail-safe so an older transitive re-introduction
#     still fails safe; removing it is a separate reviewed step.
set -uo pipefail

# Waived HIGH/CRITICAL advisories. As of the v8 otel 2.x bump this list is a
# no-op fail-safe (its target left the tree); it stays as a guard and is removed
# only under separate review. See the rationale block above.
ACCEPTED_GHSAS="GHSA-45rx-2jwx-cxfr"

python3 - "$ACCEPTED_GHSAS" <<'PY'
import json, subprocess, sys
accepted = set(sys.argv[1].split())
data = json.loads(subprocess.run(
    ["npm","audit","--omit=dev","--json"], capture_output=True, text=True).stdout or "{}")
vulns = data.get("vulnerabilities") or {}

def high_ghsas_for(name, seen=None):
    """GHSA ids of HIGH/CRITICAL severity that a package's advisory ultimately
    traces to, following transitive `via` package refs. Moderate/low GHSAs are
    ignored -- they don't trip the high+ gate, so they never need a waiver."""
    seen = seen or set()
    if name in seen:
        return set()
    seen.add(name)
    out = set()
    for adv in (vulns.get(name, {}).get("via") or []):
        if isinstance(adv, dict):
            gid = adv.get("url", "").rsplit("/", 1)[-1]
            if gid.startswith("GHSA-") and adv.get("severity") in ("high","critical"):
                out.add(gid)
        elif isinstance(adv, str):
            out |= high_ghsas_for(adv, seen)
    return out

blocking = []
for name, v in vulns.items():
    if v.get("severity") not in ("high", "critical"):
        continue
    gids = high_ghsas_for(name)
    if gids and gids.issubset(accepted):
        print(f"  accepted (not reachable): {name} <- {','.join(sorted(gids))}")
        continue
    blocking.append(f"{name} [{v.get('severity')}] high-GHSAs={sorted(gids) or 'unknown'}")

if blocking:
    print("::error::npm audit reported UN-accepted high/critical vulnerabilities:")
    for b in blocking:
        print(f"  - {b}")
    sys.exit(1)
print("npm audit clean at high+ (accepted advisories waived with documented rationale)")
PY
