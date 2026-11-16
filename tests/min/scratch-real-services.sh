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
finish
