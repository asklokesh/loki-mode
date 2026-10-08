import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  tokenSessions: integer("token_sessions"), // FC-44: cost events that carried usage; null on rows ingested before it existed
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  wallS: real("wall_s"),
  lastSeq: integer("last_seq").notNull(),
  lastEventAt: text("last_event_at"),
  tampered: integer("tampered").notNull(),
  conflict: integer("conflict").notNull().default(0),
  groupId: text("group_id"),
  unitId: text("unit_id"),
  attested: integer("attested"), // EL-FC08b: null = never evaluated (reads as unattested)
  sigChecked: integer("sig_checked"), // log seal signature verified against a configured key
  integrityKeyFp: text("integrity_key_fp"), // key-set fingerprint the integrity result was computed under; a change triggers a boot recompute
  integrityReasons: text("integrity_reasons"), // JSON string[]
}, (t) => [
  primaryKey({ columns: [t.sourceId, t.runId] }),
  index("runs_started").on(t.startedAt),
  index("runs_verdict").on(t.verdict),
  index("runs_group").on(t.groupId),
]);

// Append-only record of destructive operator actions (run removal, prune). Written before the delete runs.
export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  detail: text("detail", { mode: "json" }).notNull(),
});

// LOCAL-ONLY: written by local discovery (shipper/discover.ts), never by /v1/ingest. realpath is never returned over the API.
export const localRepos = sqliteTable("local_repos", {
  sourceId: text("source_id").primaryKey(),
  realpath: text("realpath").notNull(),
  name: text("name").notNull(),
  discoveredAt: text("discovered_at").notNull(),
});

// Audit trail of UI-initiated actions (start, stop, retry, resume, answer, config write).
export const actions = sqliteTable("actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  actor: text("actor").notNull(),
  kind: text("kind").notNull(),
  target: text("target"),
  result: text("result").notNull(),
  detail: text("detail"),
}, (t) => [index("actions_ts").on(t.ts)]);

// Ask Loki: async read-only Q&A jobs over runs, receipts, repos and issues (CP-ASK).
export const askThreads = sqliteTable("ask_threads", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  repo: text("repo"), // the repo chip; null = all repos
  provider: text("provider").notNull(),
  model: text("model"),
  title: text("title"),
});

// role: user | assistant. status: queued | running | done | failed | timeout | over_budget | interrupted
export const askMessages = sqliteTable("ask_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => askThreads.id),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  text: text("text").notNull(),
  status: text("status").notNull(),
  workerPid: integer("worker_pid"),
  pgid: integer("pgid"),
  costUsd: real("cost_usd"),
  error: text("error"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
}, (t) => [
  uniqueIndex("ask_messages_thread_seq").on(t.threadId, t.seq),
  index("ask_messages_status").on(t.status),
]);

// kind: delta | tool_use | tool_result | result | error. payload is a JSON string.
export const askEvents = sqliteTable("ask_events", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => askMessages.id),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  ts: text("ts").notNull(),
}, (t) => [
  uniqueIndex("ask_events_message_seq").on(t.messageId, t.seq),
]);
