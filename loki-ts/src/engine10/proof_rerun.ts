// The harness's own re-run of the implement session's proof script. The session's reply is written by the author of the code, so a command and result
// in it are a claim. This module turns the claim into a fact Loki holds: the session leaves one script that builds everything from empty and exercises
// each requested item; after the session and every fix round, Loki runs that script itself in a new run-owned scratch directory and records the real
// exit code and output. The acceptance line check reads that output, not the reply. (New file: no module owned a harness-run proof; stages/prove.ts is
// the separate prover session, off by default.)
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupSessionScratch, createSessionScratch, scratchSessionEnv } from "../runner/worker_proc.ts";
import { run } from "../util/shell.ts";
import { CONNECTION_ENV } from "./session.ts";
import { acceptanceLines, FRESH_INSTALL_ASK, issueAcceptanceCapOn, issueAcceptanceOf, optionalAsk } from "../util/intent_card.ts";
import { neededServices } from "../util/stack_tools.ts";
import { issueRunBrief } from "./types.ts";

/** The lines the label is checked against: the issue's own checklist, else (an issue in prose) the plan's acceptance lines; plus the fresh-install line when
 *  the repository needs a database or another service. Empty when the check is off or nothing gives a line. */
export function labelAsks(provider: string, intake: Record<string, unknown> | undefined, plan: unknown, repoDir: string, env: NodeJS.ProcessEnv = process.env): { asks: string[]; source: "issue" | "plan"; needs: string[] } {
  if (!issueAcceptanceCapOn(env)) return { asks: [], source: "issue", needs: [] };
  const listed = issueAcceptanceOf(intake), own = listed.length ? listed : issueRunBrief(provider, intake?.["source"], env) ? acceptanceLines(plan as never) : [];
  let needs: string[] = []; if (own.length) { try { needs = neededServices(repoDir); } catch { needs = []; } }
  return { asks: own.length && needs.length ? [...own, FRESH_INSTALL_ASK] : own, source: listed.length ? "issue" : "plan", needs };
}
/** A tree object of the working tree as it stands (tracked changes and new files, ignores respected), built in a throwaway index so the real index is
 *  never touched. Lets the acceptance check read the uncommitted change with `git diff <base> <tree>`. Null when git cannot build it. */
