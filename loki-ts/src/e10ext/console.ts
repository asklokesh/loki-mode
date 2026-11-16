// The live console: what `loki start` shows on a terminal while a run works. One panel, redrawn in place: the task, each stage, each acceptance line of
// the issue turning from waiting to met as Loki's own proof run counts a passing check for it, what the session is doing now, the spend and the keys.
// Presentation only: it reads the run's events (the same tail LiveLine reads) and never changes a stage, a verdict or a model call. It replaces LiveLine
// on a TTY (LOKI_CONSOLE=0 keeps the one-line status); pipes and CI keep LiveLine's plain lines. ASCII only, colors off under NO_COLOR.
// (New file: liveline.ts owns the one-line status and the candidate diff; a multi-line panel with keys is a different surface.)
import { formatDuration, spendSoFar } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";
import { terminalWidth } from "../util/term_width.ts";
import { redactSecrets, UNSAFE_TERMINAL_CHARS_RE } from "../util/redact.ts";

type Ev = { type: string; stage: string | null; data: Record<string, unknown>; run?: string; ts?: string };
type StageState = "waiting" | "running" | "done" | "failed" | "skipped";
type LineState = "waiting" | "met" | "unmet";
const STAGES: readonly [string, string][] = [["intake", "read"], ["plan", "plan"], ["implement", "build"], ["verify", "verify"], ["fix", "fix"], ["commit", "commit"], ["seal", "label"], ["pr", "pull request"]];
const NOW: Record<string, string> = { intake: "reading the task", plan: "planning the change", implement: "the session is building and running the product", verify: "running the repository's tests", fix: "fixing what the tests found", commit: "committing", seal: "checking every line and writing the receipt", pr: "opening the pull request" };

export const consoleOn = (env: NodeJS.ProcessEnv = process.env, tty = !!process.stdout.isTTY): boolean => tty && !/^(0|off|false|no)$/i.test((env["LOKI_CONSOLE"] ?? "").trim()) && env["TERM"] !== "dumb";
export interface ConsoleOpts { write?: (s: string) => void; /** false: do not wrap process.stdout and process.stderr (tests) */ hookStd?: boolean; now?: () => number; columns?: number; repoDir?: string; env?: NodeJS.ProcessEnv; spend?: (events: EventEnvelope[]) => string; stdin?: NodeJS.ReadStream | null; onCancel?: () => void }

