// Driver for the live console legs of tests/min/one-line-goal.sh (the console that `loki start` shows on a terminal:
// loki-ts/src/e10ext/console.ts). It draws the console into a small terminal emulator (a grid of rows by columns that
// applies cursor-up, erase and newline the way a terminal does, with scrollback and reflow on resize) and checks, after
// every step, that the terminal holds exactly one panel and nothing of an older one.
// (New file: no existing fixture holds a terminal emulator, and a bash heredoc of this size would not be readable.)
// Usage: bun live-console.js <path to console.ts> [leg ...]   prints "PASS <leg>" or "FAIL <leg>: <why>" per leg.
const { LiveConsole } = await import(process.argv[2]);
const { spawnWorker } = await import(new URL("../runner/worker_proc.ts", `file://${process.argv[2]}`).pathname);
const only = process.argv.slice(3);

class Term {
  constructor(cols, rows) { this.cols = cols; this.rows = rows; this.buf = [{ t: [], wrapped: false }]; this.r = 0; this.c = 0; this.top = 0; this.moves = []; }
  row(i) { while (this.buf.length <= i) this.buf.push({ t: [], wrapped: false }); return this.buf[i]; }
  down() { this.r++; this.row(this.r); if (this.r >= this.top + this.rows) this.top = this.r - this.rows + 1; }
  write(s) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\x1b") {
        const m = /^\x1b\[(\??[0-9;]*)([A-Za-z])/.exec(s.slice(i, i + 24));
        if (!m) continue;
        i += m[0].length - 1;
        const n = Number(m[1]) || 0;
        if (m[2] === "A") { this.moves.push({ asked: n || 1, could: this.r - this.top }); this.r = Math.max(this.top, this.r - (n || 1)); }
        else if (m[2] === "J") { this.row(this.r).t.length = Math.min(this.row(this.r).t.length, this.c); this.buf.length = this.r + 1; }
        else if (m[2] === "K") { this.row(this.r).t = []; }
        continue; // colors and cursor show/hide change nothing on the grid
      }
      if (ch === "\r") { this.c = 0; continue; }
      if (ch === "\n") { this.down(); this.row(this.r).wrapped = false; continue; } // a bare line feed: the column is kept (no newline translation), and the row it reaches starts a line of its own
      if (this.c >= this.cols) { this.down(); this.c = 0; this.row(this.r).wrapped = true; this.row(this.r).t = []; }
      const row = this.row(this.r);
      while (row.t.length < this.c) row.t.push(" ");
      row.t[this.c++] = ch;
    }
  }
  /** A resize the way Terminal.app, iTerm2 and VTE do it: every line is wrapped again to the new width, the cursor stays on its line. */
  resize(cols, rows) {
    const logical = []; let curLine = 0;
    this.buf.forEach((row, i) => { if (row.wrapped && logical.length) logical[logical.length - 1] += row.t.join(""); else logical.push(row.t.join("")); if (i === this.r) curLine = logical.length - 1; });
    this.cols = cols; this.rows = rows; this.buf = [];
    logical.forEach((line, i) => {
      if (i === curLine) this.r = this.buf.length;
      const text = line.replace(/\s+$/, "");
      if (text.length === 0) { this.buf.push({ t: [], wrapped: false }); return; }
      for (let k = 0; k < text.length; k += cols) this.buf.push({ t: [...text.slice(k, k + cols)], wrapped: k > 0 });
    });
    this.c = 0; this.top = Math.max(0, this.r - rows + 1);
  }
  lines(from = 0) { const out = this.buf.slice(from).map((row) => row.t.join("").replace(/\s+$/, "")); while (out.length && out[out.length - 1] === "") out.pop(); return out; }
}

