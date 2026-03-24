export interface StatusResponse {
  running: boolean;
  paused: boolean;
  phase: string;
  iteration: number;
  complexity: string;
  mode: string;
  provider: string;
  current_task: string;
  pending_tasks: number;
  running_agents: number;
  uptime: number;
  version: string;
  pid: string;
  projectDir?: string;
  max_iterations?: number;
  cost?: number;
  start_time?: number;
}

export interface Agent {
  id: string;
  name: string;
  type: string;
  pid?: number;
  task: string;
  status: string;
  alive: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  source?: string;
}

export interface MemorySummary {
  episodic_count: number;
  semantic_count: number;
  skill_count: number;
  total_tokens: number;
  last_consolidation: string | null;
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'skip' | 'pending';
  details?: string;
}

export interface ChecklistSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  items: ChecklistItem[];
}

export interface WSMessage {
  type: string;
  data?: Record<string, unknown>;
}

export type RARVPhase = 'reason' | 'act' | 'reflect' | 'verify' | 'idle';

export interface Template {
  name: string;
  filename: string;
  content: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
}

export interface Checkpoint {
  id: string;
  timestamp: string;
  description: string;
  iteration: number;
  files_changed: number;
  is_current: boolean;
}

export interface FileDiff {
  path: string;
  action: 'add' | 'modify' | 'delete';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'delete' | 'context';
  content: string;
  old_line?: number;
  new_line?: number;
}

export interface ChangePreviewData {
  session_id: string;
  message: string;
  files: FileDiff[];
  total_additions: number;
  total_deletions: number;
}

export interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
}