export class LiveConsole {
  private readonly t0: number; private drawn = 0; private closed = false; private details = false; private rawOn = false;
  private title = "Loki"; private model = ""; private url: string | null = null; private spent: string | null = null;
  private readonly stage = new Map<string, { state: StageState; at: number; s?: number }>();
  private lines: { text: string; state: LineState; checks: number; why?: string }[] = []; private lineSource = "the issue's own lines";
  private readonly seen: EventEnvelope[] = []; private readonly recent: string[] = [];
  private diff = ""; private proof = ""; private tests = { pass: 0, fail: 0 }; private outcome = "";
  private out: (s: string) => void; private unhook: (() => void)[] = []; private midLine = false;
  constructor(private o: ConsoleOpts) { this.t0 = (o.now ?? Date.now)(); this.out = o.write ?? ((x) => { process.stdout.write(x); }); if (!o.write && o.hookStd !== false) this.hook(); this.keys(); }
  /** Anything else the run prints (a notice, a warning from a child) is written above the panel: the panel is wiped first and drawn again after, so a
   *  stray line never lands inside it. Both streams are given back in clear(). */
  private hook(): void {
    const raw = process.stdout.write.bind(process.stdout); this.out = (x) => { raw(x); };
    for (const st of [process.stdout, process.stderr] as NodeJS.WriteStream[]) {
      const orig = st.write.bind(st) as (...a: unknown[]) => boolean;
      this.unhook.push(() => { st.write = orig as typeof st.write; });
      st.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
        if (this.closed) return orig(chunk, ...rest);
        if (this.drawn > 0) { raw(`\x1b[${this.drawn}A\r\x1b[J`); this.drawn = 0; }
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
  private safe(s: string, w: number): string { const t = redactSecrets(String(s).replace(/[\t\r\n]+/g, " ").replace(UNSAFE_TERMINAL_CHARS_RE, " ")); return t.length > w ? `${t.slice(0, Math.max(0, w - 3))}...` : t; }
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
        else if (k === "\x03" || k === "q" || k === "Q") { restore(); (this.o.onCancel ?? (() => { process.kill(process.pid, "SIGINT"); }))(); }
      });
    } catch { this.rawOn = false; }
  }
  private restore: () => void = () => {};

  onEvent(e: Ev): void {
    if (this.closed) return;
    const d = e.data ?? {};
    if (e.type === "run.started" || e.type === "run.resumed") { const ref = d["issue_ref"] ?? d["task_title"]; if (typeof ref === "string" && ref) this.title = ref; if (typeof d["model"] === "string") this.model = String(d["model"]); }
    const cp = d["control_plane_url"]; if (typeof cp === "string" && cp) this.url = cp;
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
    if (e.type === "acceptance.round") this.note(`acceptance check, round ${Number(d["round"] ?? 1)}: ${Number(d["met"] ?? 0)} met, ${Number(d["unmet"] ?? 0)} handed back to the session`);
    this.render();
  }
  private setLines(rows: Record<string, unknown>[], source: unknown): void {
    if (!rows.length) return;
    this.lines = rows.map((r, i) => ({ text: String(r["line"] ?? this.lines[i]?.text ?? `line ${i + 1}`), state: (r["status"] === "met" ? "met" : r["status"] === "unmet" ? "unmet" : "waiting") as LineState, checks: Number(r["checks"] ?? 0), ...(typeof r["reason"] === "string" ? { why: r["reason"] as string } : {}) }));
    if (source === "plan") this.lineSource = "written by Loki from the issue";
  }

  /** The panel as plain lines (no cursor movement), newest state. Exported through frame() for tests. */
  frame(final = false): string[] {
    const w = Math.max(50, terminalWidth({ columns: this.o.columns }) - 1), out: string[] = [];
    const right = [this.model, formatDuration((this.now() - this.t0) / 1000), this.spent ?? ""].filter(Boolean).join("   ");
    const left = this.safe(`LOKI  ${this.title}`, Math.max(10, w - right.length - 2));
    out.push(`${this.c("1", left)}${" ".repeat(Math.max(1, w - left.length - right.length))}${this.c("2", right)}`);
    out.push(this.c("2", "-".repeat(w)));
    const tag = (s: StageState): string => s === "done" ? this.c("32", "done") : s === "running" ? this.c("33", "now ") : s === "failed" ? this.c("31", "FAIL") : s === "skipped" ? this.c("2", "skip") : this.c("2", "    ");
    const cells = STAGES.filter(([k]) => k !== "fix" || this.stage.has("fix")).map(([k, label]) => { const st = this.stage.get(k); const s = st?.state ?? "waiting"; const t = s === "running" && st ? ` ${formatDuration((this.now() - st.at) / 1000)}` : s === "done" && st?.s !== undefined ? ` ${formatDuration(st.s)}` : ""; return { plain: `[${s === "done" ? "done" : s === "running" ? "now " : s === "failed" ? "FAIL" : s === "skipped" ? "skip" : "    "}] ${label}${t}`, shown: `[${tag(s)}] ${label}${this.c("2", t)}` }; });
    let row = "", rowPlain = "";
    for (const c of cells) { if (rowPlain.length + c.plain.length + 3 > w && rowPlain) { out.push(row); row = ""; rowPlain = ""; } row += (rowPlain ? "   " : "") + c.shown; rowPlain += (rowPlain ? "   " : "") + c.plain; }
    if (rowPlain) out.push(row);
    out.push("");
    if (this.lines.length) {
      const met = this.lines.filter((l) => l.state === "met").length;
      out.push(`${this.c("1", "Acceptance")} ${this.c("2", `(${this.lineSource})`)}   ${met} of ${this.lines.length} met`);
      this.lines.forEach((l, i) => {
        const mark = l.state === "met" ? this.c("32", "[ ok ]") : l.state === "unmet" ? this.c("31", "[ no ]") : this.c("2", "[ .. ]");
        const tail = l.state === "met" && l.checks ? `  ${l.checks} check${l.checks === 1 ? "" : "s"}` : "";
        out.push(`  ${mark} ${String(i + 1).padStart(2)}  ${this.safe(l.text, w - 16 - tail.length)}${this.c("2", tail)}`);
        if (l.state === "unmet" && l.why && (final || this.details)) out.push(this.c("2", `             ${this.safe(l.why, w - 14)}`));
      });
      out.push("");
    }
    const cur = [...this.stage.entries()].reverse().find(([, v]) => v.state === "running")?.[0];
    if (!final && cur) out.push(`${this.c("1", "Now:")} ${this.safe(`${NOW[cur] ?? cur}${cur === "implement" && this.diff ? ` (${this.diff})` : ""}${cur === "verify" && this.tests.pass + this.tests.fail ? ` (${this.tests.pass} passed, ${this.tests.fail} failed so far)` : ""}`, w - 6)}`);
    if (this.proof) out.push(this.safe(this.proof, w));
    if (this.details && !final) { out.push(this.c("2", "Recent:")); for (const r of this.recent.slice(-8)) out.push(this.c("2", `  ${this.safe(r, w - 2)}`)); }
    if (!final) out.push(this.c("2", this.safe(`d details   q or Ctrl-C stop (loki start resumes it)${this.url ? `   ${this.url}` : ""}`, w)));
    return out;
  }
  tick(): void { if (!this.closed) this.render(); }
  private render(final = false): void {
    const f = this.frame(final), up = this.drawn > 0 ? `\x1b[${this.drawn}A` : "";
    let s = `\x1b[?25l${this.drawn === 0 && this.midLine ? "\n" : ""}${up}`; this.midLine = false;
    for (const l of f) s += `\r\x1b[2K${l}\n`;
    for (let i = f.length; i < this.drawn; i++) s += "\r\x1b[2K\n"; // a shorter frame: wipe what the last one left below
    if (this.drawn > f.length) s += `\x1b[${this.drawn - f.length}A`;
    this.out(s); this.drawn = f.length;
  }
  /** Leaves the final panel on screen (every line with its result) above the summary, shows the cursor again and gives the terminal back. Idempotent. */
  clear(): void { if (this.closed) return; this.render(true); this.closed = true; this.out("\x1b[?25h"); for (const u of this.unhook) u(); this.unhook = []; this.restore(); }
}
