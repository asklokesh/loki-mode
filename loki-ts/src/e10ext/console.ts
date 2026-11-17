// The live console: what `loki start` shows on a terminal while a run works. One panel, redrawn in place: the task, each stage, each acceptance line of
// the issue turning from waiting to met as Loki's own proof run counts a passing check for it, what the session is doing now, the spend and the keys.
// Presentation only: it reads the run's events (the same tail LiveLine reads) and never changes a stage, a verdict or a model call. It replaces LiveLine
// on a TTY (LOKI_CONSOLE=0 keeps the one-line status); pipes and CI keep LiveLine's plain lines. ASCII only, colors off under NO_COLOR.
// (New file: liveline.ts owns the one-line status and the candidate diff; a multi-line panel with keys is a different surface.)
import { formatDuration, spendSoFar } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";
import { terminalWidth } from "../util/term_width.ts";
import { redactSecrets, UNSAFE_TERMINAL_CHARS_RE } from "../util/redact.ts";
import { controlRunLink } from "../util/run_outputs.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

type Ev = { type: string; stage: string | null; data: Record<string, unknown>; run?: string; ts?: string };
type StageState = "waiting" | "running" | "done" | "failed" | "skipped";
type LineState = "waiting" | "met" | "unmet";
const STAGES: readonly [string, string][] = [["intake", "read"], ["plan", "plan"], ["implement", "build"], ["verify", "verify"], ["fix", "fix"], ["commit", "commit"], ["seal", "label"], ["pr", "pull request"]];
const NOW: Record<string, string> = { intake: "reading the task", plan: "planning the change", implement: "the session is building and running the product", verify: "running the repository's tests", fix: "fixing what the tests found", commit: "committing", seal: "checking every line and writing the receipt", pr: "opening the pull request" };

export const consoleOn = (env: NodeJS.ProcessEnv = process.env, tty = !!process.stdout.isTTY): boolean => tty && !/^(0|off|false|no)$/i.test((env["LOKI_CONSOLE"] ?? "").trim()) && env["TERM"] !== "dumb";
export interface ConsoleOpts { write?: (s: string) => void; /** false: do not wrap process.stdout and process.stderr (tests, and the headless rows of ManyStatus) */ hookStd?: boolean; now?: () => number; columns?: number; /** the terminal's height; a live panel is kept one row shorter so it can always be redrawn in place */ rows?: number; /** the terminal's size, asked again on every draw (tests resize it) */ size?: () => { columns?: number; rows?: number }; repoDir?: string; env?: NodeJS.ProcessEnv; spend?: (events: EventEnvelope[]) => string; stdin?: NodeJS.ReadStream | null; onCancel?: () => void; /** what the o key uses to find or start the dashboard, pick the page and open the browser; the real ones (commands/control.ts, util/run_summary.ts) are loaded on the first press, tests pass stand-ins so no server starts and no browser opens */ dashboard?: DashboardDeps }
export interface DashboardDeps {
  ensure?: (env: NodeJS.ProcessEnv, o: { cwd: string; unref: boolean }) => Promise<{ url: string; started: boolean }>;
  target?: (base: string, repoDir: string, runId: string | null, o: { waitMs: number }) => Promise<{ url: string; what: "run" | "repository" | "home" }>;
  /** true when a browser was started; false when none should be (no display, SSH, CI, LOKI_NO_BROWSER=1): the link is shown instead */
  open?: (url: string, env: NodeJS.ProcessEnv) => boolean | Promise<boolean>;
}
/** The line that names the keys, shortened by whole words for a narrow window (never cut inside a word). */
const KEYS = ["d details   o dashboard   q or Ctrl-C stop (loki start resumes it)", "d details   o dashboard   q or Ctrl-C stop", "d details   o dashboard   q stop", "d  o  q"] as const;

/** The terminal cells a string takes: color codes take none, East Asian wide characters, symbols and emoji are counted as two (a count that is too
 *  high only shortens a line; one that is too low would let it wrap and break the redraw). */
const cellOf = (cp: number): number => ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d ? 0
  : (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1);
