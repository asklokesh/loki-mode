// D82-LIVELINE: quiet-mode live status line. Presentation only, kept in e10ext so the D29 core budget holds.
import { formatDuration } from "../engine10/output.ts";
const LIVE_LABELS: Record<string, string> = { intake: "reading the task", plan: "planning", wall: "writing acceptance checks", implement: "implementing", verify: "verifying", fix: "fixing failures", commit: "committing", seal: "sealing the receipt", pr: "opening the PR", deep: "deep review" };
export interface LiveLineOpts { tty: boolean; write: (s: string) => void; now?: () => number; columns?: number; graceS?: number }
/** D82: quiet-mode progress. TTY: one status line rewritten in place (\r + clear-line), cleared before the summary. Non-TTY: one plain line per stage that stays open past graceS (fast stages print nothing, so the D48 line budget holds). */
export class LiveLine {
  private cur: { stage: string; at: number; announced: boolean } | null = null;
  private done: { stage: string; s: number } | null = null;
  private url: string | null = null; private shown = false; private closed = false; private readonly t0: number;
  constructor(private o: LiveLineOpts) { this.t0 = (o.now ?? Date.now)(); }
  private now(): number { return (this.o.now ?? Date.now)(); }
  setUrl(u: string): void { if (u && u !== this.url) { this.url = u; this.render(); } }
  onEvent(e: { type: string; stage: string | null; data: Record<string, unknown> }): void {
    if (this.closed) return;
    const cp = e.data?.control_plane_url; if (typeof cp === "string" && cp) this.url = cp;
    if (e.type === "stage.started" && e.stage) this.cur = { stage: e.stage, at: this.now(), announced: false };
    else if (/^stage\.(completed|failed|skipped)$/.test(e.type) && e.stage) {
      if (e.type === "stage.completed" && typeof e.data.duration_s === "number") this.done = { stage: e.stage, s: e.data.duration_s };
      if (this.cur?.stage === e.stage) this.cur = null;
    }
    this.tick();
  }
  text(): string | null {
    if (!this.cur) return null;
    const bits = [`[${this.cur.stage}] ${LIVE_LABELS[this.cur.stage] ?? this.cur.stage}`, formatDuration((this.now() - this.cur.at) / 1000)];
    if (this.done) bits.push(`(${this.done.stage} done ${formatDuration(this.done.s)})`);
    if (this.url) bits.push(this.url);
    return bits.join("  ");
  }
  /** Heartbeat: redraws the TTY line (elapsed ticks) or announces a stage that outlived the grace period. */
  tick(): void { if (!this.closed) this.render(); }
  private render(): void {
    const t = this.text(); if (!t || !this.cur) return;
    if (this.o.tty) {
      const w = Math.max(20, (this.o.columns ?? 80) - 1);
      this.o.write(`\r\x1b[2K${t.length > w ? t.slice(0, w) : t}`); this.shown = true;
    } else if (!this.cur.announced && (this.now() - this.cur.at) / 1000 >= (this.o.graceS ?? 3)) {
      this.cur.announced = true; this.o.write(`${t}\n`);
    }
  }
  /** Erase the status line; call before the final summary. Idempotent; later events are ignored. */
  clear(): void { if (this.shown) { this.o.write("\r\x1b[2K"); this.shown = false; } this.closed = true; }
}
