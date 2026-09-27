#!/bin/bash
# Stub "provider" that finishes quickly and prints a marker on stdout, for
# the SessionMarkers parsing and heartbeat-fired paths.
set -u
sleep 0.2
echo "LOKI_ALREADY_DONE: fixture evidence"
exit 0
