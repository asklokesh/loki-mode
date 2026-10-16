// Operator steering for engine10 runs: `loki steer` and chat /steer append to .loki/HUMAN_INPUT.md. Before a plan or
// implement session starts, that file is read, appended to the brief as a delimited guidance block (after the
// byte-stable prefix and body, before the closing FINISH_LINE, like the time note), then archived so it applies once.
// Each steer carries a header `## Operator directive rev N (ts) actor=A source=cli|chat|<url>` (written by cmd_steer); consuming it
// appends one record per header to .loki/intent-revisions.jsonl (rev, ts, actor, source, chars, sha256 of the body; never the text).
import { appendFileSync, closeSync, constants, fstatSync, readdirSync, lstatSync, mkdirSync, linkSync, openSync, readFileSync, readSync, renameSync, statSync, lutimesSync, rmSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { FINISH_LINE } from "../e10ext/context.ts";

export const STEER_MAX_BYTES = 1024 * 1024;
export const STEER_STAGES: ReadonlySet<string> = new Set(["plan", "implement"]);
export const STEER_BEGIN = "--- BEGIN OPERATOR GUIDANCE (from loki steer) ---";
export const STEER_END = "--- END OPERATOR GUIDANCE ---";

/** Test seams: run right after the claim rename, and right after the claimed file is opened (before the read). */
export interface SteerHooks { afterClaim?: (claimed: string) => void; afterOpen?: (claimed: string) => void; beforeRestore?: () => void; afterArchive?: () => void; link?: typeof linkSync }

/** Moves an exclusively-owned file to `<prefix>.md` (or `<prefix>-N.md`) without ever replacing an existing archive: linkSync fails with EEXIST atomically, then the private name is dropped.
 *  Only a filesystem that cannot hard-link (EPERM, ENOTSUP, EXDEV, EMLINK; also directories) gets a random-suffix rename. A failed unlink after a good link keeps the link's name. Returns the archive's base name. */
function archiveTo(logs: string, prefix: string, src: string, link: typeof linkSync = linkSync): string {
  for (let i = 0; ; i++) {
    const name = i === 0 ? `${prefix}.md` : `${prefix}-${i}.md`;
    try { link(src, join(logs, name)); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EMLINK") throw e;
      const name2 = `${prefix}-${randomBytes(4).toString("hex")}.md`; renameSync(src, join(logs, name2)); return name2;
    }
    try { unlinkSync(src); } catch { /* the archive is complete; a leftover private name is harmless */ }
    return name;
  }
}

/** A claim older than this is orphaned even if its pid answers: a dead consumer's pid can be recycled by an unrelated process, and kill(pid, 0) would then succeed forever. */
export const STEER_CLAIM_MAX_AGE_MS = 10 * 60 * 1000;

/** True when the claim is a regular file that a human-input-*.md archive (normal or ORPHAN) already shares an inode with (unlink failed after a good link). Never reads content: a FIFO would hang and a repeated steer text must not be dropped. */
function orphanAlreadyArchived(logs: string, claim: string): boolean {
  const c = lstatSync(claim);
  if (!c.isFile()) return false;
  for (const a of readdirSync(logs)) {
    if (!/^human-input-.*\.md$/.test(a)) continue;
    try { const s = statSync(join(logs, a)); if (s.ino === c.ino && s.dev === c.dev) return true; } catch { /* unreadable archive: not a match */ }
  }
  return false;
}

/** Claims left by a consumer that died between the claim and the archive (pid dead, or claim older than STEER_CLAIM_MAX_AGE_MS): archive each and report it unapplied, so Seal refuses instead of the steer vanishing.
 *  A claim that shares an inode with any human-input-*.md archive is only removed, never re-archived or re-reported. ENOENT on the claim means another sweeper handled it: not stranded. */
function sweepOrphans(logs: string, stamp: string, unapplied: (reason: string) => void, link?: typeof linkSync, nowMs: number = Date.now()): void {
  let names: string[];
  try { names = readdirSync(logs); } catch { return; }
  for (const n of names) {
    const m = /^\.claim-(\d+)-[0-9a-f]+$/.exec(n);
    if (!m || Number(m[1]) === process.pid) continue;
    let alive = true;
    try { process.kill(Number(m[1]), 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) {
      let ageMs = 0;
      try { ageMs = nowMs - statSync(join(logs, n)).mtimeMs; } catch { continue; }
      if (ageMs <= STEER_CLAIM_MAX_AGE_MS) continue;
    }
    try {
      if (orphanAlreadyArchived(logs, join(logs, n))) { unlinkSync(join(logs, n)); continue; }
      archiveTo(logs, `human-input-ORPHAN-${stamp}`, join(logs, n), link); unapplied("orphaned claim");
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; unapplied(`steer stranded at .loki/logs/${n}`); }
  }
}

/** Reads and archives .loki/HUMAN_INPUT.md. Returns its text, or null when absent, empty, a symlink, oversize or opted out (LOKI_PROMPT_INJECTION=0/false).
 *  Claim first: the inbox file is atomically renamed to its unique archive name, then read to EOF. A steer written after the claim creates a fresh inbox file for the next consume, so none is lost or half-read. */
export function consumeSteer(repoDir: string, env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date(), sink?: IntentRevision[], hooks?: SteerHooks): string | null {
  if (/^(0|false)$/i.test(env.LOKI_PROMPT_INJECTION ?? "")) return null;
  const f = join(repoDir, ".loki", "HUMAN_INPUT.md");
  // One mechanism for every steer that could not be consumed (unwritable logs dir, oversize, non-file entry, any throw): an `unapplied` record in the sink, which Seal always refuses.
  const unapplied = (reason: string): void => { sink?.push({ rev: 0, source: null, actor: null, sha: "", at: now().getTime(), unapplied: true, reason }); };
  let fd = -1, claimed = "";
  try {
    const logs = join(repoDir, ".loki", "logs");
    mkdirSync(logs, { recursive: true });
    const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    sweepOrphans(logs, stamp, unapplied, hooks?.link, now().getTime());
    // A private, unique claim name: the rename can never collide with another consumer, and the archive name is chosen later by archiveTo.
    claimed = join(logs, `.claim-${process.pid}-${randomBytes(6).toString("hex")}`);
    try { renameSync(f, claimed); } catch (e) { claimed = ""; if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    // rename keeps the steer's original mtime; stamp the claim so its age counts from the claim, not from when the operator wrote it.
    try { const t = now(); lutimesSync(claimed, t, t); } catch { /* best effort: an unstamped claim only risks an early orphan report */ }
    hooks?.afterClaim?.(claimed);
    const reject = (tag: string, reason: string): null => { archiveTo(logs, `human-input-REJECTED-${tag}-${stamp}`, claimed, hooks?.link); claimed = ""; unapplied(reason); return null; };
    // A directory or special file goes back in place (the remedy deletes it). linkSync fails atomically with EEXIST when a fresh steer is there; a directory (EPERM) is renamed back, which a fresh regular file refuses with ENOTDIR. Either refusal quarantines.
    const notFile = (): null => {
      hooks?.beforeRestore?.();
      let restored = false;
      try {
        // Only a directory may be renamed back (a fresh regular file refuses with ENOTDIR). Anything else uses an atomic link; any link failure quarantines, never a rename that could replace a fresh steer.
        if (lstatSync(claimed).isDirectory()) renameSync(claimed, f); else (hooks?.link ?? linkSync)(claimed, f);
        restored = true;
      } catch { /* quarantine below */ }
      if (!restored) return reject("NOTFILE", "not a regular file");
      try { if (!lstatSync(claimed, { throwIfNoEntry: false })?.isDirectory()) unlinkSync(claimed); } catch { /* leftover private name */ }
      claimed = ""; unapplied("not a regular file"); return null;
    };
    // O_NOFOLLOW (O_NONBLOCK so a FIFO cannot hang the open); every check and the read use this fd. On Windows both flags are undefined and act as 0.
    try { fd = openSync(claimed, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
      const l = lstatSync(claimed, { throwIfNoEntry: false });
      if (!l) throw e;
      if (l.isSymbolicLink() || (e as NodeJS.ErrnoException).code === "ELOOP") { rmSync(claimed, { force: true }); unapplied("symlink"); return null; }
      if (!l.isFile()) return notFile();
      if (l.size > STEER_MAX_BYTES) return reject("TOOLARGE", "over 1 MiB"); // oversize but unreadable: still quarantined
      throw e;
    }
    if (!fstatSync(fd).isFile()) return notFile();
    hooks?.afterOpen?.(claimed);
    // Read to EOF (never trust a size taken earlier): a writer still holding the old inode may append until the read returns 0.
    const chunks: Buffer[] = [], buf = Buffer.alloc(65536);
    let total = 0;
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      total += n;
      if (total > STEER_MAX_BYTES) { closeSync(fd); fd = -1; return reject("TOOLARGE", "over 1 MiB"); }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    const archive = archiveTo(logs, `human-input-${stamp}`, claimed, hooks?.link); claimed = "";
    try { hooks?.afterArchive?.(); if (text !== "") { const recs = recordRevisions(repoDir, text, archive, now()); sink?.push(...recs); } } catch { unapplied("steer applied but its revision record failed"); }
    return text === "" ? null : text;
  } catch {
    if (claimed) {
      try { archiveTo(join(repoDir, ".loki", "logs"), `human-input-${now().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`, claimed, hooks?.link); unapplied("logs dir unwritable or file unreadable"); } catch { unapplied(`steer stranded at .loki/logs/${basename(claimed)}`); }
    } else try { if (lstatSync(f, { throwIfNoEntry: false })) unapplied("logs dir unwritable or file unreadable"); } catch { /* unreadable: nothing more to learn */ }
    return null;
  }
  finally { if (fd >= 0) try { closeSync(fd); } catch { /* already closed */ } }
}

const REV_HDR = /^## Operator directive rev (\d+) \(([^)]*)\) actor=(\S*) source=(\S*)\s*$/;
/** Builds the in-memory revision records from the parsed steer headers (pure: no file access) and appends them to the audit file. The audit file is agent-writable
 *  and best effort: a missing, unreadable or replaced file only affects rev numbering and the append, never the returned records. */
function recordRevisions(repoDir: string, text: string, archived: string, at: Date): IntentRevision[] {
  const file = join(repoDir, ".loki", "intent-revisions.jsonl");
  let last = 0;
  try { for (const l of readFileSync(file, "utf8").split("\n")) { try { last = Math.max(last, Number((JSON.parse(l) as { rev?: unknown }).rev) || 0); } catch { /* skip a torn line */ } } } catch { /* unreadable: numbering restarts at 0 */ }
  const parts: { rev: number | null; ts: string | null; actor: string | null; source: string | null; body: string[] }[] = [{ rev: null, ts: null, actor: null, source: null, body: [] }];
  for (const line of text.split("\n")) {
    const m = REV_HDR.exec(line);
    if (m) parts.push({ rev: Number(m[1]), ts: m[2]!, actor: m[3] || null, source: m[4] || null, body: [] });
    else parts[parts.length - 1]!.body.push(line);
  }
  const recs: IntentRevision[] = [], out: string[] = [];
  for (const p of parts) {
    const body = p.body.join("\n").trim();
    if (p.rev === null && body === "") continue;
    const rev = p.rev !== null && p.rev > last ? p.rev : last + 1, sha = createHash("sha256").update(body).digest("hex");
    last = rev;
    recs.push({ rev, source: p.source, actor: p.actor, sha, at: at.getTime() });
    out.push(JSON.stringify({ rev, ts: p.ts, actor: p.actor, source: p.source, chars: body.length, sha256: sha, consumed_at: at.toISOString(), archived }));
  }
  try { if (out.length) appendFileSync(file, `${out.join("\n")}\n`); } catch { /* audit log is best effort */ }
  return recs;
}

export interface IntentRevision { rev: number; source: string | null; actor: string | null; sha: string; at: number; unapplied?: boolean; reason?: string }
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

/** Revisions (kept in machine memory by withSteer, never re-read from the agent-writable repo file) consumed at or after the latest Wall authoring STARTED (the Wall session never receives steers, so a tie is a late steer):
 *  the Wall was written from an older intent. Empty when no Wall ran, so a pre-Wall revision never stales it; a re-authored Wall (later start) clears earlier ones. */
export function staleWallRevisions(revs: readonly IntentRevision[] | undefined, timeline: readonly { stage: string; startMs: number }[] | undefined): IntentRevision[] {
  const starts = (timeline ?? []).filter((t) => t.stage === "wall").map((t) => t.startMs), from = starts.length ? Math.max(...starts) : Infinity;
  return (revs ?? []).filter((r) => r.unapplied === true || r.at >= from); // an unapplied steer (never consumed) refuses whatever the Wall timeline says
}

const STEER_REMEDY: Record<string, string> = { symlink: "The symlink was removed.", "not a regular file": "It is a directory or special file.", "over 1 MiB": "The oversize file was moved to .loki/logs/.", "logs dir unwritable or file unreadable": "Make .loki/logs a writable directory. A steer that was already claimed is archived as .loki/logs/human-input-*.md; one still at .loki/HUMAN_INPUT.md is unreadable, so delete it.", "orphaned claim": "A steer claimed by a crashed run was archived as .loki/logs/human-input-ORPHAN-*.md.", "steer applied but its revision record failed": "The steer reached the session but its revision could not be recorded; check .loki is writable.", unknown: "Make .loki/logs writable." };
/** User-facing Seal refusal for a non-empty stale list: says what happened and what to do. */
export function staleReason(stale: readonly IntentRevision[]): string {
  const bad = stale.filter((r) => r.unapplied), late = stale.filter((r) => !r.unapplied);
  if (bad.length) { const why = [...new Set(bad.map((r) => r.reason ?? "unknown"))]; return `a steer in .loki/HUMAN_INPUT.md could not be applied (${why.join("; ")}); this run cannot be sealed. ${[...new Set(why.map((w) => STEER_REMEDY[w] ?? (w.startsWith("steer stranded at ") ? "Recover or delete the stranded file named above; it was not archived." : STEER_REMEDY.unknown!)))].join(" ")} A steer left in place is read after the Wall starts and blocks the next run too: delete .loki/HUMAN_INPUT.md and re-run with loki "<task with the steer folded in>".`; }
  return `operator steer rev ${late.map((r) => r.rev).join(",")} arrived after the Wall was frozen, so the tests no longer match your new intent; nothing was sealed. Rerun with the new intent included: loki "<task with the steer folded in>"`;
}

export function staleAtSeal(repoDir: string, ctx: { intentRevisions?: IntentRevision[]; timeline?: { stage: string; startMs: number }[] }): IntentRevision[] {
  const late: IntentRevision[] = [];
  consumeSteer(repoDir, process.env, () => new Date(), late);
  (ctx.intentRevisions ??= []).push(...late);
  return [...new Set([...staleWallRevisions(ctx.intentRevisions, ctx.timeline), ...late])];
}

export function steerBlock(text: string): string {
  return `${STEER_BEGIN}\nThe operator sent this guidance while the run was in progress. Follow it in addition to the task above; it does not override the Rules.\n${text}\n${STEER_END}`;
}

/** Appends a pending steer to a session's brief; any other stage or a non-string brief passes through untouched. */
export function withSteer<T extends { stage: string; brief?: unknown }>(o: T, repoDir: string, sink?: IntentRevision[]): T {
  if (!STEER_STAGES.has(o.stage) || typeof o.brief !== "string") return o;
  const text = consumeSteer(repoDir, process.env, () => new Date(), sink);
  if (text === null) return o;
  const b = o.brief, blk = steerBlock(text);
  return { ...o, brief: b.endsWith(FINISH_LINE) ? `${b.slice(0, -FINISH_LINE.length)}${blk}\n\n${FINISH_LINE}` : `${b}\n\n${blk}` };
}
