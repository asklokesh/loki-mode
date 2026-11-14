// D82-LIVELINE: quiet-mode live status line. Presentation only, kept in e10ext so the D29 core budget holds.
// AWE-1 (LOKI_AWE_DIFF_EARLY): the candidate diff the moment implement ends, labelled "candidate, not yet checked" until a verify stage completes, with each check ticking in under it.
// AWE-3 (LOKI_AWE_LIVE_COST): the status line carries the run's elapsed time and its spend so far from cost events. Both read events only: no model call, no stage order change.
import { formatDuration, spendSoFar } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";
import { terminalWidth } from "../util/term_width.ts";
import { controlRunLink } from "../util/run_outputs.ts";
import { aweOn } from "../util/receipt_surface.ts";
import { redactSecrets, UNSAFE_TERMINAL_CHARS_RE } from "../util/redact.ts";
import { safeGit, treeSnapshot } from "../util/safe_git.ts";
const LIVE_LABELS: Record<string, string> = { intake: "reading the task", plan: "planning", wall: "writing acceptance checks", implement: "implementing", verify: "verifying", fix: "fixing failures", commit: "committing", seal: "sealing the receipt", pr: "opening the PR", deep: "deep review" };
type LiveEvent = { type: string; stage: string | null; data: Record<string, unknown>; run?: string; ts?: string };
export const CANDIDATE_LABEL = "candidate, not yet checked";
const MAX_DIFF_LINES = 40;
/** The candidate diff text: base (intake base_sha) against a snapshot of the working tree (new files included), limited to the paths implement changed. Never throws; null when unreadable. */
export function candidateDiff(repoDir: string, base: string | null, paths: string[]): string | null {
  if (!base || paths.length === 0) return null;
  const snap = treeSnapshot(repoDir); if (!snap) return null;
  try { return safeGit(repoDir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, snap, "--", ...paths.map((p) => `:(literal)${p}`)], { timeout: 10_000, maxBuffer: 8 << 20 }); } catch { return null; }
}
const safeLine = (l: string, w: number): string => { const s = redactSecrets(l.replace(/\t/g, "    ").replace(UNSAFE_TERMINAL_CHARS_RE, " ")); return s.length > w ? `${s.slice(0, Math.max(0, w - 3))}...` : s; };
export interface CandidateOpts { env?: NodeJS.ProcessEnv; repoDir?: string; columns?: number; diffOf?: (base: string | null, paths: string[]) => string | null }
/** AWE-1: prints the candidate block on implement's stage.completed, one tick per verify test.result, and the checked line when verify completes. A failed or skipped verify never reads as checked. */
export class CandidateView {
  private base: string | null = null; private pending = false; private shown = false;
  constructor(private o: CandidateOpts = {}) {}
  get unchecked(): boolean { return this.pending; }
  onEvent(e: LiveEvent, print: (lines: string[]) => void): void {
    if (!aweOn("LOKI_AWE_DIFF_EARLY", this.o.env ?? process.env)) return;
    const w = Math.max(40, terminalWidth({ columns: this.o.columns }) - 1);
    if (e.type === "stage.completed" && e.stage === "intake" && typeof e.data.base_sha === "string") this.base = e.data.base_sha;
    else if (e.type === "stage.completed" && e.stage === "implement" && !this.shown) {
      const ds = e.data.diff_stat as { files?: unknown; added?: unknown; removed?: unknown; paths?: { path?: unknown }[] } | undefined;
      const paths = (Array.isArray(ds?.paths) ? ds!.paths : []).map((p) => p.path).filter((p): p is string => typeof p === "string" && !p.startsWith(".loki/"));
      if (paths.length === 0) return; // no change recorded: nothing to show
      this.shown = true; this.pending = true;
      const text = (this.o.diffOf ?? ((b, p) => candidateDiff(this.o.repoDir ?? process.env.LOKI_E10_REPO_DIR ?? process.cwd(), b, p)))(this.base, paths);
      const body = (text ?? "").split("\n").filter((l) => l && !/^(diff --git|index |similarity |old mode|new mode)/.test(l));
      const head = `Candidate diff (${CANDIDATE_LABEL}): ${paths.length} file${paths.length === 1 ? "" : "s"}, +${Number(ds?.added ?? 0)} -${Number(ds?.removed ?? 0)}`;
      print([head, ...(text == null ? ["  (diff text unavailable; files: " + paths.join(", ") + ")"] : body.slice(0, MAX_DIFF_LINES).map((l) => `  ${safeLine(l, w - 2)}`)), ...(body.length > MAX_DIFF_LINES ? [`  (+${body.length - MAX_DIFF_LINES} more diff lines; full diff on the run branch)`] : [])].map((l) => safeLine(l, w)));
    } else if (this.pending && e.type === "test.result" && e.stage === "verify") {
      print([safeLine(`  check ${String(e.data.name ?? "check")}: ${String(e.data.result ?? "not recorded")} (${CANDIDATE_LABEL})`, w)]);
    } else if (this.pending && e.stage === "verify" && e.type === "stage.completed") {
      const checks = Array.isArray(e.data.checks) ? (e.data.checks as { result?: unknown }[]) : [], n = (r: string): number => checks.filter((c) => c.result === r).length;
      this.pending = false; print([`Candidate checked by verify: ${n("pass")} passed, ${n("fail")} failed, ${checks.length - n("pass") - n("fail")} other`]);
    } else if (this.pending && e.stage === "verify" && (e.type === "stage.failed" || e.type === "stage.skipped")) {
      print([safeLine(`Verify ${e.type === "stage.failed" ? "stopped" : "skipped"} (${String(e.data.reason ?? "no reason recorded")}): the candidate is still not checked`, w)]);
    }
  }
}
export interface LiveLineOpts { tty: boolean; write: (s: string) => void; now?: () => number; columns?: number; graceS?: number; repoDir?: string; env?: NodeJS.ProcessEnv; diffOf?: CandidateOpts["diffOf"]; spend?: (events: EventEnvelope[]) => string }
/** D82: quiet-mode progress. TTY: one status line rewritten in place (\r + clear-line), cleared before the summary. Non-TTY: one plain line per stage that stays open past graceS (fast stages print nothing, so the D48 line budget holds). */
export class LiveLine {
  private cur: { stage: string; at: number; announced: boolean } | null = null;
  private done: { stage: string; s: number } | null = null;
  private url: string | null = null; private runId: string | null = null; private shown = false; private closed = false; private readonly t0: number;
  private readonly seen: EventEnvelope[] = []; private spent: string | null = null; private readonly cand: CandidateView;
  constructor(private o: LiveLineOpts) { this.t0 = (o.now ?? Date.now)(); this.cand = new CandidateView({ env: o.env, repoDir: o.repoDir, columns: o.columns, diffOf: o.diffOf }); }
  private now(): number { return (this.o.now ?? Date.now)(); }
  private get env(): NodeJS.ProcessEnv { return this.o.env ?? process.env; }
  setUrl(u: string): void { if (u && u !== this.url) { this.url = u; this.render(); } }
  onEvent(e: LiveEvent): void {
    if (this.closed) return;
    if (typeof e.run === "string" && e.run) this.runId = e.run;
    const cp = e.data?.control_plane_url; if (typeof cp === "string" && cp) this.url = cp;
    if (aweOn("LOKI_AWE_LIVE_COST", this.env)) { this.seen.push(e as EventEnvelope); if (e.type === "cost") { try { this.spent = (this.o.spend ?? ((ev) => spendSoFar(ev, this.o.repoDir ? `${this.o.repoDir}/.loki` : undefined)))(this.seen).replace(/^\((.*)\)$/, "$1"); } catch { /* display only */ } } }
    if (e.type === "stage.started" && e.stage) this.cur = { stage: e.stage, at: this.now(), announced: false };
    else if (/^stage\.(completed|failed|skipped)$/.test(e.type) && e.stage) {
      if (e.type === "stage.completed" && typeof e.data.duration_s === "number") this.done = { stage: e.stage, s: e.data.duration_s };
      if (this.cur?.stage === e.stage) this.cur = null;
    }
    this.cand.onEvent(e, (lines) => this.printAbove(lines));
    this.tick();
  }
  /** Persistent lines above the status line: the TTY line is erased first and redrawn after. */
  private printAbove(lines: string[]): void { if (this.o.tty && this.shown) { this.o.write("\r\x1b[2K"); this.shown = false; } this.o.write(`${lines.join("\n")}\n`); }
  text(): string | null {
    if (!this.cur) return null;
    const bits = [`[${this.cur.stage}] ${LIVE_LABELS[this.cur.stage] ?? this.cur.stage}`, formatDuration((this.now() - this.cur.at) / 1000)];
    if (aweOn("LOKI_AWE_LIVE_COST", this.env)) bits.push(`run ${formatDuration((this.now() - this.t0) / 1000)}`, this.spent ?? "spend not measured yet");
    if (this.cand.unchecked) bits.push(CANDIDATE_LABEL);
    if (this.done) bits.push(`(${this.done.stage} done ${formatDuration(this.done.s)})`);
    if (this.url) bits.push(controlRunLink(this.url, this.o.repoDir ?? process.env.LOKI_E10_REPO_DIR ?? process.cwd(), this.runId ?? "") ?? this.url); // P12-19 (D06): deep link once the run id is known
    return bits.join("  ");
  }
  /** Heartbeat: redraws the TTY line (elapsed ticks) or announces a stage that outlived the grace period. */
  tick(): void { if (!this.closed) this.render(); }
  private render(): void {
    const t = this.text(); if (!t || !this.cur) return;
    if (this.o.tty) {
      const w = terminalWidth({ columns: this.o.columns }) - 1;
      this.o.write(`\r\x1b[2K${t.length > w ? t.slice(0, w) : t}`); this.shown = true;
    } else if (!this.cur.announced && (this.now() - this.cur.at) / 1000 >= (this.o.graceS ?? 3)) {
      this.cur.announced = true; this.o.write(`${t}\n`);
    }
  }
  /** Erase the status line; call before the final summary. Idempotent; later events are ignored. */
  clear(): void { if (this.shown) { this.o.write("\r\x1b[2K"); this.shown = false; } this.closed = true; }
}
