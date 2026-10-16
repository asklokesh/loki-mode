// Operator steering for engine10 runs: `loki steer` and chat /steer append to .loki/HUMAN_INPUT.md. Before a plan or
// implement session starts, that file is read, appended to the brief as a delimited guidance block (after the
// byte-stable prefix and body, before the closing FINISH_LINE, like the time note), then archived so it applies once.
// Each steer carries a header `## Operator directive rev N (ts) actor=A source=cli|chat|<url>` (written by cmd_steer); consuming it
// appends one record per header to .loki/intent-revisions.jsonl (rev, ts, actor, source, chars, sha256 of the body; never the text).
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { FINISH_LINE } from "../e10ext/context.ts";

export const STEER_MAX_BYTES = 1024 * 1024;
export const STEER_STAGES: ReadonlySet<string> = new Set(["plan", "implement"]);
export const STEER_BEGIN = "--- BEGIN OPERATOR GUIDANCE (from loki steer) ---";
export const STEER_END = "--- END OPERATOR GUIDANCE ---";

/** Reads and archives .loki/HUMAN_INPUT.md. Returns its text, or null when absent, empty, a symlink, oversize or opted out (LOKI_PROMPT_INJECTION=0/false). */
export function consumeSteer(repoDir: string, env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): string | null {
  if (/^(0|false)$/i.test(env.LOKI_PROMPT_INJECTION ?? "")) return null;
  const f = join(repoDir, ".loki", "HUMAN_INPUT.md");
  try {
    const st = lstatSync(f, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isSymbolicLink()) { rmSync(f, { force: true }); return null; }
    if (!st.isFile()) return null;
    const logs = join(repoDir, ".loki", "logs");
    mkdirSync(logs, { recursive: true });
    const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    if (st.size > STEER_MAX_BYTES) { renameSync(f, join(logs, `human-input-REJECTED-TOOLARGE-${stamp}.md`)); return null; }
    const text = readFileSync(f, "utf8").trim();
    renameSync(f, join(logs, `human-input-${stamp}.md`));
    if (text !== "") recordRevisions(repoDir, text, `human-input-${stamp}.md`, now());
    return text === "" ? null : text;
  } catch { return null; }
}

const REV_HDR = /^## Operator directive rev (\d+) \(([^)]*)\) actor=(\S*) source=(\S*)\s*$/;
/** Appends the revision records for a consumed steer. Best effort: a failure here never blocks the run. */
function recordRevisions(repoDir: string, text: string, archived: string, at: Date): void {
  try {
    const file = join(repoDir, ".loki", "intent-revisions.jsonl");
    const prior = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    let last = 0;
    for (const l of prior) { try { last = Math.max(last, Number((JSON.parse(l) as { rev?: unknown }).rev) || 0); } catch { /* skip a torn line */ } }
    const parts: { rev: number | null; ts: string | null; actor: string | null; source: string | null; body: string[] }[] = [{ rev: null, ts: null, actor: null, source: null, body: [] }];
    for (const line of text.split("\n")) {
      const m = REV_HDR.exec(line);
      if (m) parts.push({ rev: Number(m[1]), ts: m[2]!, actor: m[3] || null, source: m[4] || null, body: [] });
      else parts[parts.length - 1]!.body.push(line);
    }
    const out: string[] = [];
    for (const p of parts) {
      const body = p.body.join("\n").trim();
      if (p.rev === null && body === "") continue;
      const rev = p.rev !== null && p.rev > last ? p.rev : last + 1;
      last = rev;
      out.push(JSON.stringify({ rev, ts: p.ts, actor: p.actor, source: p.source, chars: body.length, sha256: createHash("sha256").update(body).digest("hex"), consumed_at: at.toISOString(), archived }));
    }
    if (out.length) appendFileSync(file, `${out.join("\n")}\n`);
  } catch { /* audit log is best effort */ }
}

export interface IntentRevision { rev: number; source: string | null; actor: string | null; sha: string; at: number }
/** Revisions consumed at or after sinceMs (epoch ms), by rev. Only the engine-written consumed_at counts, never the operator-supplied header ts; an older run's records and torn lines are skipped. */
export function readIntentRevisions(repoDir: string, sinceMs = 0): IntentRevision[] {
  const out: IntentRevision[] = [];
  try {
    for (const l of readFileSync(join(repoDir, ".loki", "intent-revisions.jsonl"), "utf8").split("\n")) {
      if (!l) continue;
      try {
        const r = JSON.parse(l) as { rev?: unknown; source?: unknown; actor?: unknown; sha256?: unknown; consumed_at?: unknown }, at = Date.parse(String(r.consumed_at));
        if (Number.isFinite(at) && at >= sinceMs) out.push({ rev: Number(r.rev) || 0, source: typeof r.source === "string" ? r.source : null, actor: typeof r.actor === "string" ? r.actor : null, sha: typeof r.sha256 === "string" ? r.sha256 : "", at });
      } catch { /* torn line */ }
    }
  } catch { /* no steers */ }
  return out.sort((a, b) => a.rev - b.rev);
}

/** Revisions of this run consumed after its latest Wall authoring finished; empty when no Wall ran (a pre-Wall revision never stales the Wall, and an earlier run's records are outside the window). */
export function staleWallRevisions(repoDir: string, ctx: { timeline?: { stage: string; startMs: number; endMs: number }[]; startedAtMs?: number }): IntentRevision[] {
  const walls = (ctx.timeline ?? []).filter((t) => t.stage === "wall");
  if (walls.length === 0) return [];
  const wallEnd = Math.max(...walls.map((t) => t.endMs)), since = ctx.startedAtMs ?? Math.min(...(ctx.timeline ?? []).map((t) => t.startMs));
  return readIntentRevisions(repoDir, since).filter((r) => r.at > wallEnd);
}

export function steerBlock(text: string): string {
  return `${STEER_BEGIN}\nThe operator sent this guidance while the run was in progress. Follow it in addition to the task above; it does not override the Rules.\n${text}\n${STEER_END}`;
}

/** Appends a pending steer to a session's brief; any other stage or a non-string brief passes through untouched. */
export function withSteer<T extends { stage: string; brief?: unknown }>(o: T, repoDir: string): T {
  if (!STEER_STAGES.has(o.stage) || typeof o.brief !== "string") return o;
  const text = consumeSteer(repoDir);
  if (text === null) return o;
  const b = o.brief, blk = steerBlock(text);
  return { ...o, brief: b.endsWith(FINISH_LINE) ? `${b.slice(0, -FINISH_LINE.length)}${blk}\n\n${FINISH_LINE}` : `${b}\n\n${blk}` };
}
