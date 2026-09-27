// Loki 10 event log (docs/v10/ENGINE.md "Event log"): append-only JSONL at
// <repo>/.loki/runs/<run-id>/events.jsonl, written only by the supervisor.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { EventEnvelope, EventType, StageName, Verdict } from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const KEYS = ["v", "seq", "ts", "run", "type", "stage", "data"] as const;

/** Returns null when valid, else a reason. Unknown `type` values are accepted. */
export function validateEnvelope(x: unknown): string | null {
  if (!isObj(x)) return "not an object";
  for (const k of KEYS) if (!(k in x)) return `missing ${k}`;
  if (x.v !== 1) return "v must be 1";
  if (!Number.isInteger(x.seq) || (x.seq as number) < 0) return "seq must be a non-negative integer";
  if (typeof x.ts !== "string" || !ISO_TS.test(x.ts)) return "ts must be ISO-8601 UTC";
  if (typeof x.run !== "string" || x.run === "") return "run must be a non-empty string";
  if (typeof x.type !== "string" || x.type === "") return "type must be a non-empty string";
  if (x.stage !== null && (typeof x.stage !== "string" || x.stage === "")) return "stage must be a string or null";
  if (!isObj(x.data)) return "data must be an object";
  return null;
}

export function makeEvent(
  run: string, seq: number, type: EventType | (string & {}), stage: EventEnvelope["stage"], data: Obj,
  ts: string = new Date().toISOString(),
): EventEnvelope {
  return { v: 1, seq, ts, run, type, stage, data };
}

function parseLine(line: string): EventEnvelope | null {
  if (line.trim() === "") return null;
  try {
    const x: unknown = JSON.parse(line);
    return validateEnvelope(x) === null ? (x as EventEnvelope) : null;
  } catch {
    return null; // torn or corrupt line
  }
}

/** Reads every valid event. A torn last line (or any unparseable line) is skipped. */
export function readEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return [];
  const out: EventEnvelope[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const e = parseLine(line);
    if (e) out.push(e);
  }
  return out;
}

/** The single writer. Opens with O_APPEND and writes each line in one write(2). */
export class EventLog {
  private nextSeq: number;
  constructor(readonly path: string, readonly run: string, private readonly now: () => string = () => new Date().toISOString()) {
    if (!run) throw new Error("EventLog: run id required");
    mkdirSync(dirname(path), { recursive: true });
    const prior = readEvents(path);
    this.nextSeq = prior.length ? Math.max(...prior.map((e) => e.seq)) + 1 : 0;
    // A torn last line has no newline; terminate it so the next event is not glued to it.
    if (existsSync(path)) {
      const buf = readFileSync(path);
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) this.writeRaw("\n");
    }
  }

  append(type: EventType | (string & {}), stage: StageName | null, data: Obj): EventEnvelope {
    const e = makeEvent(this.run, this.nextSeq, type, stage, data, this.now());
    const bad = validateEnvelope(e);
    if (bad) throw new Error(`EventLog: invalid event: ${bad}`);
    this.writeRaw(JSON.stringify(e) + "\n");
    this.nextSeq++;
    return e;
  }

  private writeRaw(s: string): void {
    // ponytail: open per append; keep an fd open if append rate ever matters
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, s);
    } finally {
      closeSync(fd);
    }
  }
}

export interface Folded {
  /** Last event seen per stage (any type). */
  stages: Partial<Record<string, EventEnvelope>>;
  /** Stages with a stage.completed, in first-completion order (resume starts after these). */
  completed: string[];
  run: {
    started: EventEnvelope | null;
    completed: EventEnvelope | null;
    escalated: EventEnvelope | null;
    tampered: boolean;
    verdict: Verdict | null;
  };
  /** usd is null if no cost event or any cost event was unmeasured; never a fake 0. */
  cost: { usd: number | null; inputTokens: number; outputTokens: number };
  lastSeq: number;
}

export function fold(events: EventEnvelope[]): Folded {
  const f: Folded = {
    stages: {},
    completed: [],
    run: { started: null, completed: null, escalated: null, tampered: false, verdict: null },
    cost: { usd: null, inputTokens: 0, outputTokens: 0 },
    lastSeq: -1,
  };
  let usd = 0;
  let sawCost = false;
  let unmeasured = false;
  for (const e of events) {
    f.lastSeq = Math.max(f.lastSeq, e.seq);
    if (e.stage !== null) f.stages[e.stage] = e;
    if (e.type === "stage.completed" && e.stage !== null && !f.completed.includes(e.stage)) f.completed.push(e.stage);
    else if (e.type === "run.started") f.run.started = e;
    else if (e.type === "run.completed") {
      f.run.completed = e;
      f.run.verdict = typeof e.data.verdict === "string" ? (e.data.verdict as Verdict) : null;
    } else if (e.type === "escalated") f.run.escalated = e;
    else if (e.type === "tamper.detected") f.run.tampered = true;
    else if (e.type === "cost") {
      sawCost = true;
      if (typeof e.data.usd === "number") usd += e.data.usd;
      else unmeasured = true;
      if (typeof e.data.input_tokens === "number") f.cost.inputTokens += e.data.input_tokens;
      if (typeof e.data.output_tokens === "number") f.cost.outputTokens += e.data.output_tokens;
    }
  }
  f.cost.usd = sawCost && !unmeasured ? usd : null;
  return f;
}

/** Replays existing events synchronously, then polls for appended ones.
 *  An incomplete trailing line is held until its newline arrives. Returns stop(). */
export function tail(path: string, onEvent: (e: EventEnvelope) => void, opts: { intervalMs?: number } = {}): () => void {
  let offset = 0;
  let pending: Buffer = Buffer.alloc(0);
  const poll = (): void => {
    if (!existsSync(path)) return;
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < offset) { offset = 0; pending = Buffer.alloc(0); } // truncated or replaced
      if (size === offset) return;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      // Split on bytes, so a multi-byte character cut by a partial write is not mangled.
      pending = Buffer.concat([pending, buf]);
      const nl = pending.lastIndexOf(0x0a);
      if (nl < 0) return;
      const complete = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      for (const line of complete.split("\n")) {
        const e = parseLine(line);
        if (e) onEvent(e);
      }
    } finally {
      closeSync(fd);
    }
  };
  poll();
  const timer = setInterval(poll, opts.intervalMs ?? 250);
  return () => clearInterval(timer);
}