const PRE = ["$ loki start acme/widget#19", "Loki 10 engine, cap $5.00"];
const fakeStdin = () => { const subs = []; return { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on(ev, cb) { if (ev === "data") subs.push(cb); }, press(k) { for (const cb of subs) cb(Buffer.from(k)); } }; };
let clock = 1_000_000;
function setup(cols, rows, extra = {}) {
  const t = new Term(cols, rows), stdin = fakeStdin();
  t.write(`${PRE.join("\r\n")}\r\n`);
  const con = new LiveConsole({ write: (x) => t.write(x), hookStd: false, stdin, onCancel: () => {}, columns: cols, rows, size: () => ({ columns: t.cols, rows: t.rows }), env: { NO_COLOR: "1" }, now: () => clock, spend: () => "$0.02 so far", repoDir: "/nonexistent-repo", ...extra });
  return { t, con, stdin };
}
const ev = (type, stage, data = {}) => ({ type, stage, data, run: "e10-test-run" });
const accept = (n, text = (i) => `acceptance line number ${i + 1} of the issue`) => Array.from({ length: n }, (_, i) => text(i));
const statuses = (n, metUpTo, text = (i) => `acceptance line number ${i + 1} of the issue`) => Array.from({ length: n }, (_, i) => ({ line: text(i), status: i < metUpTo ? "met" : "unmet", checks: i < metUpTo ? 2 : 0, reason: "no passing check names this line" }));
function start(con, n) {
  con.onEvent(ev("run.started", null, { issue_ref: "acme/widget#19", model: "sonnet" }));
  con.onEvent(ev("stage.started", "intake")); con.onEvent(ev("stage.completed", "intake", { duration_s: 2, issue_acceptance: accept(n) }));
  con.onEvent(ev("stage.started", "plan")); con.onEvent(ev("stage.completed", "plan", { duration_s: 3 }));
  con.onEvent(ev("stage.started", "implement")); con.onEvent(ev("cost", "implement", {}));
}
/** The whole terminal (scrollback included) is the lines printed before the console plus exactly the console's current frame. */
function onePanel(t, con, label, before = PRE) {
  // a frame line longer than the window (only a dashboard link that must be shown whole) wraps on the terminal
  const want = [...before, ...con.frame()].flatMap((l) => (l.length > t.cols ? l.match(new RegExp(`.{1,${t.cols}}`, "g")) : [l])).map((l) => l.replace(/\s+$/, "")); while (want.length && want[want.length - 1] === "") want.pop();
  const got = t.lines(), heads = got.filter((l) => l.startsWith("LOKI  ")).length;
  if (heads !== 1) return `${label}: ${heads} panel headers on the terminal, want 1\n${got.map((l) => `      | ${l}`).join("\n")}`;
  if (got.join("\n") !== want.join("\n")) { const i = got.findIndex((l, k) => l !== want[k]); return `${label}: the terminal differs from the frame at row ${i}: got "${got[i] ?? "(none)"}" want "${want[i] ?? "(none)"}" (${got.length} rows on the terminal, ${want.length} wanted)`; }
  const short = t.moves.find((m) => m.asked > m.could);
  if (short) return `${label}: a redraw asked the cursor to go up ${short.asked} rows with only ${short.could} above it in the window`;
  return null;
}
const legs = {
  // The acceptance list grows from 7 to 8 to 9 lines and then drops to 3: each redraw must move up over the previous frame's height.
  "grow-and-shrink": () => {
    const { t, con } = setup(100, 40); let bad;
    start(con, 7); if ((bad = onePanel(t, con, "7 lines"))) return bad;
    for (const n of [8, 9]) { clock += 5000; con.onEvent(ev("proof.rerun", "implement", { round: n - 7, exit: 1, proved: n - 2, failed: 2, seconds: 4, statuses: statuses(n, n - 2) })); con.tick(); if ((bad = onePanel(t, con, `${n} lines`))) return bad; }
    con.onEvent(ev("proof.rerun", "implement", { round: 3, exit: 0, proved: 3, failed: 0, seconds: 4, statuses: statuses(3, 3) })); if ((bad = onePanel(t, con, "back to 3 lines"))) return bad;
    con.clear(); const end = t.lines(); return end.filter((l) => l.startsWith("LOKI  ")).length === 1 ? null : "after clear(): not exactly one panel left on the terminal";
  },
  // The d key opens and closes the details list (about 8 more rows) while the acceptance list changes under it.
  "details-on-and-off": () => {
    const { t, con, stdin } = setup(100, 40); let bad;
    start(con, 8); stdin.press("d"); if ((bad = onePanel(t, con, "details on"))) return bad;
    if (!con.frame().some((l) => l.startsWith("Recent:"))) return "the d key did not open the details list";
    con.onEvent(ev("proof.rerun", "implement", { round: 1, exit: 1, proved: 5, failed: 4, seconds: 4, statuses: statuses(9, 5) })); if ((bad = onePanel(t, con, "details on, 9 lines with reasons"))) return bad;
    stdin.press("d"); if ((bad = onePanel(t, con, "details off"))) return bad;
    stdin.press("d"); stdin.press("d"); con.tick(); return onePanel(t, con, "details toggled twice");
  },
  // A line longer than the window, and wide characters (two cells each): no line of a frame may wrap.
  "long-and-wide-lines": () => {
    const { t, con } = setup(60, 40); let bad;
    const text = (i) => (i === 1 ? "x".repeat(500) : i === 2 ? "日本語の受け入れ基準 ".repeat(12) : i === 3 ? "🚀 ships 🚀 ".repeat(20) : `line ${i + 1}`);
    con.onEvent(ev("run.started", null, { issue_ref: `acme/widget#19 ${"a very long title ".repeat(20)}`, model: "sonnet" }));
    con.onEvent(ev("stage.started", "intake")); con.onEvent(ev("stage.completed", "intake", { duration_s: 2, issue_acceptance: accept(5, text) })); con.onEvent(ev("stage.started", "implement"));
    con.onEvent(ev("proof.rerun", "implement", { round: 1, exit: 1, proved: 1, failed: 4, seconds: 4, statuses: statuses(5, 1, text) })); con.tick();
    // the emulator gives every character one cell, so wide characters are checked by counting: a frame line may take at most cols - 1 cells
    const wide = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0), over = con.frame().find((l) => wide(l) > 59);
    if (over) return `a frame line takes ${wide(over)} cells on a 60-column terminal: ${over}`;
    if ((bad = onePanel(t, con, "long lines"))) return bad;
    con.tick(); con.tick(); return onePanel(t, con, "long lines, redrawn twice");
  },
  // A frame taller than the window cannot be redrawn in place: it must be shortened to rows - 1 and say what it left out.
  "taller-than-the-window": () => {
    const { t, con, stdin } = setup(100, 14); let bad;
    start(con, 20); if ((bad = onePanel(t, con, "20 lines in 14 rows"))) return bad;
    if (con.frame().length > 13) return `the frame is ${con.frame().length} rows in a 14-row window, want at most 13`;
    if (!con.frame().some((l) => /\.\.\. and \d+ more lines?/.test(l))) return "the shortened acceptance list does not say how many lines it left out";
    if (!con.frame().some((l) => l.startsWith("d details"))) return "the shortened frame lost the line that names the keys";
    stdin.press("d"); con.tick(); if ((bad = onePanel(t, con, "20 lines and details in 14 rows"))) return bad;
    if (con.frame().length > 13) return `with details the frame is ${con.frame().length} rows in a 14-row window`;
    con.clear(); const end = t.lines(); // the last panel is left whole: every line, even past the window's height
    return end.filter((l) => /^\s+\[ \.\. \]/.test(l)).length === 20 ? null : "the final panel does not list all 20 lines";
  },
  // The window is made narrower (the terminal wraps the old frame's lines again), then shorter.
  "resize": () => {
    const { t, con, stdin } = setup(110, 40); let bad;
    start(con, 9); stdin.press("d"); if ((bad = onePanel(t, con, "110 columns"))) return bad;
    t.resize(52, 40); con.tick(); if ((bad = onePanel(t, con, "narrowed to 52 columns"))) return bad;
    t.resize(130, 40); con.tick(); if ((bad = onePanel(t, con, "widened to 130 columns"))) return bad;
    t.resize(130, 12); con.tick();
    const vis = t.lines(t.top), want = con.frame().map((l) => l.replace(/\s+$/, "")); while (want.length && want[want.length - 1] === "") want.pop();
    if (vis.filter((l) => l.startsWith("LOKI  ")).length !== 1 || vis.join("\n") !== want.join("\n")) return `shortened to 12 rows: the window does not hold exactly the frame\n${vis.map((l) => `      | ${l}`).join("\n")}`;
    con.tick(); const vis2 = t.lines(t.top); return vis2.join("\n") === want.join("\n") ? null : "shortened to 12 rows: the second redraw left a stale row in the window";
  },
  // The console built the way `loki start` builds it (write passed, std streams not opted out) while the process prints other lines.
  "other-output-during-a-run": async () => {
    const t = new Term(100, 40); t.write(`${PRE.join("\r\n")}\r\n`);
    const realWrite = process.stdout.write, cols = Object.getOwnPropertyDescriptor(process.stdout, "columns"), rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    process.stdout.write = (chunk) => { t.write(String(chunk).replace(/\n/g, "\r\n")); return true; }; // a terminal turns the process's \n into \r\n
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true }); Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
    let bad = null; const noise = ["npm warn deprecated inflight@1.0.6: this module is not supported", "npm warn deprecated glob@7.2.3: glob versions prior to v9 are no longer supported", "engine10: no event for 5 min; last stage implement"];
    try {
      const con = new LiveConsole({ write: (x) => { process.stdout.write(x); }, stdin: null, env: { NO_COLOR: "1" }, now: () => clock, spend: () => "$0.02 so far", repoDir: "/nonexistent-repo" });
      start(con, 8);
      for (const n of noise) process.stdout.write(`${n}\n`);
      await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
      con.tick(); bad = onePanel(t, con, "three lines printed during the run", [...PRE, ...noise]);
      if (!bad) { con.onEvent(ev("proof.rerun", "implement", { round: 1, exit: 1, proved: 7, failed: 2, seconds: 4, statuses: statuses(9, 7) })); bad = onePanel(t, con, "then the list grew", [...PRE, ...noise]); }
      con.clear();
    } finally { process.stdout.write = realWrite; if (cols) Object.defineProperty(process.stdout, "columns", cols); else delete process.stdout.columns; if (rows) Object.defineProperty(process.stdout, "rows", rows); else delete process.stdout.rows; }
    return bad;
  },
  // console.log and console.warn from the loki start process: under Bun they do not call process.stdout.write, so they need their own
  // route through the console. Each line once, above the panel; and console.log is given back when the console closes.
  "console-calls-during-a-run": async () => {
    const t = new Term(100, 40); t.write(`${PRE.join("\r\n")}\r\n`);
    const before = console.log, std = swapStd((chunk) => { t.write(String(chunk).replace(/\n/g, "\r\n")); return true; }, true);
    let bad = null; const lines = ["a console.log line with a number 42", "[budget] malformed budget state: a console.warn line"];
    try {
      const con = new LiveConsole({ write: (x) => { process.stdout.write(x); }, stdin: null, env: { NO_COLOR: "1" }, now: () => clock, spend: () => "$0.02 so far", repoDir: "/nonexistent-repo" });
      start(con, 5);
      console.log("a console.log line with a number %d", 42); console.warn(lines[1]);
      await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
      con.tick(); bad = onePanel(t, con, "console.log and console.warn during the run", [...PRE, ...lines]);
      con.clear();
      if (!bad && console.log !== before) bad = "console.log was not given back when the console closed";
    } finally { std.restore(); console.log = before; }
    return bad;
  },
  // The engine worker is a child process. While the console owns the terminal its stderr is piped and printed above the panel:
  // every line once, in order, the last one even with no newline and after a crash (exit 3), and the worker is told stderr is a terminal.
  "worker-stderr-above-the-panel": async () => {
    const t = new Term(100, 40); t.write(`${PRE.join("\r\n")}\r\n`);
    const std = swapStd((chunk) => { t.write(String(chunk).replace(/\n/g, "\r\n")); return true; }, true);
    let bad = null; const lines = ["Acceptance: the first line of the issue", "Acceptance: the second line of the issue", "worker sees tty=[1]", "Traceback: boom", "  at worker (no newline after this)"];
    try {
      const con = new LiveConsole({ write: (x) => { process.stdout.write(x); }, stdin: null, env: { NO_COLOR: "1" }, now: () => clock, spend: () => "$0.02 so far", repoDir: "/nonexistent-repo" });
      start(con, 8);
      const r = await spawnWorker(["sh", "-c", `printf '%s\\n' "${lines[0]}" "${lines[1]}" >&2; echo "worker sees tty=[$LOKI_E10_STDERR_TTY]" >&2; sleep 0.4; printf '%s\\n%s' "${lines[3]}" "${lines[4]}" >&2; exit 3`], { PATH: process.env.PATH }, process.cwd(), 20000, 1000, () => {});
      await new Promise((res) => setImmediate(res)); await new Promise((res) => setImmediate(res));
      con.tick();
      if (r.code !== 3) bad = `the worker's exit code came back as ${r.code}, want 3`;
      bad = bad ?? onePanel(t, con, "worker stderr during the run", [...PRE, ...lines]);
      con.clear();
    } finally { std.restore(); }
    return bad;
  },
  // Every other case leaves the worker's stderr as the process's own stderr (the bytes never pass through this process): no console at all
  // (--json, --verbose) even on a terminal, and a console whose stderr is not the terminal (a pipe, or 2>file). tests/min/one-line-goal.sh
  // runs this leg with stderr to a file and to a pipe and compares the bytes that arrived.
  "worker-stderr-inherited": async () => {
    let handled = 0; const std = swapStd(() => true, true, () => { handled++; return true; });
    let bad = null;
    try {
      const a = await spawnWorker(["sh", "-c", `echo "no console: tty=[$LOKI_E10_STDERR_TTY]" >&2; echo "no console: second line" >&2; exit 0`], { PATH: process.env.PATH }, process.cwd(), 20000, 1000, () => {});
      std.tty(false);
      const con = new LiveConsole({ write: (x) => { process.stdout.write(x); }, stdin: null, env: { NO_COLOR: "1" }, now: () => clock, repoDir: "/nonexistent-repo" });
      start(con, 3);
      const b = await spawnWorker(["sh", "-c", `echo "stderr is not the terminal: tty=[$LOKI_E10_STDERR_TTY]" >&2; printf 'Traceback: boom, no newline' >&2; exit 3`], { PATH: process.env.PATH }, process.cwd(), 20000, 1000, () => {});
      con.clear();
      if (a.code !== 0 || b.code !== 3) bad = `exit codes ${a.code} and ${b.code}, want 0 and 3`;
      else if (handled !== 0) bad = `the supervisor wrote to stderr ${handled} time(s): the worker's stderr was not left alone`;
    } finally { std.restore(); }
    return bad;
  },
  // The line that names the keys always shows `o dashboard`. On a narrower window the dashboard link goes first, then whole words of the
  // keys line: nothing wraps and no word is cut.
  "keys-line": () => {
    const full = "d details   o dashboard   q or Ctrl-C stop (loki start resumes it)", base = "http://127.0.0.1:5999";
    const link = controlRunLink(base, "/nonexistent-repo", "e10-test-run"); // 59 characters
    for (const [cols, want, where] of [[200, full, "under"], [100, full, "under"], [60, "d details   o dashboard   q or Ctrl-C stop", "under"], [50, "d details   o dashboard   q or Ctrl-C stop", "dropped"], [36, "d details   o dashboard   q stop", "dropped"], [21, "d  o  q", "dropped"]]) {
      const { t, con } = setup(cols, 40); start(con, 3); con.setUrl(base);
      const f = con.frame(), keys = f.find((l) => l.startsWith("d ")), last = f[f.length - 1];
      if (keys !== want) return `${cols} columns: the keys line is "${keys}"`;
      if (where === "under" ? last !== link : f.some((l) => l.includes("http://"))) return `${cols} columns: the link should be ${where}; the last line is "${last}"`;
      const wide = f.find((l) => l.length > cols - 1); if (wide) return `${cols} columns: a line is ${wide.length} wide: ${wide}`;
      const bad = onePanel(t, con, `${cols} columns`); if (bad) return bad;
    }
    const { t, con } = setup(100, 40); con.setUrl(base); con.onEvent({ type: "stage.started", stage: "intake", data: {} }); // no run id yet: the short home link fits beside the keys
    const f = con.frame(); if (f[f.length - 1] !== `${full}   ${base}`) return `a short link is not beside the keys: "${f[f.length - 1]}"`;
    return onePanel(t, con, "short link beside the keys");
  },
  // o with a dashboard running that holds this run: the browser is started once with this run's URL (argv, recorded here), the panel
  // says so, a second press while the first is in flight does nothing more, and the run goes on untouched.
  "o-opens-this-run": async () => {
    const base = "http://127.0.0.1:5999", d = dash({ base, known: "run" }), { t, con, stdin } = setup(120, 40, { dashboard: d.deps, onCancel: () => { d.calls.cancel++; } });
    start(con, 4); stdin.press("o"); stdin.press("o"); await settle();
    const url = controlRunLink(base, "/nonexistent-repo", "e10-test-run");
    if (d.opened.length !== 1 || d.opened[0].join(" ") !== `open ${url}`) return `the browser was started with ${JSON.stringify(d.opened)}, want one "open ${url}"`;
    if (d.calls.ensure !== 1) return `the dashboard was looked for ${d.calls.ensure} times for two presses in a row, want 1`;
    if (!con.frame().includes("opened this run in your browser")) return `the panel does not say what was opened:\n${con.frame().join("\n")}`;
    let bad = onePanel(t, con, "after o"); if (bad) return bad;
    con.onEvent(ev("proof.rerun", "implement", { round: 1, exit: 0, proved: 4, failed: 0, seconds: 2, statuses: statuses(4, 4) }));
    if (!con.frame().some((l) => l.includes("4 of 4 met"))) return "the run's next event did not reach the panel after o";
    if ((bad = onePanel(t, con, "the run goes on"))) return bad;
    return d.calls.cancel === 0 ? null : "o stopped the run";
  },
  // The dashboard does not hold this run yet: the repository's page when it knows the repository, else its home page, and the panel says which.
  "o-run-not-known-yet": async () => {
    const base = "http://127.0.0.1:5999", here = process.cwd(), name = here.split("/").pop();
    for (const [known, want, words] of [["repository", `${base}/#/repo/${encodeURIComponent(name)}`, "this repository's page (the dashboard does not have this run yet)"], ["nothing", `${base}/`, "the dashboard's home page (the dashboard does not have this run yet)"]]) {
      const d = dash({ base, known, repo: name }), { t, con, stdin } = setup(150, 40, { dashboard: d.deps, repoDir: here });
      start(con, 3); stdin.press("o"); await settle();
      if (d.opened.length !== 1 || d.opened[0][1] !== want) return `${known}: the browser was started with ${JSON.stringify(d.opened)}, want ${want}`;
      if (!con.frame().includes(`opened ${words} in your browser`)) return `${known}: the panel does not say which page:\n${con.frame().join("\n")}`;
      const bad = onePanel(t, con, known); if (bad) return bad;
    }
    return null;
  },
  // No browser should be started (LOKI_NO_BROWSER=1; no terminal on stdout): nothing is spawned and the whole link is on the panel,
  // on its own line when the keys line has no room for it, never cut.
  "o-without-a-browser-shows-the-link": async () => {
    const base = "http://127.0.0.1:5999", url = controlRunLink(base, "/nonexistent-repo", "e10-test-run");
    for (const [label, env, tty, cols] of [["LOKI_NO_BROWSER=1, wide", { NO_COLOR: "1", LOKI_NO_BROWSER: "1" }, true, 200], ["LOKI_NO_BROWSER=1, 90 columns", { NO_COLOR: "1", LOKI_NO_BROWSER: "1" }, true, 90], ["no terminal", { NO_COLOR: "1" }, false, 90], ["link longer than the window", { NO_COLOR: "1", LOKI_NO_BROWSER: "1" }, true, 48]]) {
      const d = dash({ base, known: "run", tty }), { t, con, stdin } = setup(cols, 40, { dashboard: d.deps, env });
      start(con, 3); stdin.press("o"); await settle();
      if (d.opened.length !== 0) return `${label}: a browser was started: ${JSON.stringify(d.opened)}`;
      const f = con.frame(), line = f.find((l) => l.includes(url));
      if (!line) return `${label}: the link is not on the panel:\n${f.join("\n")}`;
      if (line !== url) return `${label}: the link is not on a line of its own: "${line}"`;
      if (!f.some((l) => l.startsWith("d details   o dashboard"))) return `${label}: the keys line is gone`;
      const bad = onePanel(t, con, label); if (bad) return bad;
      con.tick(); con.tick(); const again = onePanel(t, con, `${label}, redrawn`); if (again) return again;
    }
    return null;
  },
  // The dashboard cannot be started: one plain line whose last words are the command to run, whatever the width, and the run goes on.
  // The last case uses the real starter with LOKI_CONTROL=0, which starts nothing.
  "o-cannot-start-says-so-in-one-line": async () => {
    const tail = "; run `loki control serve`";
    for (const [label, cols, deps, env, want] of [
      ["no answer, wide", 140, dash({ fail: new Error("it did not answer within 5 s (see ~/.loki/control/serve.log)") }).deps, { NO_COLOR: "1" }, "could not start the dashboard: it did not answer within 5 s (see ~/.loki/control/serve.log); run `loki control serve`"],
      ["no answer, 90 columns", 90, dash({ fail: new Error("it did not answer within 5 s (see ~/.loki/control/serve.log)") }).deps, { NO_COLOR: "1" }, "could not start the dashboard: it did not answer within 5 s; run `loki control serve`"],
      ["something that is not an Error", 120, dash({ fail: "boom" }).deps, { NO_COLOR: "1" }, "could not start the dashboard: it failed; run `loki control serve`"],
      ["LOKI_CONTROL=0, the real starter", 120, { open: () => { throw new Error("no browser in a test"); } }, { NO_COLOR: "1", LOKI_CONTROL: "0", HOME: process.env.HOME }, "could not start the dashboard: the Control Plane is off (LOKI_CONTROL=0); run `loki control serve`"],
      ["60 columns", 60, dash({ fail: new Error("it did not answer within 5 s (see ~/.loki/control/serve.log)") }).deps, { NO_COLOR: "1" }, null],
    ]) {
      const { t, con, stdin } = setup(cols, 40, { dashboard: deps, env });
      start(con, 3); stdin.press("o"); await settle(60);
      const f = con.frame(), line = f.find((l) => l.startsWith("could not start the dashboard"));
      if (!line || !line.endsWith(tail) || (want && line !== want) || line.length > cols - 1) return `${label}: the panel shows "${line ?? "(no such line)"}"`;
      if (f.filter((l) => l.includes("could not start")).length !== 1) return `${label}: more than one line`;
      let bad = onePanel(t, con, label); if (bad) return bad;
      con.onEvent(ev("stage.completed", "implement", { duration_s: 9 })); con.onEvent(ev("stage.started", "verify"));
      if (!con.frame().some((l) => l.includes("running the repository's tests"))) return `${label}: the run did not go on`;
      if ((bad = onePanel(t, con, `${label}, the run goes on`))) return bad;
    }
    return null;
  },
  // The final summary carries `Dashboard: <url>` when a dashboard is running, inside the 8-line cap of the default output (7 lines here:
  // the start line is printed separately), with the link always at the end of a line; with none running nothing changes.
  "summary-dashboard-line": async () => {
    const s = await import(new URL("../util/run_summary.ts", `file://${process.argv[2]}`).pathname);
    const U = "http://127.0.0.1:5999/#/runs/abcdef0123456789/e10-test-run", i = { result: "verified", filesChanged: 2, insertions: 5, deletions: 1, costUsd: 0.12, elapsedS: 61, receiptPath: "/r/receipt.json", next: "loki status" };
    const plain = s.formatRunSummary(i), full = s.formatRunSummary({ ...i, dashboardUrl: U }).split("\n");
    if (full.filter((l) => l === `Dashboard: ${U}`).length !== 1 || full.indexOf(`Dashboard: ${U}`) !== full.findIndex((l) => l.startsWith("next:")) - 1) return `the summary block: ${full.join(" | ")}`;
    if (s.formatRunSummary({ ...i, dashboardUrl: null }) !== plain || plain.includes("Dashboard")) return "the summary block changed with no dashboard running";
    if (s.summaryObject({ ...i, dashboardUrl: U }).dashboard !== U || "dashboard" in s.summaryObject(i)) return "the JSON summary: dashboard key wrong";
    for (const n of [3, 4, 5, 6, 7]) {
      const out = `${Array.from({ length: n }, (_, k) => `Line${k}:   value ${k}`).join("\n")}\n`, was = s.withNextLine(out, i), now = s.withNextLine(out, { ...i, dashboardUrl: U }), lines = now.replace(/\n$/, "").split("\n");
      if (lines.length > 7) return `${n} lines before: ${lines.length} lines with the dashboard link (cap 7)`;
      const own = n + 2 + 1 <= 7, at = lines.filter((l) => l.endsWith(U));
      if (at.length !== 1 || now.split(U).length !== 2) return `${n} lines before: the link is not at the end of exactly one line: ${lines.join(" | ")}`;
      if (own ? at[0] !== `Dashboard:  ${U}` : !at[0].endsWith(`; Dashboard: ${U}`)) return `${n} lines before: the link's line is "${at[0]}"`;
      if (!own && lines.length !== was.replace(/\n$/, "").split("\n").length) return `${n} lines before: the fold changed the line count`;
      if (lines[lines.length - 1] !== was.replace(/\n$/, "").split("\n").pop()) return `${n} lines before: the last line changed: "${lines[lines.length - 1]}"`;
    }
    // The whole default chain as supervisor.ts composes it (next line, the folded handoff pointer, the risk line, the proof line, with and
    // without the cap line printed above the block): the dashboard link never pushes the risk line out and never breaks the line cap.
    const chain = (out, ui, risk, card, cap) => s.withFoldLine(s.withRiskLine(s.withNextLine(out, ui).replace(/\n$/, "; review: .loki/review/HANDOFF.md\n"), risk, 7, cap), card, 7, cap);
    for (const n of [3, 4, 5, 6, 7]) for (const risk of [null, "Risk: low tier; 2 checks deferred (not run)"]) for (const card of [null, "Proof: yes"]) for (const cap of [0, 1]) {
      const out = `${Array.from({ length: n }, (_, k) => `Line${k}:   value ${k}`).join("\n")}\n`, tag = `${n} lines, risk ${risk ? "on" : "off"}, proof ${card ? "on" : "off"}, cap line ${cap}`;
      const was = chain(out, i, risk, card, cap).replace(/\n$/, "").split("\n"), now = chain(out, { ...i, dashboardUrl: U, reservedLines: cap + (risk ? 1 : 0) }, risk, card, cap).replace(/\n$/, "").split("\n");
      const has = (ls) => !!risk && ls.some((l) => l.startsWith(risk)); // the proof line may be folded onto it
      if (has(was) !== has(now)) return `${tag}: the risk line ${has(was) ? "was pushed out by" : "appeared with"} the dashboard link`;
      if (was.length + cap <= 7 && now.length + cap > 7) return `${tag}: ${now.length} lines with the link, ${was.length} without (cap 7 with the cap line)`;
      if (now.filter((l) => l.endsWith(U)).length !== 1 || now.join("\n").split(U).length !== 2) return `${tag}: the link is not at the end of exactly one line: ${now.join(" | ")}`;
      if (card && !now.join("\n").toLowerCase().includes("proof: yes")) return `${tag}: the proof line was lost`;
      if (!now.join("\n").includes("review: .loki/review/HANDOFF.md")) return `${tag}: the handoff pointer was lost`;
    }
    const known = async (u) => new Response("{}", { status: String(u).includes("/v1/runs/") ? 200 : 404 }), unknown = async () => new Response("{}", { status: 404 });
    const base = "http://127.0.0.1:5999", env = { HOME: process.env.HOME, LOKI_CONTROL_URL: base };
    if ((await s.dashboardLink("/nonexistent-repo", "e10-test-run", { ...env, LOKI_CONTROL: "0" }, { fetchImpl: known })) !== null) return "LOKI_CONTROL=0 still gives a link";
    if ((await s.dashboardLink("/nonexistent-repo", "e10-test-run", { HOME: process.env.HOME }, { fetchImpl: known })) !== null) return "a link with no dashboard running";
    const run = await s.dashboardLink("/nonexistent-repo", "e10-test-run", env, { fetchImpl: known }); if (run !== controlRunLink(base, "/nonexistent-repo", "e10-test-run")) return `a run the dashboard holds: ${run}`;
    const home = await s.dashboardLink("/nonexistent-repo", "e10-test-run", env, { fetchImpl: unknown }); return home === `${base}/` ? null : `a run the dashboard does not hold: ${home}`;
  },
};
const { controlRunLink } = await import(new URL("../util/run_outputs.ts", `file://${process.argv[2]}`).pathname);
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };
/** Stand-ins for the o key: a dashboard at `base` that knows the run, only the repository, or nothing; the real page choice
 *  (dashboardTarget) and the real browser rules (openBrowser, as macOS with `open` on PATH) run against them; what would be spawned is recorded. */
