# shellcheck shell=bash
# Leg 3, Control Plane: serve --port 0; a run ships via instance.json; GET /v1/runs has a row; POST answer on a BLOCKED run is 200.
leg_03_control() {
    local log="$T/logs/leg3-serve.log" url spid cpid inst repo="$T/work/leg3" out run src n body code rc
    local -a ship_env=()
    mk_repo "$repo"
    cenv LOKI_CONTROL=1 "$LOKI" control serve --port 0 --db "$T/work/control.db" > "$log" 2>&1 &
    spid=$!; record_pid "$spid"
    url="$(wait_for_line "$log" 'listening on http' 30 "$spid" | sed -n 's/.*listening on \(http[^ ]*\).*/\1/p')"
    url="${url%/}"
    if [ -z "$url" ]; then fail "serve printed no 'listening on' URL in 30s: $(head -c 600 "$log" | tr '\n' ' ')"; return; fi
    cpid="$(curl -s --noproxy '*' -m 5 "$url/health" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
    [ -n "$cpid" ] && record_pid "$cpid"
    note "serve url=$url cli_pid=$spid server_pid=${cpid:-unknown}"
    inst="$T/home/.loki/control/instance.json"
    n=0; while [ ! -f "$inst" ] && [ "$n" -lt 20 ]; do sleep 0.1; n=$((n + 1)); done
    if [ -f "$inst" ]; then
        note "instance.json present: $(head -c 200 "$inst" | tr '\n' ' ')"
    else
        fail "serve wrote no \$HOME/.loki/control/instance.json, so a run cannot discover the server (C2 CP-DEFAULT)"
        ship_env=("LOKI_CONTROL_URL=$url")   # fall back so the remaining assertions still run
    fi
    # A BLOCKED run, shipped live by the engine hook.
    ( cd "$repo" && cenv LOKI_CONTROL=1 LOKI_CONTROL_ALLOW_TMP=1 E2E_STUB_BLOCK=1 ${ship_env[@]+"${ship_env[@]}"} timeout -k 5 240 "$LOKI" quick "make sum use a global counter" ) < /dev/null > "$T/logs/leg3-run.log" 2>&1
    rc=$?
    note "blocked run rc=$rc run=$(newest_run "$repo")"
    n=0; out=""
    while [ "$n" -lt 30 ]; do
        out="$(curl -s --noproxy '*' -m 5 "$url/v1/runs")"
        case "$out" in *'"run_id"'*) break ;; esac
        sleep 0.5; n=$((n + 1))
    done
    case "$out" in
        *'"run_id"'*) note "GET /v1/runs has a row" ;;
        *) fail "GET /v1/runs has no rows after the run (shipped via ${ship_env[0]:-instance.json}); body: ${out:0:160}"; return ;;
    esac
    run="$(printf '%s' "$out" | sed -n 's/.*"run_id":"\([^"]*\)".*/\1/p')"
    src="$(printf '%s' "$out" | sed -n 's/.*"source_id":"\([^"]*\)".*/\1/p')"
    [ -n "$src" ] || src="$(printf '%s' "$out" | sed -n 's/.*"source":"\([^"]*\)".*/\1/p')"
    if [ -z "$run" ] || [ -z "$src" ]; then fail "could not read source/run from /v1/runs: ${out:0:200}"; return; fi
    body="$(http POST "$url/v1/runs/$src/$run/answer" '{"answer":"keep sum pure"}')"
    code="$(printf '%s' "$body" | tail -1)"
    note "POST answer $src/$run -> $code: $(printf '%s' "$body" | head -1 | head -c 120)"
    [ "$code" = 200 ] || { fail "POST answer on the BLOCKED run returned $code, expected 200"; return; }
    pass "served, run listed, answer 200"
}