export async function worktreeTree(repoDir: string): Promise<string | null> {
  const idx = join(repoDir, ".git", `loki-label-index-${process.pid}`);
  try {
    const real = join(repoDir, ".git", "index"); if (existsSync(real)) copyFileSync(real, idx);
    const env = { GIT_INDEX_FILE: idx };
    const a = await run(["git", "-C", repoDir, "add", "-A", "--", "."], { env, timeoutMs: 60000 }); if (a.exitCode !== 0) return null;
    const w = await run(["git", "-C", repoDir, "write-tree"], { env, timeoutMs: 60000 }), sha = w.stdout.trim();
    return w.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch { return null; } finally { try { rmSync(idx, { force: true }); } catch { /* a stale throwaway index is harmless */ } }
}
/** The brief that hands unmet lines back to the session: each line with the check's reason, and what closing it takes. */
export function unmetBrief(unmet: { line: string; reason: string }[]): string {
  return [`Loki checked your change against the acceptance lines, using its own run of your proof script. ${unmet.length} line${unmet.length === 1 ? " is" : "s are"} not met yet:`, "",
    ...unmet.map((u, i) => `${i + 1}. ${u.line}\n   Why not: ${u.reason || "no evidence that it was exercised"}`), "",
    "Close each one. If the product does not do it, make it do it. If it does but nothing proves it, add the proof to $LOKI_SCRATCH/loki-proof.sh: send the exact request the real caller sends (for a page, every path its client code calls, with the same method and parameters) and print a PROVED or FAILED line with the real response. Run the script yourself with a new empty directory until it exits 0, leave it in place, and end with the same finish line. Do not weaken a check to make it pass.",
  ].join("\n");
}
export { optionalAsk };

export const PROOF_SCRIPT = "loki-proof.sh";
export const PROOF_HELPER = "loki-check.sh", ACCEPTANCE_FILE = "acceptance.txt";
/** The check functions the proof script must use. Loki writes this file (the session never edits it) and writes it again, with a random token, into the
 *  directory of its own run: only lines these functions print with that token are counted, so the label is a tally of checks Loki executed, never a reading
 *  of free text. Each check names the acceptance line number it proves. */
export const PROOF_HELPER_SH = `# Loki proof helpers. Source this file; never edit it. Only lines printed by these functions count toward the label.
_lp() { printf 'LOKI-PROOF %s %s %s: %s\\n' "\${LOKI_PROOF_TOKEN:-session}" "$1" "$2" "$3"; }
# loki_http <line number> "<what is proved>" <expected status> <curl arguments...>
#   Sends the request with curl. Passes when the status equals the expected one (and, when LOKI_BODY_MATCH is set, the body matches that grep -E pattern).
loki_http() {
  local n="$1" what="$2" want="$3"; shift 3
  local body code snip ok=1
  body="$(mktemp "\${TMPDIR:-/tmp}/lpb.XXXXXX")" || return 1
  code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 60 "$@" 2>/dev/null)" || code="000"
  snip="$(head -c 300 "$body" | tr '\\n' ' ')"
  [ "$code" = "$want" ] || ok=0
  if [ "$ok" = 1 ] && [ -n "\${LOKI_BODY_MATCH:-}" ]; then grep -Eq -- "$LOKI_BODY_MATCH" "$body" || ok=0; fi
  rm -f "$body"
  if [ "$ok" = 1 ]; then _lp PROVED "$n" "$what | status $code | $snip"; else _lp FAILED "$n" "$what | wanted $want\${LOKI_BODY_MATCH:+ and a body matching $LOKI_BODY_MATCH}, got $code | $snip"; return 1; fi
}
# loki_cmd <line number> "<what is proved>" <command...>
#   Runs the command. Passes when it exits 0. Use it for a test run, a query plan, a file that must exist, anything that is not one HTTP request.
loki_cmd() {
  local n="$1" what="$2"; shift 2
  local out rc snip
  out="$("$@" 2>&1)"; rc=$?
  snip="$(printf '%s' "$out" | tail -n 3 | tr '\\n' ' ' | cut -c1-300)"
  if [ "$rc" = 0 ]; then _lp PROVED "$n" "$what | exit 0 | $snip"; else _lp FAILED "$n" "$what | exit $rc | $snip"; return 1; fi
}

# ---- Throwaway services. Use these; never use or expect a database or cache already running on this machine. ----
# loki_free_port: prints a TCP port that is free on 127.0.0.1 right now.
loki_free_port() {
  python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()' 2>/dev/null \
    || perl -MIO::Socket::INET -e '$s=IO::Socket::INET->new(Listen=>1,LocalAddr=>"127.0.0.1",LocalPort=>0) or exit 1; print $s->sockport(),"\n"'
}
# _loki_bin <name>: prints the path of a program from PATH or the usual install locations.
_loki_bin() {
  local n="$1" d p
  p="$(command -v "$n" 2>/dev/null)" && [ -n "$p" ] && { printf '%s\n' "$p"; return 0; }
  for d in /opt/homebrew/opt/postgresql@*/bin /opt/homebrew/opt/postgresql/bin /usr/local/opt/postgresql@*/bin /usr/local/opt/postgresql/bin /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /opt/homebrew/bin /usr/local/bin /usr/bin; do
    [ -x "$d/$n" ] && { printf '%s\n' "$d/$n"; return 0; }
  done
  return 1
}
# loki_pg_start <empty dir>: starts a new, empty PostgreSQL under <dir>/pg on a free 127.0.0.1 port (superuser "postgres", no password).
#   Exports PGHOST PGPORT PGUSER PGDATABASE and DATABASE_URL, and LOKI_PG_BIN (the directory holding psql, createdb). Non-zero with the reason on failure.
loki_pg_start() {
  local dir="$1" initdb pgctl
  initdb="$(_loki_bin initdb)" && pgctl="$(_loki_bin pg_ctl)" || { echo "loki_pg_start: PostgreSQL programs (initdb, pg_ctl) are not installed on this machine" >&2; return 1; }
  export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
  LOKI_PG_DATA="$dir/pg"; LOKI_PG_CTL="$pgctl"; LOKI_PG_BIN="$(dirname "$pgctl")"; PGPORT="$(loki_free_port)" || return 1
  "$initdb" -D "$LOKI_PG_DATA" -U postgres -A trust -E UTF8 >"$dir/pg-init.log" 2>&1 || { echo "loki_pg_start: initdb failed, see $dir/pg-init.log" >&2; return 1; }
  "$pgctl" -D "$LOKI_PG_DATA" -l "$dir/pg.log" -w -t 60 -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null 2>&1 || { echo "loki_pg_start: the server did not start, see $dir/pg.log" >&2; return 1; }
  export LOKI_PG_DATA LOKI_PG_CTL LOKI_PG_BIN PGPORT PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/postgres"
}
# loki_redis_start <empty dir>: starts a new, empty Redis on a free 127.0.0.1 port. Exports REDIS_HOST REDIS_PORT REDIS_URL.
loki_redis_start() {
  local dir="$1" rs
  rs="$(_loki_bin redis-server)" || { echo "loki_redis_start: redis-server is not installed on this machine" >&2; return 1; }
  REDIS_PORT="$(loki_free_port)" || return 1
  mkdir -p "$dir/redis" && "$rs" --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$dir/redis" --save "" --appendonly no --daemonize yes --pidfile "$dir/redis/redis.pid" --logfile "$dir/redis/redis.log" >/dev/null 2>&1 || { echo "loki_redis_start: redis-server did not start" >&2; return 1; }
  export REDIS_PORT REDIS_HOST=127.0.0.1 REDIS_URL="redis://127.0.0.1:$REDIS_PORT"; LOKI_REDIS_PID="$dir/redis/redis.pid"
}
# loki_services_stop: stops what loki_pg_start and loki_redis_start started. Call it from your EXIT trap.
loki_services_stop() {
  [ -n "\${LOKI_PG_DATA:-}" ] && [ -n "\${LOKI_PG_CTL:-}" ] && "$LOKI_PG_CTL" -D "$LOKI_PG_DATA" -m fast stop >/dev/null 2>&1
  [ -n "\${LOKI_REDIS_PID:-}" ] && [ -f "$LOKI_REDIS_PID" ] && kill "$(cat "$LOKI_REDIS_PID")" 2>/dev/null
  return 0
}
`;
/** Writes the helper (and, for the session, the numbered acceptance lines) into a scratch directory. Never throws. */
export function writeProofKit(dir: string, asks: string[] | null): void {
  try { writeFileSync(join(dir, PROOF_HELPER), PROOF_HELPER_SH, { mode: 0o600 }); if (asks?.length) writeFileSync(join(dir, ACCEPTANCE_FILE), asks.map((a, i) => `${i + 1}. ${a}`).join("\n") + "\n", { mode: 0o600 }); } catch { /* the proof then has no helper; the re-run reports it */ }
}
/** The tally of helper lines carrying this run's token: per acceptance line number, how many checks passed and failed, and the first text of each. */
export function tallyProof(out: string, token: string): Record<string, { proved: number; failed: number; first_proved?: string; first_failed?: string }> {
  const t: Record<string, { proved: number; failed: number; first_proved?: string; first_failed?: string }> = {};
  for (const l of out.split("\n")) {
    const m = /^LOKI-PROOF (\S+) (PROVED|FAILED) (\d{1,3}): (.*)$/.exec(l.trim()); if (!m || m[1] !== token) continue;
    const e = (t[m[3]!] ??= { proved: 0, failed: 0 }), txt = m[4]!.slice(0, 300);
    if (m[2] === "PROVED") { e.proved++; e.first_proved ??= txt; } else { e.failed++; e.first_failed ??= txt; }
  }
  return t;
}
const MAX_SCRIPT_BYTES = 200_000, TAIL_CHARS = 8000;
/** Seconds Loki gives its own re-run (LOKI_E10_PROOF_RERUN_S overrides). */
export const proofRerunS = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env["LOKI_E10_PROOF_RERUN_S"]); return n > 0 ? n : 600; };
/** How many times Loki hands a failing re-run back to the session before sealing (LOKI_E10_PROOF_LOOP_MAX, default 3; 0 only reports). */
export const proofLoopMax = (env: NodeJS.ProcessEnv = process.env): number => { const v = (env["LOKI_E10_PROOF_LOOP_MAX"] ?? "").trim(), n = Number(v); return v !== "" && Number.isInteger(n) && n >= 0 ? n : 3; };
/** On by default; LOKI_E10_PROOF_RERUN=0 opts out (the label then rests on the session's own description again). */
export const proofRerunOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PROOF_RERUN"] ?? "").trim());

