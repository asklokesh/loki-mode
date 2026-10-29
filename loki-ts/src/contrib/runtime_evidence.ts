// Moved out of core (engine10/fetch_issue.ts) to keep core under its line cap.
import { createHash } from "node:crypto";
import { parseTrackerRef, type TrackerRef } from "../features/tracker_intake.ts";
// GAME10-08a: runtime evidence in pasted task text. Pasted text is untrusted DATA: it is only pattern-matched, never executed or fetched.
export const EVIDENCE_TEXT_CAP = 64 * 1024, EVIDENCE_FRAME_CAP = 200, EVIDENCE_PAIR_CAP = 20, EVIDENCE_REF_CAP = 20;
export interface EvidenceFrame { file: string; line: number; fn: string | null }
export interface EvidenceExchange { request: string; response: string }
export interface RuntimeEvidence { frames: EvidenceFrame[]; exchanges: EvidenceExchange[]; tracker_refs: TrackerRef[]; sha256: string; truncated: boolean }
// One frame-shape family: `File "x", line N, in fn` (Python), `at fn (file:line:col)` or `at file:line:col` (JS), `at pkg.Cls.m(File.java:N)` (Java).
const PY_FRAME = /^\s*File "([^"\n]+)", line (\d+)(?:, in (\S+))?/;
const JAVA_FRAME = /^\s*at ([\w$.<>/-]+)\(([^():\s]+):(\d+)\)/;
const JS_FRAME = /^\s*at (?:async )?(?:([^\s(]+) )?\(?((?:[A-Za-z]:)?[^\s()]+?):(\d+)(?::\d+)?\)?\s*$/;
const REQ_LINE = /^\s*(?:[>*]\s*)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+)(?: HTTP\/\d(?:\.\d)?)?\s*$/;
const RES_LINE = /^\s*(?:[<*]\s*)?HTTP\/\d(?:\.\d)? (\d{3})\b/;
function frameOf(line: string): EvidenceFrame | null {
  let m = PY_FRAME.exec(line); if (m) return { file: m[1]!, line: Number(m[2]), fn: m[3] ?? null };
  m = JAVA_FRAME.exec(line); if (m) return { file: m[2]!, line: Number(m[3]), fn: m[1]! };
  m = JS_FRAME.exec(line); if (m) return { file: m[2]!, line: Number(m[3]), fn: m[1] ?? null };
  return null;
}
/** Extracts frames, request/response pairs and tracker URLs from pasted text, with a content hash over what was recorded. Returns null when none is present. Input is capped, never executed. */
export function extractRuntimeEvidence(text: string, env: NodeJS.ProcessEnv = process.env): RuntimeEvidence | null {
  const truncated = text.length > EVIDENCE_TEXT_CAP, body = truncated ? text.slice(0, EVIDENCE_TEXT_CAP) : text;
  const frames: EvidenceFrame[] = [], exchanges: EvidenceExchange[] = [], tracker_refs: TrackerRef[] = [];
  let pendingReq: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.length > 500 ? raw.slice(0, 500) : raw;
    const f = frameOf(line); if (f) { if (frames.length < EVIDENCE_FRAME_CAP) frames.push(f); continue; }
    const rq = REQ_LINE.exec(line); if (rq) { pendingReq = `${rq[1]} ${rq[2]}`; continue; }
    const rs = RES_LINE.exec(line); if (rs && pendingReq !== null) { if (exchanges.length < EVIDENCE_PAIR_CAP) exchanges.push({ request: pendingReq, response: rs[1]! }); pendingReq = null; }
  }
  for (const tok of body.match(/\b(?:jira|linear):\S+|https?:\/\/[^\s<>"')]+/g) ?? []) {
    if (tracker_refs.length >= EVIDENCE_REF_CAP) break;
    const r = parseTrackerRef(tok.replace(/[.,;]+$/, ""), env); if (r && !tracker_refs.some((x) => x.source === r.source && x.key === r.key)) tracker_refs.push(r);
  }
  if (frames.length === 0 && exchanges.length === 0 && tracker_refs.length === 0) return null;
  const canon = JSON.stringify({ frames, exchanges, tracker_refs: tracker_refs.map((r) => `${r.source}:${r.key}`) });
  return { frames, exchanges, tracker_refs, sha256: createHash("sha256").update(canon).digest("hex"), truncated };
}
