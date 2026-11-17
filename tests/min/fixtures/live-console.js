// Driver for the live console legs of tests/min/one-line-goal.sh (the console that `loki start` shows on a terminal:
// loki-ts/src/e10ext/console.ts). It draws the console into a small terminal emulator (a grid of rows by columns that
// applies cursor-up, erase and newline the way a terminal does, with scrollback and reflow on resize) and checks, after
// every step, that the terminal holds exactly one panel and nothing of an older one.
// (New file: no existing fixture holds a terminal emulator, and a bash heredoc of this size would not be readable.)
// Usage: bun live-console.js <path to console.ts> [leg ...]   prints "PASS <leg>" or "FAIL <leg>: <why>" per leg.
const { LiveConsole } = await import(process.argv[2]);
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
  const want = [...before, ...con.frame()].map((l) => l.replace(/\s+$/, "")); while (want.length && want[want.length - 1] === "") want.pop();
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
};
const out = [];
for (const [name, fn] of Object.entries(legs)) {
  if (only.length && !only.includes(name)) continue;
  let bad; try { bad = await fn(); } catch (e) { bad = `threw: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e}`; }
  out.push(bad ? `FAIL ${name}: ${bad}` : `PASS ${name}`);
}
process.stdout.write(`${out.join("\n")}\n`);
