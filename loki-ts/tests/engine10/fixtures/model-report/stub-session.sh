#!/usr/bin/env bash
# E-50 fixture: stands in for the SDK-loop child (session.ts sessionChildMain).
# Replays a recorded result-cost file (captured from a real SDK session) into
# the exact path session.ts's recordCost() reads: <cwd>/.loki/metrics/result-cost-<LOKI_ITERATION>.json.
# MODEL_REPORT_FIXTURE names the recorded file to replay; the caller sets it.
set -eu
dest_dir=".loki/metrics"
mkdir -p "$dest_dir"
cp "$MODEL_REPORT_FIXTURE" "$dest_dir/result-cost-${LOKI_ITERATION}.json"
exit 0
