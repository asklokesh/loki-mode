import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
});

export const events = sqliteTable("events", {
  sourceId: text("source_id").notNull(),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  ts: text("ts").notNull(),
  type: text("type").notNull(),
  stage: text("stage"),
  data: text("data", { mode: "json" }).notNull(),
  lineSha256: text("line_sha256").notNull(),
  receivedAt: text("received_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.sourceId, t.runId, t.seq] }),
  index("events_run_seq").on(t.runId, t.seq),
  index("events_type_ts").on(t.type, t.ts),
]);

// A projection rebuilt from `events` by fold(); never written any other way.
export const runs = sqliteTable("runs", {
  sourceId: text("source_id").notNull(),
  runId: text("run_id").notNull(),
  originRepo: text("origin_repo"),
  issueRef: text("issue_ref"),
  taskSource: text("task_source"),
  provider: text("provider"),
  model: text("model"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  verdict: text("verdict"),
  prUrl: text("pr_url"),
  prDraft: integer("pr_draft"),
  costUsd: real("cost_usd"),
  partialUsd: real("partial_usd").notNull(),
  measuredSessions: integer("measured_sessions").notNull(),
  totalSessions: integer("total_sessions").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  wallS: real("wall_s"),
  lastSeq: integer("last_seq").notNull(),
  lastEventAt: text("last_event_at"),
  tampered: integer("tampered").notNull(),
  conflict: integer("conflict").notNull().default(0),
  groupId: text("group_id"),
  unitId: text("unit_id"),
}, (t) => [
  primaryKey({ columns: [t.sourceId, t.runId] }),
  index("runs_started").on(t.startedAt),
  index("runs_verdict").on(t.verdict),
  index("runs_group").on(t.groupId),
]);
