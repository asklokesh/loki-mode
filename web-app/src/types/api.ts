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

// Git integration types
export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
  refs: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

// Template metadata types
export interface TemplateMetadata {
  name: string;
  filename: string;
  description: string;
  category: string;
  tech_stack: string[];
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  build_time: string;
  gradient: string;
}