/** Copies the session's proof script out of its scratch directory before the scratch is removed. True when a script was kept. */
export function keepProofScript(scratchDir: string, runDir: string): boolean {
  try {
    const src = join(scratchDir, PROOF_SCRIPT);
    if (!existsSync(src)) return false;
    const st = statSync(src);
    if (!st.isFile() || st.size === 0 || st.size > MAX_SCRIPT_BYTES) return false;
    // A session often writes its own scratch path as a literal (". /private/tmp/lk-AbC/loki-check.sh"). That directory is gone when Loki runs the script in a
    // new one, so the kept copy names the directory by its variable instead: the same script then runs anywhere.
    const real = (() => { try { return realpathSync(scratchDir); } catch { return scratchDir; } })(), names = [...new Set([real, scratchDir, real.replace(/^\/private\//, "/")])].filter((d) => d.length > 5).sort((a, b) => b.length - a.length);
    let text = readFileSync(src, "utf8"); for (const d of names) text = text.split(d).join("${LOKI_SCRATCH}");
    writeFileSync(join(runDir, PROOF_SCRIPT), text, { mode: 0o700 });
    return true;
  } catch { return false; }
}

/** Why a proof script is not run at all, or null. The result marker reaches the script (the check functions run inside it), so a script that reads the
 *  marker, prints a result line by hand or redefines a check function could have a line counted that no check produced. Loki refuses such a script
 *  before running it and says why, so the session rewrites it. This catches the plain forms only; it is a guard, not a proof that every check is meaningful. */
export function proofScriptRefusal(text: string): string | null {
  const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  // Printing is the forgery, reading is not: a script may grep its own output for LOKI-PROOF lines to count failures (two Haiku runs did, and the first form of
  // this guard refused them in every round), so only a line that writes a result line, or uses the marker while writing, is refused.
  const writes = code.split("\n").filter((l) => /(^|[\s;&|(])(echo|printf|print|tee|cat)\b/.test(l) && !/(^|[\s;&|(])(grep|egrep|awk|sed|rg)\b[^|]*LOKI-PROOF/.test(l));
  if (writes.some((l) => /LOKI_PROOF_TOKEN/.test(l))) return "the proof script writes output using LOKI_PROOF_TOKEN; results count only when loki_http or loki_cmd print them";
  if (writes.some((l) => /LOKI-PROOF/.test(l))) return "the proof script prints a LOKI-PROOF result line itself; results count only when loki_http or loki_cmd print them";
  if (/(^|[\s;&|({])(function\s+)?(loki_http|loki_cmd|_lp)\s*\(\s*\)/.test(code)) return "the proof script redefines loki_http, loki_cmd or _lp; source loki-check.sh and use its functions unchanged";
  return null;
}
export interface ProofRerun { refused?: string; exit: number | null; seconds: number; proved: number; failed: number; tail: string; script_chars: number; stopped: number; left: number; lines: Record<string, { proved: number; failed: number; first_proved?: string; first_failed?: string }> }
/** Runs the kept script once, from the repository root, in a new scratch directory that the same ownership cleanup stops and removes afterwards.
 *  Null when no script was kept or the re-run is off. Never throws. */
export async function rerunProof(repoDir: string, runDir: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<ProofRerun | null> {
  const script = join(runDir, PROOF_SCRIPT);
  if (!proofRerunOn(env) || !existsSync(script)) return null;
  let scriptChars = 0, refusal: string | null = null; try { const t = readFileSync(script, "utf8"); scriptChars = t.length; refusal = proofScriptRefusal(t); } catch { return null; }
  if (refusal) return { refused: refusal, exit: null, seconds: 0, proved: 0, failed: 0, tail: `Loki did not run this proof script: ${refusal}.`, script_chars: scriptChars, stopped: 0, left: 0, lines: {} };
  let scratch: ReturnType<typeof createSessionScratch>;
  try { scratch = createSessionScratch(); } catch { return { exit: null, seconds: 0, proved: 0, failed: 0, tail: "Loki could not create a scratch directory for its own re-run", script_chars: scriptChars, stopped: 0, left: 0, lines: {} }; }
  const blank: Record<string, string> = {}; for (const k of Object.keys(env)) if (CONNECTION_ENV.test(k)) blank[k] = ""; // the re-run never sees the user's own database settings either
  const token = randomBytes(8).toString("hex"); writeProofKit(scratch.dir, null); // Loki's own copy of the helper and a token that exists only in this run
  const t0 = Date.now();
  let exit: number | null = null, out = "";
  try {
    const emptyDir = join(scratch.dir, "run"); mkdirSync(emptyDir, { mode: 0o700 }); // the script's argument is an EMPTY directory: the scratch itself holds Loki's helper, and a script that checks for emptiness refused it
    const r = await run(["bash", script, emptyDir], { cwd: repoDir, timeoutMs: proofRerunS(env) * 1000, group: true, signal, env: { ...blank, ...scratchSessionEnv(scratch), LOKI_PROOF_TOKEN: token } });
    exit = r.exitCode; out = `${r.stdout}\n${r.stderr}`;
  } catch (e) { out = `Loki's re-run did not complete: ${(e as Error).message}`; }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const clean = cleanupSessionScratch(scratch);
  const text = out.replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, " ");
  const lines = tallyProof(text, token), vals = Object.values(lines);
  return { exit, seconds, proved: vals.reduce((a, v) => a + v.proved, 0), failed: vals.reduce((a, v) => a + v.failed, 0), tail: text.replace(new RegExp(`LOKI-PROOF ${token} `, "g"), "").slice(-TAIL_CHARS), script_chars: scriptChars, stopped: clean.stopped.length, left: clean.left.length, lines };
}
/** The facts for the acceptance line check: what Loki's own run of the script returned, and the script itself (so a script that checks nothing is visible). */
export function proofFacts(runDir: string, r: ProofRerun | null, expected: boolean): string[] {
  if (!r) return expected ? ["The session left no proof script ($LOKI_SCRATCH/loki-proof.sh), so Loki could not re-run anything itself. Nothing in the reply counts as proof from running."] : [];
  let script = ""; try { script = readFileSync(join(runDir, PROOF_SCRIPT), "utf8").slice(0, 12000); } catch { /* the facts still say what ran */ }
  return [
    `Loki re-ran the session's proof script by itself, after the session and every fix round, in a new empty directory: exit ${r.exit === null ? "none (it did not complete)" : r.exit} after ${r.seconds}s; ${r.proved} passing check(s), ${r.failed} failing check(s), counted by Loki from its own helper functions. Only this run counts as proof from running; what the reply says about earlier runs does not.`,
    `Output of Loki's own run (real, last ${TAIL_CHARS} characters):\n${r.tail || "(no output)"}`,
    `The script Loki ran (check that each PROVED line comes from a real request or command and its response, not from an unconditional echo):\n${script || "(unreadable)"}`,
  ];
}

/** The fixed rule: an acceptance line is met when Loki's own run has at least one passing check for its number and no failing one. No model is asked. */
export function ruleStatus(asks: string[], r: ProofRerun | null): { line: string; status: "met" | "unmet"; evidence?: string; reason?: string; optional?: true }[] {
  return asks.map((line, i) => {
    const e = r?.lines[String(i + 1)], opt = optionalAsk(line) ? { optional: true as const } : {};
    if (e && e.proved > 0 && e.failed === 0) return { line, status: "met" as const, evidence: `Loki's own run: ${e.proved} passing check${e.proved === 1 ? "" : "s"}; first: ${e.first_proved ?? ""}`.slice(0, 300), ...opt };
    return { line, status: "unmet" as const, reason: (!r ? "there is no proof script for Loki to run" : r.refused ? `Loki did not run the proof script: ${r.refused}` : r.exit === null ? "Loki's own run of the proof did not finish" : e && e.failed > 0 ? `a check failed in Loki's own run: ${e.first_failed ?? ""}` : "Loki's own run has no passing check for this line").slice(0, 300), ...opt };
  });
}
