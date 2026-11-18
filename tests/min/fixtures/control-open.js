// Driver for the dashboard legs of tests/min/cli-entrypoints.sh: which running Control Plane `loki dashboard`,
// `loki control open` and the console's `o` key may reuse, and what replaces one that is stale.
// Every leg runs against a throwaway HOME (the caller's, tests/min/lib.sh), LOKI_CONTROL_PORT=0 (the default port
// 47821 is never probed) and a stand-in server on a free port; the only processes signalled are the `sleep` children
// this file starts and records. No real server is started here and no browser is opened.
// (New file: these legs need live stand-in servers and child processes, which no existing fixture provides.)
// Usage: bun control-open.js <repo root> [leg ...]   prints "PASS <leg>" or "FAIL <leg>: <why>" per leg.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2], only = process.argv.slice(3);
const control = await import(join(ROOT, "loki-ts/src/commands/control.ts"));
const HOME = process.env.HOME;
if (!HOME || !/loki-min\./.test(HOME)) { process.stdout.write("FAIL setup: HOME is not the test's throwaway home\n"); process.exit(1); }
const env = () => ({ HOME, PATH: process.env.PATH, LOKI_CONTROL: "1", LOKI_CONTROL_PORT: "0" });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const mine = []; // the sleep children started here: the only PIDs this file may signal
const tmp = (name) => mkdtempSync(join(HOME, `${name}.`));
/** An install directory, with or without the built dashboard page. */
function install(withPage = true) { const d = tmp("install"); if (withPage) { mkdirSync(join(d, "packages/control-plane/ui/dist"), { recursive: true }); writeFileSync(join(d, "packages/control-plane/ui/dist/index.html"), "<html>dashboard</html>"); } return d; }
/** A stand-in Control Plane: /health answers as one, a `sleep` child is the process its record names. */
function standIn(health, record = {}) {
  const proc = spawn("sleep", ["300"], { stdio: "ignore" }); mine.push(proc.pid);
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ service: "loki-control", pid: proc.pid, ...health }) : new Response("not found", { status: 404 })) });
  const url = `http://127.0.0.1:${srv.port}`;
  mkdirSync(join(HOME, ".loki/control"), { recursive: true });
  writeFileSync(join(HOME, ".loki/control/instance.json"), `${JSON.stringify({ pid: proc.pid, port: srv.port, url, ...record })}\n`);
  return { url, pid: proc.pid, stop: () => { srv.stop(true); if (alive(proc.pid)) process.kill(proc.pid, "SIGKILL"); rmSync(join(HOME, ".loki/control/instance.json"), { force: true }); } };
}
/** Runs fn with process.stderr captured; returns [result, stderr text]. */
async function withStderr(fn) { const keep = process.stderr.write; let text = ""; process.stderr.write = (c) => { text += String(c); return true; }; try { return [await fn(), text]; } finally { process.stderr.write = keep; } }
const gone = async (pid) => { for (let i = 0; i < 60 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

const legs = {
  // The founder's case: the install the server was started from was deleted; /health still answers, same version.
  "stale-install-gone-is-replaced": async () => {
    const dir = install(); rmSync(dir, { recursive: true });
    const s = standIn({ version: "9.9.9", install_path: join(dir, "packages/control-plane/src/server") }, { version: "9.9.9", install_path: dir });
    try {
      const [url, err] = await withStderr(() => control.liveControlPlane(env(), { current: "9.9.9", ownUi: true, waitMs: 4000 }));
      if (url !== null) return `a server whose install is gone was reused: ${url}`;
      if (!(await gone(s.pid))) return "the stale server's recorded PID was not stopped";
      return /no longer exists/.test(err) ? null : `the reason was not printed: ${err}`;
    } finally { s.stop(); }
  },
  "version-mismatch-is-replaced": async () => {
    const dir = install();
    const s = standIn({ version: "1.0.0", install_path: join(dir, "packages/control-plane/src/server"), ui: true }, { version: "1.0.0", install_path: dir });
    try {
      const [url, err] = await withStderr(() => control.liveControlPlane(env(), { current: "9.9.9", ownUi: true, waitMs: 4000 }));
      if (url !== null) return `a server of another version was reused: ${url}`;
      if (!(await gone(s.pid))) return "the old server's recorded PID was not stopped";
      return /running 1\.0\.0, installed 9\.9\.9/.test(err) ? null : `the reason was not printed: ${err}`;
    } finally { s.stop(); }
  },
  "healthy-matching-is-reused": async () => {
    const dir = install();
    const s = standIn({ version: "9.9.9", install_path: join(dir, "packages/control-plane/src/server"), ui: true }, { version: "9.9.9", install_path: dir });
    try {
      const [url, err] = await withStderr(() => control.liveControlPlane(env(), { current: "9.9.9", ownUi: true, waitMs: 1000 }));
      if (url !== s.url) return `want ${s.url}, got ${url}`;
      if (!alive(s.pid)) return "a healthy matching server was stopped";
      return err === "" ? null : `it printed: ${err}`;
    } finally { s.stop(); }
  },
  // The dashboard page is gone from the server's install (a half-removed install). Replaced when this install has the page; when
  // this install has none either (a checkout with no UI build) there is nothing better to start, so it is reused.
  "missing-page-is-replaced": async () => {
    for (const [ownUi, reuse] of [[true, false], [false, true]]) {
      const dir = install(false);
      const s = standIn({ version: "9.9.9", install_path: join(dir, "packages/control-plane/src/server"), ui: false }, { version: "9.9.9", install_path: dir });
      try {
        const [url] = await withStderr(() => control.liveControlPlane(env(), { current: "9.9.9", ownUi, waitMs: 4000 }));
        if (reuse ? url !== s.url : url !== null) return `this install ${ownUi ? "has" : "has no"} dashboard page: got ${url}`;
        if (reuse ? !alive(s.pid) : !(await gone(s.pid))) return `this install ${ownUi ? "has" : "has no"} dashboard page: the server was ${reuse ? "stopped" : "left running"}`;
      } finally { s.stop(); }
    }
    return null;
  },
  // An explicit LOKI_CONTROL_URL is the operator's server: used as it is, never stopped. LOKI_CONTROL=0 finds nothing and stops nothing.
  "explicit-url-and-off-switch-stop-nothing": async () => {
    const dir = install(); rmSync(dir, { recursive: true });
    const s = standIn({ version: "1.0.0", install_path: dir }, { version: "1.0.0", install_path: dir });
    try {
      const [a] = await withStderr(() => control.liveControlPlane({ ...env(), LOKI_CONTROL_URL: `${s.url}/` }, { current: "9.9.9", ownUi: true, waitMs: 500 }));
      const [b] = await withStderr(() => control.liveControlPlane({ ...env(), LOKI_CONTROL: "0" }, { current: "9.9.9", ownUi: true, waitMs: 500 }));
      if (a !== s.url) return `LOKI_CONTROL_URL: want ${s.url}, got ${a}`;
      if (b !== null) return `LOKI_CONTROL=0: want null, got ${b}`;
      return alive(s.pid) ? null : "the server was stopped";
    } finally { s.stop(); }
  },
  // A server that answers on the configured port but has no record (instance.json is gone): reused when it is this install's, and
  // when it is stale it is neither reused nor signalled, since only a PID recorded in instance.json is ever stopped.
  "no-record-is-never-signalled": async () => {
    for (const [version, reuse] of [["9.9.9", true], ["1.0.0", false]]) {
      const dir = install(), s = standIn({ version, install_path: join(dir, "packages/control-plane/src/server"), ui: true });
      rmSync(join(HOME, ".loki/control/instance.json"), { force: true });
      try {
        const [url] = await withStderr(() => control.liveControlPlane({ ...env(), LOKI_CONTROL_PORT: String(new URL(s.url).port) }, { current: "9.9.9", ownUi: true, waitMs: 500 }));
        if (url !== (reuse ? s.url : null)) return `version ${version}: got ${url}`;
        await new Promise((r) => setTimeout(r, 300));
        if (!alive(s.pid)) return `version ${version}: a process with no record was stopped`;
      } finally { s.stop(); }
    }
    return null;
  },
  // An install in a throwaway path (a test or CI install; said here with LOKI_CONTROL_THROWAWAY_INSTALL=1) of another version meets the
  // person's healthy recorded dashboard: it must not signal it and must not rewrite its record. It starts its own on another port, finds
  // it again on the next call, and its `control stop` stops only its own. This leg runs the real commands (a real server on a free port).
  "throwaway-install-leaves-the-real-dashboard-alone": async () => {
    const dir = install(), s = standIn({ version: "0.0.1", install_path: join(dir, "packages/control-plane/src/server"), ui: true }, { version: "0.0.1", install_path: dir });
    const rec = join(HOME, ".loki/control/instance.json"), own = join(HOME, ".loki/control/instance.throwaway.json"), before = readFileSync(rec, "utf8");
    const cli = async (...args) => { const p = Bun.spawn(["bun", "--no-env-file", "--config=/dev/null", join(ROOT, "loki-ts/src/cli.ts"), "control", ...args], { cwd: HOME, env: { ...env(), LOKI_CONTROL_THROWAWAY_INSTALL: "1", LOKI_CONTROL_AUTOINGEST: "0", LOKI_CONTROL_START_WAIT_MS: "30000", LOKI_NO_BROWSER: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { out, err, code }; };
    let ownPid = null;
    try {
      const a = await cli("open", "--no-open"), url = a.out.split("\n")[0];
      try { ownPid = JSON.parse(readFileSync(own, "utf8")).pid; } catch { /* reported below */ }
      if (a.code !== 0 || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) return `control open: exit ${a.code}, printed "${a.out.slice(0, 200)}" ${a.err.slice(0, 200)}`;
      if (url === `${s.url}/` || url.includes(":47821/")) return `it used ${url} (the recorded dashboard is ${s.url})`;
      if (!alive(s.pid)) return "the recorded dashboard of the other install was stopped";
      if (readFileSync(rec, "utf8") !== before) return "instance.json was rewritten";
      if (!Number.isInteger(ownPid) || !alive(ownPid)) return "its own server is not recorded in instance.throwaway.json";
      const b = await cli("open", "--no-open"); if (b.out.split("\n")[0] !== url || /Started the dashboard/.test(b.out)) return `a second call did not reuse its own server: ${b.out.slice(0, 200)}`;
      const c = await cli("stop"); if (c.code !== 0 || !(await gone(ownPid))) return `control stop: exit ${c.code}, its own server ${alive(ownPid) ? "still runs" : "stopped"}: ${c.out}${c.err}`;
      if (!alive(s.pid) || readFileSync(rec, "utf8") !== before) return "control stop touched the other install's dashboard or its record";
      return null;
    } finally {
      // whatever went wrong, the real server this leg started must not outlive it: it is the process either record names that is not the stand-in
      for (const f of [own, rec]) { try { const r = JSON.parse(readFileSync(f, "utf8")); if (Number.isInteger(r.pid) && r.pid !== s.pid && r.install_path === ROOT && alive(r.pid)) { process.kill(r.pid, "SIGTERM"); await gone(r.pid); } } catch { /* no such record */ } }
      s.stop(); rmSync(own, { force: true });
    }
  },
  // The server itself: a page request after its dashboard page or its whole install was removed gets one plain sentence, never a raw
  // file error, and the server is told to stop only when the whole install is gone.
  "server-answers-a-missing-install-in-plain-words": async () => {
    const { createApp } = await import(join(ROOT, "packages/control-plane/src/server/app.ts"));
    const dir = install(); let stops = 0;
    const { app, close } = createApp({ dbPath: ":memory:", uiDir: join(dir, "packages/control-plane/ui/dist"), installDir: dir, onInstallGone: () => { stops++; } });
    try {
      const get = async (p) => { const r = await app.fetch(new Request(`http://127.0.0.1${p}`)); return { status: r.status, text: await r.text() }; };
      const ok = await get("/"); if (ok.status !== 200 || !ok.text.includes("dashboard")) return `with the page on disk: ${ok.status} ${ok.text.slice(0, 80)}`;
      if (JSON.parse((await get("/health")).text).ui !== true) return "/health does not report ui: true";
      rmSync(join(dir, "packages/control-plane/ui/dist/index.html"));
      const half = await get("/"); if (half.status !== 503 || !/no longer exists in full/.test(half.text) || /ENOENT/.test(half.text) || stops !== 0) return `page removed: ${half.status} "${half.text.trim()}" stops=${stops}`;
      rmSync(dir, { recursive: true });
      const none = await get("/runs/x"); if (none.status !== 503 || !none.text.startsWith("This dashboard was started from an install that no longer exists; run `loki dashboard`") || stops !== 1) return `install removed: ${none.status} "${none.text.trim()}" stops=${stops}`;
      if (JSON.parse((await get("/health")).text).ui !== false) return "/health still reports ui: true";
      return (await get("/v1/runs")).status === 200 ? null : "the API stopped answering";
    } finally { close(); }
  },
  // `loki control open` and the o key share ensureControlPlane: nothing running, so one is started (the start is recorded here, not real)
  // in the given directory with the browser switched off for the server itself, and its URL comes back once it answers.
  "none-running-so-one-is-started": async () => {
    const dir = install(), calls = []; let s = null;
    try {
      const [r] = await withStderr(() => control.ensureControlPlane(env(), { current: "9.9.9", ownUi: true, cwd: dir, waitMs: 3000, startImpl: (argv, o) => { calls.push({ argv, o }); s = standIn({ version: "9.9.9", install_path: dir, ui: true }, { version: "9.9.9", install_path: dir }); return s.pid; } }));
      if (calls.length !== 1) return `the server was started ${calls.length} times, want 1`;
      const { argv, o } = calls[0];
      if (argv.slice(-2).join(" ") !== "control serve" || argv[0] !== "bun") return `started with: ${argv.join(" ")}`;
      if (o.cwd !== dir || o.env.LOKI_NO_BROWSER !== "1" || o.env.HOME !== HOME || !o.log.startsWith(join(HOME, ".loki/control"))) return `started with cwd ${o.cwd}, LOKI_NO_BROWSER=${o.env.LOKI_NO_BROWSER}, log ${o.log}`;
      return r.url === s.url && r.started === true ? null : `got ${JSON.stringify(r)}, want ${s.url} started`;
    } finally { s?.stop(); }
  },
  // The founder's case end to end: the stale server is stopped and the caller's own is started in its place.
  "stale-one-is-stopped-and-a-new-one-started": async () => {
    const dead = install(); rmSync(dead, { recursive: true });
    const old = standIn({ version: "9.9.9", install_path: join(dead, "packages/control-plane/src/server") }, { version: "9.9.9", install_path: dead });
    const dir = install(); let fresh = null, starts = 0;
    try {
      const [r] = await withStderr(() => control.ensureControlPlane(env(), { current: "9.9.9", ownUi: true, cwd: dir, waitMs: 3000, startImpl: () => { starts++; fresh = standIn({ version: "9.9.9", install_path: dir, ui: true }, { version: "9.9.9", install_path: dir }); return fresh.pid; } }));
      if (!(await gone(old.pid))) return "the stale server was left running";
      return starts === 1 && r.url === fresh.url && r.url !== old.url ? null : `starts=${starts}, got ${r.url}, stale was ${old.url}`;
    } finally { old.stop(); fresh?.stop(); }
  },
  // It cannot start: one short reason each time, never a hang, and LOKI_CONTROL=0 starts nothing.
  "cannot-start-gives-one-short-reason": async () => {
    const reason = async (e, o) => { try { await withStderr(() => control.ensureControlPlane(e, { current: "9.9.9", ownUi: true, ...o })); return "(no error)"; } catch (x) { return x.message; } };
    let starts = 0; const t0 = Date.now();
    const off = await reason({ ...env(), LOKI_CONTROL: "0" }, { startImpl: () => { starts++; return undefined; } });
    if (off !== "the Control Plane is off (LOKI_CONTROL=0)" || starts !== 0) return `LOKI_CONTROL=0: "${off}", starts=${starts}`;
    const died = await reason(env(), { waitMs: 3000, startImpl: () => { const c = spawn("true", [], { stdio: "ignore" }); return c.pid; } });
    if (!/^it stopped as it started \(see ~\/\.loki\/control\/serve\.log\)$/.test(died)) return `a server that exits at once: "${died}"`;
    const idle = spawn("sleep", ["300"], { stdio: "ignore" }); mine.push(idle.pid);
    const mute = await reason(env(), { waitMs: 700, startImpl: () => idle.pid });
    process.kill(idle.pid, "SIGKILL");
    if (!/^it did not answer within 1 s \(see ~\/\.loki\/control\/serve\.log\)$/.test(mute)) return `a server that never answers: "${mute}"`;
    const thrown = await reason(env(), { startImpl: () => { throw new Error("spawn bun ENOENT"); } });
    if (thrown !== "it could not be started (spawn bun ENOENT)") return `a start that throws: "${thrown}"`;
    return Date.now() - t0 < 8000 ? null : `the four failures took ${Date.now() - t0} ms`;
  },
  // When a browser is opened and with what: argv only, and never under an opt-out, CI, SSH, no terminal or no display.
  "browser-rules": () => {
    const url = "http://127.0.0.1:1234/#/runs/abcdef0123456789/e10-run-1", have = () => "/usr/bin/x", mac = { platform: "darwin", tty: true, which: have }, lin = { platform: "linux", tty: true, which: have };
    const rows = [
      ["macOS", {}, mac, ["open", url]], ["Linux with a display", { DISPLAY: ":0" }, lin, ["xdg-open", url]], ["Linux on Wayland", { WAYLAND_DISPLAY: "wayland-0" }, lin, ["xdg-open", url]],
      ["Windows", {}, { platform: "win32", tty: true, which: have }, ["cmd", "/c", "start", "", url]],
      ["LOKI_NO_BROWSER=1", { LOKI_NO_BROWSER: "1" }, mac, null], ["LOKI_NO_AUTO_OPEN=1", { LOKI_NO_AUTO_OPEN: "1" }, mac, null], ["LOKI_HEADLESS=1", { LOKI_HEADLESS: "1" }, mac, null],
      ["CI", { CI: "true" }, mac, null], ["SSH", { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }, mac, null], ["no terminal", {}, { ...mac, tty: false }, null],
      ["Linux, no display", {}, lin, null], ["no opener on PATH", {}, { ...mac, which: () => null }, null],
    ];
    for (const [name, e, o, want] of rows) { const got = control.browserArgv(url, e, o); if (JSON.stringify(got) !== JSON.stringify(want)) return `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`; }
    for (const bad of ["http://127.0.0.1:1/ a", "http://127.0.0.1:1/\"x", "file:///etc/passwd", "http://127.0.0.1:1/&calc", "javascript:alert(1)"]) if (control.browserArgv(bad, {}, mac) !== null) return `a browser would be opened for ${bad}`;
    const spawned = [];
    if (control.openBrowser(url, {}, { ...mac, spawnImpl: (a) => spawned.push(a) }) !== true || spawned.length !== 1 || spawned[0].join(" ") !== `open ${url}`) return `openBrowser spawned ${JSON.stringify(spawned)}`;
    if (control.openBrowser(url, { LOKI_NO_BROWSER: "1" }, { ...mac, spawnImpl: (a) => spawned.push(a) }) !== false || spawned.length !== 1) return "openBrowser spawned something under LOKI_NO_BROWSER=1";
    return control.openBrowser(url, {}, { ...mac, spawnImpl: () => { throw new Error("ENOENT"); } }) === false ? null : "an opener that cannot start was reported as opened";
  },
};
const out = [];
for (const [name, fn] of Object.entries(legs)) {
  if (only.length && !only.includes(name)) continue;
  let bad; try { bad = await fn(); } catch (e) { bad = `threw: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e}`; }
  out.push(bad ? `FAIL ${name}: ${bad}` : `PASS ${name}`);
}
for (const pid of mine) if (alive(pid)) process.kill(pid, "SIGKILL");
for (const f of ["serve.pid", "serve.log", "instance.json"]) rmSync(join(HOME, ".loki/control", f), { force: true }); // what the legs above wrote
process.stdout.write(`${out.join("\n")}\n`);
process.exit(0);