export const cells = (s: string): number => { let n = 0; for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) n += cellOf(ch.codePointAt(0) ?? 0); return n; };
/** The line cut to at most w cells, its color codes kept (and closed when the line had any). */
export function fit(line: string, w: number): string {
  if (cells(line) <= w) return line;
  let out = "", n = 0, i = 0, colored = false;
  while (i < line.length) {
    const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i, i + 16)); if (m) { out += m[0]; i += m[0].length; colored = true; continue; }
    const cp = line.codePointAt(i) ?? 0, ch = String.fromCodePoint(cp), c = cellOf(cp);
    if (n + c > w) break;
    out += ch; n += c; i += ch.length;
  }
  return colored ? `${out}\x1b[0m` : out;
}

export class LiveConsole {
  private readonly t0: number; private prev: number[] = []; private closed = false; private details = false; private rawOn = false;
  private title = "Loki"; private model = ""; private url: string | null = null; private spent: string | null = null;
  private runId: string | null = null; private dashBusy = false; private dashNote = ""; private dashFail: string | null = null; private dashLink: string | null = null; private dashLinkNeeded = false;
  private readonly stage = new Map<string, { state: StageState; at: number; s?: number }>();
  private lines: { text: string; state: LineState; checks: number; why?: string }[] = []; private lineSource = "the issue's own lines";
  private readonly seen: EventEnvelope[] = []; private readonly recent: string[] = [];
  private diff = ""; private proof = ""; private tests = { pass: 0, fail: 0 }; private outcome = ""; private pr = "";
  private out: (s: string) => void; private unhook: (() => void)[] = []; private midLine = false;
  constructor(private o: ConsoleOpts) { this.t0 = (o.now ?? Date.now)(); this.out = o.write ?? ((x) => { process.stdout.write(x); }); if (o.hookStd !== false) this.hook(); this.keys(); }
  /** Anything else this process prints (a notice, a warning) is written above the panel: the panel is wiped first and drawn again after, so a stray
   *  line never lands inside it and never moves the cursor the next redraw counts from. Both streams are given back in clear(). This runs whenever the
   *  console owns the terminal, also when the caller passed `write` (the caller's `write` goes to process.stdout, so the panel is written through the
   *  unwrapped stream). Before, a caller that passed `write` got no wrapping at all, and `loki start` passes it: every line printed during a run moved
   *  the cursor down, the next redraw started that many rows too low, and the top of the old panel stayed on screen above the new one. */
  private hook(): void {
    const raw = process.stdout.write.bind(process.stdout); this.out = (x) => { raw(x); };
    // A child that wrote straight to the terminal would get past this wrapper, so while it is installed the engine worker's stderr is piped and passed
    // through process.stderr.write here (runner/worker_proc.ts reads this mark).
    const mark = Symbol.for("loki.consoleOwnsTerminal"), g = globalThis as Record<symbol, unknown>; g[mark] = true; this.unhook.push(() => { g[mark] = false; });
    const onResize = (): void => { if (!this.closed) this.render(); }; process.stdout.on("resize", onResize); this.unhook.push(() => { process.stdout.off("resize", onResize); });
    // Bun's console.log and console.warn write to the terminal without calling process.stdout.write or process.stderr.write, so they would get past the
    // wrapper below too (measured: a wrapped write saw 0 calls for a console.log). While the console is up they go through the streams.
    const con = console as unknown as Record<string, (...a: unknown[]) => void>;
    for (const [name, to] of [["log", "stdout"], ["info", "stdout"], ["debug", "stdout"], ["warn", "stderr"], ["error", "stderr"]] as const) {
      const was = con[name]; if (typeof was !== "function") continue;
      con[name] = (...a: unknown[]): void => { process[to].write(`${format(...a)}\n`); }; this.unhook.push(() => { con[name] = was; });
    }
    for (const st of [process.stdout, ...(process.stderr.isTTY ? [process.stderr] : [])] as NodeJS.WriteStream[]) {
      const orig = st.write.bind(st) as (...a: unknown[]) => boolean;
      this.unhook.push(() => { st.write = orig as typeof st.write; });
      st.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
        if (this.closed) return orig(chunk, ...rest);
        const up = this.rowsDrawn(); if (up > 0) { raw(`\x1b[${up}A\r\x1b[J`); this.prev = []; }
        const r = orig(chunk, ...rest), text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
        if (text) this.midLine = !text.endsWith("\n");
        if (!this.redrawQueued) { this.redrawQueued = true; setImmediate(() => { this.redrawQueued = false; if (!this.closed) this.render(); }); }
        return r;
      }) as typeof st.write;
    }
  }
  private redrawQueued = false;
  private now(): number { return (this.o.now ?? Date.now)(); }
  private get color(): boolean { return !(this.o.env ?? process.env)["NO_COLOR"]; }
  private c(code: string, s: string): string { return this.color ? `\x1b[${code}m${s}\x1b[0m` : s; }
  private safe(s: string, w: number): string { const t = redactSecrets(String(s).replace(/[\t\r\n]+/g, " ").replace(UNSAFE_TERMINAL_CHARS_RE, " ")); return cells(t) > w ? `${fit(t, Math.max(0, w - 3))}...` : t; }
  /** The terminal's size now (asked on every draw, so a resize is seen). A terminal that reports no size is taken as 80 by 24. */
  private size(): { cols: number; rows: number } {
    const s = this.o.size?.() ?? {}, c = s.columns ?? this.o.columns ?? process.stdout.columns, r = s.rows ?? this.o.rows ?? process.stdout.rows;
    return { cols: typeof c === "number" && c >= 2 && c < 40 ? Math.floor(c) : terminalWidth({ columns: c }, (this.o.env ?? process.env) as Record<string, string | undefined>), rows: typeof r === "number" && r >= 2 ? Math.floor(r) : 24 };
  }
  /** The rows the last drawn frame takes on the terminal as it is now: a line wider than the terminal (the window was made narrower since) takes more than one. */
  private rowsDrawn(): number { const { cols } = this.size(); return this.prev.reduce((n, c) => n + Math.max(1, Math.ceil(c / cols)), 0); }
  private note(s: string): void { this.recent.push(s); if (this.recent.length > 40) this.recent.shift(); }
  setUrl(u: string): void { if (u) { this.url = u; this.render(); } }

  /** Keys, only on a real terminal: d shows or hides details, q or Ctrl-C stops the run the same way an interrupt does. The terminal mode is always put back. */
  private keys(): void {
    const stdin = this.o.stdin === undefined ? process.stdin : this.o.stdin;
    if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== "function") return;
    try {
      stdin.setRawMode(true); stdin.resume(); this.rawOn = true;
      const restore = (): void => { if (this.rawOn) { try { stdin.setRawMode(false); stdin.pause(); } catch { /* the terminal is already gone */ } this.rawOn = false; } };
      process.once("exit", restore); this.restore = restore;
      stdin.on("data", (b: Buffer) => {
        const k = b.toString("utf8");
        if (k === "d" || k === "D") { this.details = !this.details; this.render(); }
        else if (k === "o" || k === "O") void this.openDashboard().catch(() => { /* openDashboard reports its own failures */ });
        else if (k === "\x03" || k === "q" || k === "Q") { restore(); (this.o.onCancel ?? (() => { process.kill(process.pid, "SIGINT"); }))(); }
      });
    } catch { this.rawOn = false; }
  }
  private restore: () => void = () => {};

  /** The o key: this run's page in the dashboard (the Control Plane), in the browser. A running dashboard is used; none running, one is started the
   *  way `loki control serve` starts it (in this repository, so it reads this run in) and waited on for about 5 seconds. The page is the run's own
   *  when the dashboard holds the run, else the repository's or the home page, and the note says which. Where no browser should be opened (SSH, CI, no
   *  display, LOKI_NO_BROWSER=1) the link is shown under the keys instead. Best effort and off the run's path: one press at a time, every step has
   *  a timeout, and any failure becomes one line in the panel; nothing here can throw into the run or keep the process alive after it. */
  private async openDashboard(): Promise<void> {
    if (this.dashBusy || this.closed) return;
    this.dashBusy = true;
    const env = this.o.env ?? process.env, d = this.o.dashboard ?? {}, repoDir = this.o.repoDir ?? process.cwd();
    try {
      this.dashFail = null; this.dashNote = "opening the dashboard..."; this.render();
      const cp = await (d.ensure ?? (async (e, o) => (await import("../commands/control.ts")).ensureControlPlane(e, o)))(env, { cwd: repoDir, unref: true });
      const t = await (d.target ?? (async (b, r, id, o) => (await import("../util/run_summary.ts")).dashboardTarget(b, r, id, o)))(cp.url, repoDir, this.runId, { waitMs: cp.started ? 3000 : 0 });
      const opened = await (d.open ?? (async (u, e) => (await import("../commands/control.ts")).openBrowser(u, e)))(t.url, env);
      const where = t.what === "run" ? "this run" : `${t.what === "repository" ? "this repository's page" : "the dashboard's home page"} (the dashboard does not have this run yet)`;
      this.dashLink = t.url; this.dashLinkNeeded = !opened;
      this.dashNote = opened ? `opened ${where} in your browser` : `dashboard, ${where}: open the link below`;
    } catch (e) {
      const why = (e instanceof Error && e.message ? e.message : "it failed").split("\n")[0]!;
      this.dashNote = ""; this.dashFail = why;
    } finally { this.dashBusy = false; if (!this.closed) this.render(); }
  }

  onEvent(e: Ev): void {
    if (this.closed) return;
    const d = e.data ?? {};
    if (e.type === "run.started" || e.type === "run.resumed") { const ref = d["issue_ref"] ?? d["task_title"]; if (typeof ref === "string" && ref) this.title = ref; if (typeof d["model"] === "string") this.model = String(d["model"]); }
    const cp = d["control_plane_url"]; if (typeof cp === "string" && cp) this.url = cp;
    if (typeof e.run === "string" && e.run) this.runId = e.run;
    this.seen.push(e as EventEnvelope);
    if (e.type === "cost") { try { this.spent = (this.o.spend ?? ((ev) => spendSoFar(ev, this.o.repoDir ? `${this.o.repoDir}/.loki` : undefined)))(this.seen).replace(/^\((.*)\)$/, "$1"); } catch { /* spend stays as it was */ } }
    if (e.stage && e.type === "stage.started") { this.stage.set(e.stage, { state: "running", at: this.now() }); this.note(`${e.stage} started`); }
    else if (e.stage && /^stage\.(completed|failed|skipped)$/.test(e.type)) {
      const st: StageState = e.type === "stage.completed" ? "done" : e.type === "stage.failed" ? "failed" : "skipped", prev = this.stage.get(e.stage);
      this.stage.set(e.stage, { state: st, at: prev?.at ?? this.now(), s: typeof d["duration_s"] === "number" ? (d["duration_s"] as number) : prev ? (this.now() - prev.at) / 1000 : undefined });
      this.note(`${e.stage} ${st}${typeof d["reason"] === "string" ? `: ${d["reason"]}` : ""}`);
      if (e.stage === "intake" && Array.isArray(d["issue_acceptance"]) && (d["issue_acceptance"] as unknown[]).length) this.lines = (d["issue_acceptance"] as unknown[]).map((t) => ({ text: String(t), state: "waiting" as LineState, checks: 0 }));
      if (e.stage === "seal" && Array.isArray(d["issue_acceptance"])) this.setLines(d["issue_acceptance"] as Record<string, unknown>[], d["issue_acceptance_source"]);
      if (e.stage === "seal" && typeof d["verdict"] === "string") this.outcome = String(d["verdict"]);
    }
    if (e.type === "heartbeat" && d["diff"] && typeof d["diff"] === "object") { const x = d["diff"] as Record<string, unknown>; this.diff = `${Number(x["files"] ?? 0)} files changed, +${Number(x["insertions"] ?? 0)} -${Number(x["deletions"] ?? 0)}`; }
    if (e.type === "test.result") { if (d["result"] === "pass") this.tests.pass++; else if (d["result"] === "fail") this.tests.fail++; }
    if (e.type === "proof.rerun") { this.proof = `Loki ran the proof itself, round ${Number(d["round"] ?? 1)}: ${d["exit"] === 0 ? "passed" : "did not pass"}, ${Number(d["proved"] ?? 0)} passing and ${Number(d["failed"] ?? 0)} failing checks in ${Number(d["seconds"] ?? 0)}s`; this.note(this.proof); if (Array.isArray(d["statuses"])) this.setLines(d["statuses"] as Record<string, unknown>[], d["source"]); }
    if (e.type === "pr.opened" && typeof d["url"] === "string") this.pr = String(d["url"]);
    if (e.type === "run.completed") { if (!this.outcome && typeof d["verdict"] === "string") this.outcome = String(d["verdict"]); if (!this.pr && typeof d["pr_url"] === "string") this.pr = String(d["pr_url"]); }
    if (e.type === "proof.base" && !d["cached"]) this.note(d["available"] ? `proof run against the base commit too: ${Number(d["also_pass_on_base"] ?? 0)} of ${Number(d["passing"] ?? 0)} passing checks also pass without the change` : `proof not compared with the base commit: ${String(d["why"] ?? "not available").slice(0, 160)}`);
    if (e.type === "acceptance.round") this.note(`acceptance check, round ${Number(d["round"] ?? 1)}: ${Number(d["met"] ?? 0)} met, ${Number(d["unmet"] ?? 0)} handed back to the session`);
    this.render();
  }
  /** This run as one row of the many-issue status (ManyStatus below): the stage it is in, the acceptance lines met, the spend, the verdict and the pull request. */
  row(): ManyRow {
    const cur = [...this.stage.entries()].reverse().find(([, v]) => v.state === "running")?.[0] ?? [...this.stage.keys()].pop() ?? "";
    return { stage: STAGES.find(([k]) => k === cur)?.[1] ?? (cur || "starting"), met: this.lines.filter((l) => l.state === "met").length, lines: this.lines.length, spent: (this.spent ?? "").replace(/ so far$/, ""), verdict: this.outcome, pr: this.pr };
  }
  private setLines(rows: Record<string, unknown>[], source: unknown): void {
    if (!rows.length) return;
    this.lines = rows.map((r, i) => ({ text: String(r["line"] ?? this.lines[i]?.text ?? `line ${i + 1}`), state: (r["status"] === "met" ? "met" : r["status"] === "unmet" ? "unmet" : "waiting") as LineState, checks: Number(r["checks"] ?? 0), ...(typeof r["reason"] === "string" ? { why: r["reason"] as string } : {}) }));
    if (source === "plan") this.lineSource = "written by Loki from the issue";
  }

  /** The panel as plain lines (no cursor movement), newest state. Exported through frame() for tests. */
  frame(final = false): string[] {
    const { cols, rows } = this.size(), w = Math.min(120, Math.max(20, cols - 1)), out: string[] = [];
    const right = [this.model, formatDuration((this.now() - this.t0) / 1000), this.spent ?? ""].filter(Boolean).join("   ");
    const left = this.safe(`LOKI  ${this.title}`, Math.max(10, w - right.length - 2));
    out.push(`${this.c("1", left)}${" ".repeat(Math.max(1, w - cells(left) - right.length))}${this.c("2", right)}`);
    out.push(this.c("2", "-".repeat(w)));
    const tag = (s: StageState): string => s === "done" ? this.c("32", "done") : s === "running" ? this.c("33", "now ") : s === "failed" ? this.c("31", "FAIL") : s === "skipped" ? this.c("2", "skip") : this.c("2", "    ");
    const stageCells = STAGES.filter(([k]) => k !== "fix" || this.stage.has("fix")).map(([k, label]) => { const st = this.stage.get(k); const s = st?.state ?? "waiting"; const t = s === "running" && st ? ` ${formatDuration((this.now() - st.at) / 1000)}` : s === "done" && st?.s !== undefined ? ` ${formatDuration(st.s)}` : ""; return { plain: `[${s === "done" ? "done" : s === "running" ? "now " : s === "failed" ? "FAIL" : s === "skipped" ? "skip" : "    "}] ${label}${t}`, shown: `[${tag(s)}] ${label}${this.c("2", t)}` }; });
    let row = "", rowPlain = "";
    for (const c of stageCells) { if (rowPlain.length + c.plain.length + 3 > w && rowPlain) { out.push(row); row = ""; rowPlain = ""; } row += (rowPlain ? "   " : "") + c.shown; rowPlain += (rowPlain ? "   " : "") + c.plain; }
    if (rowPlain) out.push(row);
    out.push("");
    const items: string[][] = []; // one acceptance line each, with its reason under it when that is shown
    this.lines.forEach((l, i) => {
      const mark = l.state === "met" ? this.c("32", "[ ok ]") : l.state === "unmet" ? this.c("31", "[ no ]") : this.c("2", "[ .. ]");
      const tail = l.state === "met" && l.checks ? `  ${l.checks} check${l.checks === 1 ? "" : "s"}` : "";
      items.push([`  ${mark} ${String(i + 1).padStart(2)}  ${this.safe(l.text, w - 16 - tail.length)}${this.c("2", tail)}`, ...(l.state === "unmet" && l.why && (final || this.details) ? [this.c("2", `             ${this.safe(l.why, w - 14)}`)] : [])]);
    });
    const met = this.lines.filter((l) => l.state === "met").length, recent = this.details && !final ? this.recent.slice(-8).map((x) => this.c("2", `  ${this.safe(x, w - 2)}`)) : [];
    const cur = [...this.stage.entries()].reverse().find(([, v]) => v.state === "running")?.[0], low: string[] = [];
    if (!final && cur) low.push(`${this.c("1", "Now:")} ${this.safe(`${NOW[cur] ?? cur}${cur === "implement" && this.diff ? ` (${this.diff})` : ""}${cur === "verify" && this.tests.pass + this.tests.fail ? ` (${this.tests.pass} passed, ${this.tests.fail} failed so far)` : ""}`, w - 6)}`);
    if (!final && this.dashFail !== null) { // one line; the reason gives way (first its "(see ...)" part, then its tail, then all of it) so the command to run is never cut
      const head = "could not start the dashboard", tail = "; run `loki control serve`", room = w - head.length - 2 - tail.length, why = this.dashFail.length > room ? this.dashFail.replace(/ \(see [^)]*\)$/, "") : this.dashFail;
      low.push(room >= 12 ? `${head}: ${this.safe(why, room)}${tail}` : head.length + tail.length <= w ? `${head}${tail}` : "run `loki control serve`");
    }
    else if (!final && this.dashNote) low.push(this.safe(this.dashNote, w));
    if (this.proof) low.push(this.safe(this.proof, w));
    // The keys, then the dashboard link when one is known: on the same line while both fit, else on a line of its own under the keys while it fits
    // the width. On a narrower window the link goes first (the o key still opens it), then the keys line loses whole words. Only a link the person
    // has to open by hand (no browser could be started) is kept whatever the width, on its own line and never cut: a cut link is no link.
    const keys = KEYS.find((x) => x.length <= w) ?? KEYS[KEYS.length - 1]!;
    const link = final ? null : this.dashLink ?? (this.url && this.runId ? controlRunLink(this.url, this.o.repoDir ?? process.cwd(), this.runId) : null) ?? this.url;
    const sameLine = !!link && /^[\x21-\x7e]+$/.test(link) && keys.length + 3 + link.length <= w, ownLine = !!link && !sameLine && (this.dashLinkNeeded || link.length <= w) && /^[\x21-\x7e]+$/.test(link) ? link : null;
    const hint = final ? [] : [this.c("2", sameLine ? `${keys}   ${link}` : keys), ...(ownLine ? [ownLine] : [])];
    // The panel is redrawn in place by moving the cursor up over it, and the cursor cannot go above the top row of the window: a panel taller than the
    // window could never be wiped (its top would stay behind at every redraw). So a live frame is kept to the window's height minus one row: the
    // details list gives up its oldest entries first, then the acceptance list its last lines, each with a line that says how many are not shown.
    const build = (k: number, r: number): string[] => [...out,
      ...(items.length ? [`${this.c("1", "Acceptance")} ${this.c("2", `(${this.lineSource})`)}   ${met} of ${this.lines.length} met`, ...items.slice(0, k).flat(), ...(k < items.length ? [this.c("2", `  ... and ${items.length - k} more line${items.length - k === 1 ? "" : "s"} (a taller window shows ${items.length - k === 1 ? "it" : "them"})`)] : []), ""] : []),
      ...low,
      ...(this.details && !final ? [this.c("2", "Recent:"), ...(r < recent.length ? [this.c("2", `  ... and ${recent.length - r} earlier`)] : []), ...recent.slice(recent.length - r)] : []),
      ...hint];
    let k = items.length, r = recent.length, f = build(k, r);
    if (!final) {
      const room = Math.max(1, rows - 1 - (ownLine ? Math.ceil(ownLine.length / cols) - 1 : 0)); // a link longer than the window takes more than one row
      while (f.length > room && r > 0) f = build(k, --r);
      while (f.length > room && k > 0) f = build(--k, r);
      if (f.length > room) f = [...f.slice(0, Math.max(0, room - hint.length)), ...f.slice(-Math.min(hint.length, room))]; // a window of a few rows: the top of the panel and the keys
    }
    return f.map((l) => (l === ownLine ? l : fit(l, w)));
  }
  tick(): void { if (!this.closed) this.render(); }
  /** One redraw: up over every row the LAST frame takes on the terminal as it is now (not the new frame's height, and a line the window has since
   *  become too narrow for counts as the rows it wraps to), each line of the new frame over a wiped row, then everything below wiped, so a shorter
   *  frame leaves nothing of a longer one. Every line of a frame fits the width and a live frame fits the height (frame()), so the count is exact. */
  private render(final = false): void {
    if (this.closed) return;
    const f = this.frame(final), up = this.rowsDrawn();
    let s = `\x1b[?25l${up === 0 && this.midLine ? "\n" : ""}${up > 0 ? `\x1b[${up}A` : ""}`; this.midLine = false;
    for (const l of f) s += `\r\x1b[2K${l}\n`;
    this.out(`${s}\r\x1b[J`); this.prev = f.map(cells);
  }
  /** Leaves the final panel on screen (every line with its result) above the summary, shows the cursor again and gives the terminal back. Idempotent. */
  clear(): void { if (this.closed) return; this.render(true); this.closed = true; this.out("\x1b[?25h"); for (const u of this.unhook) u(); this.unhook = []; this.restore(); }
}

