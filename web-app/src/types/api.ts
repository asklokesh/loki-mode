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
