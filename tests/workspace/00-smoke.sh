# shellcheck shell=bash
# D51 Phase B workspace harness smoke test (B01)
# One trivial assertion to verify the runner works.
#
# Sourced by tests/test-workspace.sh, which provides ok() and bad()

# Simple check: a trivial assertion to verify the test harness is working
if true; then
    ok "workspace harness smoke test"
else
    bad "workspace harness smoke test"
fi
