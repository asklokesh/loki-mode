// Derive API base from current page origin so remote deployments work
const API_BASE = import.meta.env.VITE_API_BASE
  || `${window.location.origin}/api`;

// Derive WebSocket URL from current page origin (ws:// or wss://)
export const WS_URL = import.meta.env.VITE_WS_URL
  || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${res.statusText}${body ? ` - ${body}` : ''}`);
  }
  return res.json();
}

export interface StartSessionRequest {
  prd: string;
  provider: string;
  projectDir?: string;
  mode?: string; // "quick" for quick mode
}

export interface PlanResult {
  complexity: string;
  cost_estimate: string;
  iterations: number;
  phases: string[];
  output_text: string;
  returncode: number;
}

export interface ReportResult {
  content: string;
  format: string;
  returncode: number;
}

export interface ShareResult {
  url: string;
  output: string;
  returncode: number;
}

export interface ProviderInfo {
  provider: string;
  model: string;
}

export interface MetricsResult {
  iterations: number;
  quality_gate_pass_rate: number;
  time_elapsed: string;
  tokens_used: number;
  output_text?: string;
  [key: string]: unknown;
}

export interface SessionHistoryItem {
  id: string;
  path: string;
  date: string;
  prd_snippet: string;
  status: string;
}

export interface SessionDetail {
  id: string;
  path: string;
  status: string;
  prd: string;
  files: import('../types/api').FileNode[];
  logs: string[];
}

export interface OnboardResult {
  output: string;
  claude_md: string;
  returncode: number;
}

export interface StartSessionResponse {
  started: boolean;
  pid: number;
  projectDir: string;
  provider: string;
}

export const api = {
  // Session management
  startSession: (req: StartSessionRequest) =>
    fetchJSON<StartSessionResponse>('/session/start', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  stopSession: () =>
    fetchJSON<{ stopped: boolean; message: string }>('/session/stop', {
      method: 'POST',
    }),

  pauseSession: () =>
    fetchJSON<{ paused: boolean; message?: string }>('/session/pause', {
      method: 'POST',
    }),

  resumeSession: () =>
    fetchJSON<{ resumed: boolean; message?: string }>('/session/resume', {
      method: 'POST',
    }),

  getPrdPrefill: () =>
    fetchJSON<{ content: string | null }>('/session/prd-prefill'),

  getStatus: () => fetchJSON<import('../types/api').StatusResponse>('/session/status'),
  getAgents: () => fetchJSON<import('../types/api').Agent[]>('/session/agents'),
  getLogs: (lines = 200) => fetchJSON<import('../types/api').LogEntry[]>(`/session/logs?lines=${lines}`),
  getMemorySummary: () => fetchJSON<import('../types/api').MemorySummary>('/session/memory'),
  getChecklist: () => fetchJSON<import('../types/api').ChecklistSummary>('/session/checklist'),
  getFiles: () => fetchJSON<import('../types/api').FileNode[]>('/session/files'),
  getFileContent: (path: string) =>
    fetchJSON<{ content: string }>(`/session/files/content?path=${encodeURIComponent(path)}`),
  getSessionFileContent: (sessionId: string, path: string) =>
    fetchJSON<{ content: string }>(`/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`),

  // Templates
  getTemplates: () => fetchJSON<{ name: string; filename: string; description: string; category: string }[]>('/templates'),
  getTemplateContent: (filename: string) =>
    fetchJSON<{ name: string; content: string }>(`/templates/${encodeURIComponent(filename)}`),

  // Plan (pre-build estimate)
  planSession: (prd: string, provider: string) =>
    fetchJSON<PlanResult>('/session/plan', {
      method: 'POST',
      body: JSON.stringify({ prd, provider }),
    }),

  // Report (post-build)
  generateReport: (format: 'html' | 'markdown' = 'markdown') =>
    fetchJSON<ReportResult>('/session/report', {
      method: 'POST',
      body: JSON.stringify({ format }),
    }),

  // Share (GitHub Gist)
  shareSession: () =>
    fetchJSON<ShareResult>('/session/share', { method: 'POST' }),

  // Provider
  getCurrentProvider: () => fetchJSON<ProviderInfo>('/provider/current'),
  setProvider: (provider: string) =>
    fetchJSON<{ provider: string; set: boolean }>('/provider/set', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),

  // Metrics
  getMetrics: () => fetchJSON<MetricsResult>('/session/metrics'),

  // Session history
  getSessionsHistory: () => fetchJSON<SessionHistoryItem[]>('/sessions/history'),

  getSessionDetail: (sessionId: string) =>
    fetchJSON<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`),

  // Onboard
  onboardRepo: (path: string) =>
    fetchJSON<OnboardResult>('/session/onboard', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  // File CRUD
  saveSessionFile: (sessionId: string, path: string, content: string) =>
    fetchJSON<{ saved: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  createSessionFile: (sessionId: string, path: string, content: string = '') =>
    fetchJSON<{ created: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/file`, {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
  deleteSessionFile: (sessionId: string, path: string) =>
    fetchJSON<{ deleted: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/file`, {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    }),
  createSessionDirectory: (sessionId: string, path: string) =>
    fetchJSON<{ created: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/directory`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  // CLI feature endpoints
  reviewProject: (sessionId: string) =>
    fetchJSON<{ output: string; returncode: number }>(`/sessions/${encodeURIComponent(sessionId)}/review`, { method: 'POST' }),

  testProject: (sessionId: string) =>
    fetchJSON<{ output: string; returncode: number }>(`/sessions/${encodeURIComponent(sessionId)}/test`, { method: 'POST' }),

  explainProject: (sessionId: string) =>
    fetchJSON<{ output: string; returncode: number }>(`/sessions/${encodeURIComponent(sessionId)}/explain`, { method: 'POST' }),

  exportProject: (sessionId: string) =>
    fetchJSON<{ output: string; returncode: number }>(`/sessions/${encodeURIComponent(sessionId)}/export`, { method: 'POST' }),

  // Deprecated: use chatStart + chatPoll instead (non-blocking)
  chatMessage: (sessionId: string, message: string, mode: string = 'quick') =>
    fetchJSON<{ task_id: string; status: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/chat`,
      { method: 'POST', body: JSON.stringify({ message, mode }) },
    ),

  // Chat (non-blocking - returns task_id)
  chatStart: (sessionId: string, message: string, mode: string = 'quick') =>
    fetchJSON<{ task_id: string; status: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/chat`,
      { method: 'POST', body: JSON.stringify({ message, mode }) },
    ),

  chatPoll: (sessionId: string, taskId: string) =>
    fetchJSON<{ task_id: string; status: string; output_lines: string[]; returncode: number; files_changed: string[]; complete: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/chat/${encodeURIComponent(taskId)}`,
    ),

  // Preview info (smart project type detection)
  getPreviewInfo: (sessionId: string) =>
    fetchJSON<{
      type: string;
      preview_url: string | null;
      entry_file: string | null;
      dev_command: string | null;
      port: number | null;
      description: string;
    }>(`/sessions/${encodeURIComponent(sessionId)}/preview-info`),

  // Secrets
  getSecrets: () =>
    fetchJSON<Record<string, string>>('/secrets'),

  setSecret: (key: string, value: string) =>
    fetchJSON<{ set: boolean; key: string }>('/secrets', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),

  deleteSecret: (key: string) =>
    fetchJSON<{ deleted: boolean; key: string }>(`/secrets/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
};

export class PurpleLabWebSocket {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url?: string) {
    this.url = url || WS_URL;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.emit('connected', { message: 'WebSocket connected' });
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.emit(msg.type, msg.data || msg);
      } catch {
        // ignore non-JSON messages
      }
    };

    this.ws.onclose = () => {
      this.emit('disconnected', {});
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  on(type: string, callback: (data: unknown) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);
    return () => this.listeners.get(type)?.delete(callback);
  }

  private emit(type: string, data: unknown): void {
    this.listeners.get(type)?.forEach(cb => cb(data));
    this.listeners.get('*')?.forEach(cb => cb({ type, data }));
  }

  send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