function dash({ base = "http://127.0.0.1:5999", known = "run", repo = "", tty = true, fail = null } = {}) {
  const calls = { ensure: 0, cancel: 0 }, opened = [];
  const fetchImpl = async (u) => { const p = new URL(String(u)).pathname; if (p.startsWith("/v1/runs/")) return new Response("{}", { status: known === "run" ? 200 : 404 }); if (p === "/v1/repos") return Response.json({ repos: known === "repository" ? [repo] : [] }); return new Response("", { status: 404 }); };
  const deps = {
    ensure: async () => { calls.ensure++; await new Promise((r) => setTimeout(r, 10)); if (fail) throw fail; return { url: base, started: false }; },
    target: async (b, r, id, o) => (await import(new URL("../util/run_summary.ts", `file://${process.argv[2]}`).pathname)).dashboardTarget(b, r, id, { ...o, fetchImpl }),
    open: async (u, e) => (await import(new URL("../commands/control.ts", `file://${process.argv[2]}`).pathname)).openBrowser(u, e, { platform: "darwin", tty, which: () => "/usr/bin/open", spawnImpl: (argv) => opened.push(argv) }),
  };
  return { deps, calls, opened };
}
/** Stands in for the terminal: process.stdout.write (and process.stderr.write) go to `sink`, with a size and, for stderr, a chosen isTTY. */
function swapStd(sink, errTty, errSink = sink) {
  const keep = { out: process.stdout.write, err: process.stderr.write, cols: Object.getOwnPropertyDescriptor(process.stdout, "columns"), rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"), tty: Object.getOwnPropertyDescriptor(process.stderr, "isTTY") };
  process.stdout.write = sink; process.stderr.write = errSink;
  const def = (o, k, v) => Object.defineProperty(o, k, { value: v, configurable: true, writable: true });
  def(process.stdout, "columns", 100); def(process.stdout, "rows", 40); def(process.stderr, "isTTY", errTty);
  const back = (o, k, d) => { if (d) Object.defineProperty(o, k, d); else delete o[k]; };
  return { tty: (v) => def(process.stderr, "isTTY", v), restore: () => { process.stdout.write = keep.out; process.stderr.write = keep.err; back(process.stdout, "columns", keep.cols); back(process.stdout, "rows", keep.rows); back(process.stderr, "isTTY", keep.tty); } };
}
const out = [];
for (const [name, fn] of Object.entries(legs)) {
  if (only.length && !only.includes(name)) continue;
  let bad; try { bad = await fn(); } catch (e) { bad = `threw: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e}`; }
  out.push(bad ? `FAIL ${name}: ${bad}` : `PASS ${name}`);
}
process.stdout.write(`${out.join("\n")}\n`);
