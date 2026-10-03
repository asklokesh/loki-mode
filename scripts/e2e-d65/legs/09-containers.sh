# shellcheck shell=bash
# Leg 9, containers: deploy files exist; with a live docker daemon build Dockerfile.control-plane and probe /ready
# on a random host port. Never PASS without a real /ready probe; SKIP(docker unavailable) otherwise.
leg_09_containers() {
    local f img="loki-e2e-d65-cp:$$" cid="" port body code="" ok=0 n
    for f in Dockerfile.control-plane deploy/helm/control-plane deploy/ecs/control-plane-task.json deploy/docker-compose/docker-compose.yml; do
        [ -e "$REPO_ROOT/$f" ] || fail "deploy file missing: $f"
    done
    [ "$LEG_STATUS" = FAIL ] && return
    note "deploy files present"
    if ! command -v docker > /dev/null 2>&1; then skip "docker unavailable"; return; fi
    if ! timeout -k 2 10 docker info > /dev/null 2>&1; then skip "docker unavailable"; return; fi
    if ! ( cd "$REPO_ROOT" && timeout -k 10 420 docker build --progress=plain -f Dockerfile.control-plane -t "$img" . ) > "$T/logs/leg9-build.log" 2>&1; then
        fail "docker build of Dockerfile.control-plane failed: $(grep -m2 "error: Could not resolve\|ERROR" "$T/logs/leg9-build.log" | tr "\n" " ")"; return
    fi
    cid="$(timeout -k 2 30 docker run -d -p 127.0.0.1::47821 -e LOKI_CONTROL_TOKEN=e2e-fake-token "$img" 2> "$T/logs/leg9-run.log")"
    if [ -z "$cid" ]; then fail "docker run failed: $(head -c 200 "$T/logs/leg9-run.log")"; docker rmi -f "$img" > /dev/null 2>&1; return; fi
    port="$(docker port "$cid" 47821/tcp 2> /dev/null | head -1 | sed 's/.*://')"
    n=0
    while [ "$n" -lt 40 ] && [ -n "$port" ]; do
        body="$(curl -s --noproxy '*' -m 3 -w '\n%{http_code}' "http://127.0.0.1:$port/ready" 2> /dev/null)"
        code="$(printf '%s' "$body" | tail -1)"
        if [ "$code" = 200 ]; then ok=1; break; fi
        sleep 0.5; n=$((n + 1))
    done
    docker rm -f "$cid" > /dev/null 2>&1
    docker rmi -f "$img" > /dev/null 2>&1
    if [ "$ok" = 1 ]; then pass "image built, /ready 200 on host port $port"
    else fail "/ready never returned 200 (port=${port:-none} last code=${code:-none})"; fi
}
