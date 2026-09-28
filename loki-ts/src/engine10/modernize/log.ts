// loki-ts/src/engine10/modernize/log.ts -- M-01: the modernize event log wrapper (docs/v10/MODERNIZE.md
// section 3 "Event log"). Reuses events.ts's EventLog/readEvents/fold/tail and the supervisor's
// single-writer pattern; the modernization id (`mid`) plays the role EventLog calls `run`.
import type { EventEnvelope } from "../types.ts";
import { EventLog, readEvents } from "../events.ts";
import { modernizeEventsPath } from "./types.ts";
import type { ModernizeEventType } from "./types.ts";

/** The single writer for one modernization's event log. Every event is run-level (stage is always null: modernize events are not scoped to an engine10 stage). */
export class ModernizeLog {
  private readonly log: EventLog;
  readonly path: string;

  constructor(readonly repoDir: string, readonly mid: string, now?: () => string) {
    this.path = modernizeEventsPath(repoDir, mid);
    this.log = new EventLog(this.path, mid, now);
  }

  append(type: ModernizeEventType | (string & {}), data: Record<string, unknown>): EventEnvelope {
    return this.log.append(type, null, data);
  }
}

export function readModernizeEvents(repoDir: string, mid: string): EventEnvelope[] {
  return readEvents(modernizeEventsPath(repoDir, mid));
}
