#!/usr/bin/env bash
# Q1 SCRATCH-OWNED, non-hermetic (not in scripts/local-ci.sh): the harness's ownership cleanup (runner/worker_proc.ts cleanupSessionScratch) against real
# services a session starts the way FireLater sessions did: pg_ctl with its data directory in $TMPDIR; redis-server --daemonize no --dir <scratch> &;
# redis-server --daemonize yes with --dir in scratch; npm exec tsx (a launcher and its node children). A redis started --daemonize yes with nothing in scratch
# and listed in pids is the accepted failure: left running and reported, never stopped. Skips by name when a binary is missing.
# Run: bash tests/min/scratch-real-services.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need python3
cd "$ROOT" || exit 2
echo "TEST: scratch cleanup against real pg_ctl, redis-server and npm exec tsx"
PGBIN=""; for d in /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin /usr/lib/postgresql/*/bin; do [ -x "$d/pg_ctl" ] && [ -x "$d/initdb" ] && PGBIN="$d"; done
REDIS="$(command -v redis-server 2>/dev/null || true)"; TSXDIR="$ROOT/packages/control-plane"
[ -n "$PGBIN" ] || { echo "  SKIP: postgres (no pg_ctl and initdb on this machine)"; }
[ -n "$REDIS" ] || { echo "  SKIP: redis (no redis-server on this machine)"; }
[ -x "$TSXDIR/node_modules/.bin/tsx" ] || { echo "  SKIP: npm exec tsx (packages/control-plane has no tsx: run bun install there)"; TSXDIR=""; }
OUTJ="$(ROOT="$ROOT" PGBIN="$PGBIN" REDIS="$REDIS" TSXDIR="$TSXDIR" OUTSIDE="$T" bun --no-env-file --config=/dev/null -e '
const w = await import(process.env.ROOT + "/loki-ts/src/runner/worker_proc.ts"), fs = await import("node:fs");
const s = w.createSessionScratch(), env = { ...process.env, ...w.scratchSessionEnv(s) }, port = () => 41000 + Math.floor(Math.random() * 8000);
const { PGBIN, REDIS, TSXDIR, OUTSIDE } = process.env, pids = {}, out = {};
const sh = (cmd) => Bun.spawnSync(["bash", "-c", cmd], { env, cwd: s.dir, stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 60000 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let bare = 0;
try {
  if (PGBIN) { sh(`mkdir -p "$TMPDIR/pgdata" && ${PGBIN}/initdb -D "$TMPDIR/pgdata" -A trust -U t >/dev/null 2>&1 && ${PGBIN}/pg_ctl -D "$TMPDIR/pgdata" -l "$TMPDIR/pg.log" -o "-p ${port()} -k $TMPDIR -c listen_addresses=127.0.0.1" -w start`); try { pids.postmaster = Number(fs.readFileSync(s.dir + "/pgdata/postmaster.pid", "utf8").split("\n")[0]); } catch {} }
  if (REDIS) {
    sh(`mkdir -p "$TMPDIR/r1" && ${REDIS} --port ${port()} --bind 127.0.0.1 --daemonize no --dir "$TMPDIR/r1" > "$TMPDIR/r1.log" 2>&1 < /dev/null & echo $! > "$TMPDIR/r1.pid"; sleep 1`);
    try { pids.redis_fg = Number(fs.readFileSync(s.dir + "/r1.pid", "utf8")); } catch {}
    sh(`mkdir -p "$TMPDIR/r2" && ${REDIS} --port ${port()} --bind 127.0.0.1 --daemonize yes --dir "$TMPDIR/r2" --pidfile "$TMPDIR/r2/redis.pid"; sleep 1`); try { pids.redis_daemon_in_scratch = Number(fs.readFileSync(s.dir + "/r2/redis.pid", "utf8")); } catch {}
    const bp = OUTSIDE + "/bare-redis.pid"; sh(`${REDIS} --port ${port()} --bind 127.0.0.1 --daemonize yes --dir "${OUTSIDE}" --pidfile "${bp}"; sleep 1`); try { bare = Number(fs.readFileSync(bp, "utf8")); fs.writeFileSync(s.dir + "/pids", bare + "\n"); } catch {}
  }
  if (TSXDIR) { Bun.spawn(["bash", "-c", `cd "${TSXDIR}" && exec npm exec --no -- tsx -e "setInterval(() => {}, 1000)" > /dev/null 2>&1`], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" }); await Bun.sleep(4000); }
  const r = w.cleanupSessionScratch(s, { termWaitMs: 5000 });
  for (const [k, pid] of Object.entries(pids)) out[k] = pid ? { stopped: r.stopped.some((x) => x.pid === pid), why: r.stopped.find((x) => x.pid === pid)?.why ?? null, alive: alive(pid) } : "not started";
  out.tsx_family = TSXDIR ? r.stopped.filter((x) => /node|tsx|npm|esbuild/.test(x.command)).map((x) => x.why) : "not started";
  out.bare_redis = bare ? { left_reported: r.left.some((x) => x.pid === bare), alive: alive(bare) } : "not started";
  out.removed = r.removed; out.kept = r.kept ?? null;
} finally { if (bare) { try { process.kill(bare, "SIGTERM"); } catch {} } }
console.log(JSON.stringify(out));' 2>&1)"
echo "    $OUTJ"
chk() { python3 -I -c 'import json, sys
o = json.loads(sys.argv[1]); v = o.get(sys.argv[2])
sys.exit(2 if v == "not started" else 0 if eval(sys.argv[3], {"v": v}) else 1)' "$OUTJ" "$1" "$2"; }
for k in postmaster redis_fg redis_daemon_in_scratch; do
    chk "$k" 'v["stopped"] and not v["alive"]'; rc=$?
    case $rc in 0) ok "$k: proven the run's and stopped" ;; 2) echo "  SKIP: $k (not started here)" ;; *) bad "$k: not stopped" ;; esac
done
chk tsx_family 'len(v) >= 2'; rc=$?; case $rc in 0) ok "npm exec tsx: the launcher and its node children are stopped" ;; 2) echo "  SKIP: npm exec tsx (not started here)" ;; *) bad "npm exec tsx family not stopped" ;; esac
chk bare_redis 'v["left_reported"]'; rc=$?; case $rc in 0) ok "bare daemonized redis with nothing in scratch: left running and reported, never stopped (accepted failure)" ;; 2) echo "  SKIP: bare redis (not started here)" ;; *) bad "bare redis was stopped or not reported" ;; esac
chk removed 'v is True'; [ $? -eq 0 ] && ok "the scratch directory is removed once nothing owned is alive" || bad "scratch directory kept"

# ---- Bounded waits (#693): the proof helper's server wait, step clock and per-command limit, and the brief's line about them. ----
# Cells W1 to W3 poll a port or start and stop a process (run them with this file); W4 and W5 are pure bun cells.
echo "TEST: proof helper bounded waits (loki_wait_http, step log, LOKI_STEP_MAX_S)"
HP="$T/loki-check.sh"
ROOT="$ROOT" bun --no-env-file --config=/dev/null -e 'process.stdout.write((await import(process.env.ROOT + "/loki-ts/src/engine10/proof_rerun.ts")).PROOF_HELPER_SH)' > "$HP" 2>/dev/null
# the helper as it was on v11.182.0 (commit c6990c747), evaluated from the git blob with the same template rules; empty when the commit is not in this clone
BASE_HP="$T/loki-check-base.sh"
ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { execFileSync } = await import("node:child_process");
const src = execFileSync("git", ["show", "c6990c747:loki-ts/src/engine10/proof_rerun.ts"], { cwd: process.env.ROOT, encoding: "utf8" });
const head = "export const PROOF_HELPER_SH = `", a = src.indexOf(head) + head.length, b = src.indexOf("`;\n", a);
process.stdout.write(eval("`" + src.slice(a, b) + "`"));' > "$BASE_HP" 2>/dev/null
bash -n "$HP" && ok "W0 the helper text written from PROOF_HELPER_SH is valid bash" || bad "W0 helper text is not valid bash"

# W1: nothing listening -> returns 1 within 5 s, stderr names the wait, stdout has no LOKI-PROOF; a server-backed leg returns 0
FP="$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
{ for i in $(seq 1 25); do echo "wait-log-line-$i"; done; } > "$T/wait.log"
W1S=$SECONDS
( . "$HP"; LOKI_PROOF_TOKEN=tk LOKI_WAIT_LOG="$T/wait.log" loki_wait_http "http://127.0.0.1:$FP" 2 >"$T/w1.out" 2>"$T/w1.err"; echo $? > "$T/w1.rc" )
W1E=$((SECONDS - W1S))
[ "$(cat "$T/w1.rc" 2>/dev/null)" = 1 ] && [ "$W1E" -le 5 ] && ok "W1 loki_wait_http on a closed port returns 1 within 5 s (took $W1E s)" || bad "W1 closed port: rc $(cat "$T/w1.rc" 2>/dev/null), $W1E s"
has "W1 stderr says the wait gave up" "$(cat "$T/w1.err")" "LOKI-WAIT gave up after 2 s: http://127.0.0.1:$FP"
has "W1 stderr carries the last line of LOKI_WAIT_LOG" "$(cat "$T/w1.err")" "wait-log-line-25"
case "$(cat "$T/w1.err")" in *wait-log-line-5$'\n'*|*wait-log-line-5) bad "W1 stderr carries more than the last 20 log lines" ;; *) ok "W1 stderr stops at the last 20 log lines" ;; esac
case "$(cat "$T/w1.out")" in *LOKI-PROOF*) bad "W1 stdout has a LOKI-PROOF line" ;; *) ok "W1 stdout has no LOKI-PROOF line" ;; esac
SP="$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
mkdir -p "$T/www"; ( cd "$T/www" && exec python3 -I -m http.server "$SP" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SRV=$!
( . "$HP"; loki_wait_http "http://127.0.0.1:$SP" 15 >/dev/null 2>&1; echo $? > "$T/w1b.rc" )
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
[ "$(cat "$T/w1b.rc" 2>/dev/null)" = 0 ] && ok "W1 loki_wait_http returns 0 once a server answers" || bad "W1 server leg: rc $(cat "$T/w1b.rc" 2>/dev/null)"

# W2: loki_cmd with no limit prints what v11.182.0 printed, and the step log holds one start and one end line for the item
if [ -s "$BASE_HP" ]; then
  ( . "$BASE_HP"; LOKI_PROOF_TOKEN=tk loki_cmd 1 "x" true > "$T/c2.base" )
  ( . "$HP"; LOKI_PROOF_TOKEN=tk LOKI_STEP_LOG="$T/steps2.log" loki_cmd 1 "x" true > "$T/c2.out" )
  cmp -s "$T/c2.base" "$T/c2.out" && ok "W2 loki_cmd prints the same line as the v11.182.0 helper ($(cat "$T/c2.out"))" || bad "W2 loki_cmd line differs: base [$(cat "$T/c2.base")] new [$(cat "$T/c2.out")]"
else
  echo "  SKIP: W2 byte comparison (commit c6990c747 is not in this clone)"
fi
[ "$(grep -Ec '^start 1 [0-9]+ x$' "$T/steps2.log" 2>/dev/null)" = 1 ] && [ "$(grep -Ec '^end 1 0 [0-9]+$' "$T/steps2.log" 2>/dev/null)" = 1 ] && ok "W2 the step log holds one start and one end line for item 1" || bad "W2 step log: $(cat "$T/steps2.log" 2>/dev/null | tr '\n' '/')"

# W3: LOKI_STEP_MAX_S=1 stops a 5 s command: non-zero within 4 s, FAILED line says "no result after 1 s", the command's PID is gone
cat > "$T/slow.sh" <<'EOS'
echo $$ > "$1"; exec sleep 5
EOS
W3S=$(date +%s)
( . "$HP"; LOKI_PROOF_TOKEN=tk LOKI_STEP_LOG="$T/steps3.log" LOKI_STEP_MAX_S=1 loki_cmd 1 "slow" bash "$T/slow.sh" "$T/slow.pid" > "$T/c3.out" 2>/dev/null; echo $? > "$T/c3.rc" )
W3E=$(( $(date +%s) - W3S ))
[ "$(cat "$T/c3.rc" 2>/dev/null)" != 0 ] && [ "$W3E" -lt 4 ] && ok "W3 a 5 s command under LOKI_STEP_MAX_S=1 returns non-zero within 4 s (took $W3E s)" || bad "W3 rc $(cat "$T/c3.rc" 2>/dev/null), $W3E s"
has "W3 prints a FAILED line with no result after 1 s" "$(cat "$T/c3.out")" "FAILED 1 slow | no result after 1 s"
SLOWPID="$(cat "$T/slow.pid" 2>/dev/null)"
[ -n "$SLOWPID" ] && ! kill -0 "$SLOWPID" 2>/dev/null && ok "W3 the stopped command's PID is gone" || bad "W3 the command's PID $SLOWPID is still alive"
[ -n "$SLOWPID" ] && kill -0 "$SLOWPID" 2>/dev/null && kill -KILL "$SLOWPID" 2>/dev/null

# W4: pure. LOKI-WAIT lines (and the log tail after them) change neither the proved nor the failed count of the proof-line parser
W4="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/engine10/proof_rerun.ts");
const lines = ["LOKI-PROOF tk PROVED 1: first | status 200 | ok", "LOKI-PROOF tk FAILED 2: second | exit 1 | cmd: false | no", "LOKI-PROOF tk PROVED 2: third | exit 0 | cmd: true | "];
const plain = lines.join("\n") + "\n";
const waits = [lines[0], "LOKI-WAIT gave up after 2 s: http://127.0.0.1:1", "server log line", lines[1], "LOKI-WAIT gave up after 60 s: http://127.0.0.1:2", lines[2]].join("\n") + "\n";
const a = m.tallyProof(plain, "tk"), b = m.tallyProof(waits, "tk"), n = (o) => JSON.stringify(Object.entries(o).map(([k, v]) => [k, v.proved, v.failed]));
console.log(n(a) === n(b) && n(a) === JSON.stringify([["1", 1, 0], ["2", 1, 1]]) && m.proofChecks(plain, "tk").length === m.proofChecks(waits, "tk").length && m.proofChecks(waits, "tk").length === 3 ? "same" : "differ " + n(a) + " " + n(b));' 2>&1)"
[ "$W4" = same ] && ok "W4 the proof-line parser counts the same with and without LOKI-WAIT lines" || bad "W4 parser: $W4"

# W5: pure. The brief names the server wait and the step log once each
W5="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { PROOF_SCRIPT_LINE: L } = await import(process.env.ROOT + "/loki-ts/src/e10ext/context.ts");
const c = (s) => L.split(s).length - 1;
console.log(c("loki_wait_http") === 1 && c("loki-steps.log") === 1 ? "once" : "counts " + c("loki_wait_http") + " " + c("loki-steps.log"));' 2>&1)"
[ "$W5" = once ] && ok "W5 PROOF_SCRIPT_LINE names loki_wait_http and loki-steps.log once each" || bad "W5 brief line: $W5"
finish
