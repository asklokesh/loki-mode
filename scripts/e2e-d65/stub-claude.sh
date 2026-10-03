#!/usr/bin/env bash
# Stub `claude` for scripts/e2e-d65.sh. Writes to the repo ONLY on a real `-p` implement-stage call,
# so version/help/auth probes never touch a fixture. No network, no credentials.
#   E2E_STUB_BLOCK=1  implement stage reports LOKI_SPEC_CONFLICT (BLOCKED run)
#   E2E_STUB_PAGE=1   implement stage also appends a line to public/index.html (a changed page file)
case " $* " in
    *" --help "* | *" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions -p --print"; exit 0 ;;
esac
prompt=""
while [ $# -gt 0 ]; do
    if [ "$1" = "-p" ]; then prompt="${2:-}"; shift; fi
    shift
done
[ -n "$prompt" ] || exit 0
case "$prompt" in
    *"Loki 10 implement stage"*) ;;
    *) echo "stub claude: non-implement stage, no edits"; exit 0 ;;
esac
if [ "${E2E_STUB_BLOCK:-}" = 1 ]; then
    echo "LOKI_SPEC_CONFLICT: the task contradicts sum.js: sum must stay pure but the task asks for a global counter"
    exit 0
fi
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
if [ "${E2E_STUB_PAGE:-}" = 1 ] && [ -f public/index.html ]; then echo "<!-- touched -->" >> public/index.html; fi
echo "stub claude done"