/** Many issues at once (`loki start owner/repo#1 owner/repo#2`): one line per issue, built from each run's own events file in its own worktree, so the
 *  runs share nothing with this view. A terminal gets the lines redrawn in place; a pipe gets a plain line each time an issue's stage, met count,
 *  label or pull request changes. Each issue's row is a headless LiveConsole (the one fold of the events, not a second one). Presentation only. */
export interface ManyRow { stage: string; met: number; lines: number; spent: string; verdict: string; pr: string }
/** The label a person acts on: green only for a VERIFIED run. "" while the run has no verdict. */
export const lokiLabelOf = (verdict: string): string => (verdict === "" ? "" : /^VERIFIED\b/.test(verdict) ? "safe to merge" : "needs you");
export function manyLine(n: number, r: ManyRow, elapsedS: number, title = ""): string {
  const acc = r.lines ? `${r.met} of ${r.lines} lines met` : "lines not read yet";
  return [`#${n}`.padEnd(6), (lokiLabelOf(r.verdict) || r.stage).padEnd(13), acc.padEnd(20), (r.spent || "-").padEnd(14), formatDuration(elapsedS).padEnd(7), r.pr || title].join(" ").trimEnd();
}
export class ManyStatus {
  private readonly rows = new Map<number, { title: string; dir: string; t0: number; con: LiveConsole; file: string | null; offset: number; rest: string; last: string; final: string | null }>();
  private drawn = 0; private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private o: { write: (s: string) => void; tty: boolean; now?: () => number; columns?: number; intervalMs?: number; env?: NodeJS.ProcessEnv }) {}
  private now(): number { return (this.o.now ?? Date.now)(); }
  private headless(dir: string): LiveConsole { return new LiveConsole({ write: () => {}, hookStd: false, stdin: null, repoDir: dir, columns: 200, env: { ...(this.o.env ?? process.env), NO_COLOR: "1" }, now: this.o.now }); }
  /** An issue's run started in `dir` (its worktree); its events are read from <dir>/.loki/runs/<newest id>/events.jsonl. */
  start(n: number, title: string, dir: string): void {
    this.rows.set(n, { title, dir, t0: this.now(), con: this.headless(dir), file: null, offset: 0, rest: "", last: "", final: null });
    if (!this.timer && this.o.intervalMs !== 0) { this.timer = setInterval(() => this.tick(), this.o.intervalMs ?? 1000); this.timer.unref?.(); }
    this.tick();
  }
  /** The issue's run ended: `line` is its summary line, kept in place of the live row. */
  done(n: number, line: string): void { const r = this.rows.get(n); this.poll(); if (r) r.final = line.trimEnd(); if (this.o.tty) this.draw(); else this.o.write(`${line.trimEnd()}\n`); }
  /** Any other line (a notice, a retry) goes above the rows on a terminal. */
  print(s: string): void { if (this.stopped) { this.o.write(s); return; } if (this.o.tty && this.drawn > 0) { this.o.write(`\x1b[${this.drawn}A\r\x1b[J`); this.drawn = 0; } this.o.write(s); if (this.o.tty) this.draw(); }
  private stopped = false;
  private poll(): void {
    for (const r of this.rows.values()) {
      if (r.final !== null) continue;
      try {
        const runs = join(r.dir, ".loki", "runs"), id = readdirSync(runs).filter((x) => existsSync(join(runs, x, "events.jsonl"))).sort().pop();
        if (!id) continue;
        const file = join(runs, id, "events.jsonl"); if (file !== r.file) { if (r.file !== null) r.con = this.headless(r.dir); r.file = file; r.offset = 0; r.rest = ""; } // a second run of the same issue (a retry) starts from an empty row, never the first run's label
        const buf = readFileSync(file); if (buf.length <= r.offset) continue;
        const text = r.rest + buf.subarray(r.offset).toString("utf8"), cut = text.lastIndexOf("\n"); r.offset = buf.length; r.rest = text.slice(cut + 1);
        for (const l of text.slice(0, cut + 1).split("\n")) { if (!l.trim()) continue; try { r.con.onEvent(JSON.parse(l) as Ev); } catch { /* a torn or foreign line is skipped */ } }
      } catch { /* the run has not written its first event yet */ }
    }
  }
  /** The row of one issue as the run left it (its last events are read first). */
  rowOf(n: number): ManyRow | null { this.poll(); return this.rows.get(n)?.con.row() ?? null; }
  /** The rows as plain lines, in start order. */
  frame(): string[] { return [...this.rows.entries()].map(([n, r]) => r.final ?? manyLine(n, r.con.row(), (this.now() - r.t0) / 1000, r.title)); }
  tick(): void {
    this.poll();
    if (this.o.tty) { this.draw(); return; }
    for (const [n, r] of this.rows) { if (r.final !== null) continue; const x = r.con.row(), key = `${x.stage}|${x.met}/${x.lines}|${x.verdict}|${x.pr}`; if (key !== r.last) { r.last = key; this.o.write(`${manyLine(n, x, (this.now() - r.t0) / 1000, r.title)}\n`); } }
  }
  private draw(): void {
    const w = Math.max(50, terminalWidth({ columns: this.o.columns }) - 1), f = this.frame().map((l) => (l.length > w ? `${l.slice(0, w - 3)}...` : l));
    let s = this.drawn > 0 ? `\x1b[${this.drawn}A` : "";
    for (const l of f) s += `\r\x1b[2K${l}\n`;
    this.o.write(s); this.drawn = f.length;
  }
  /** The rows stay on screen as they are; later lines are written below them. */
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.drawn = 0; this.stopped = true; }
}
