// Derive API base from current page origin so remote deployments work
const API_BASE = import.meta.env.VITE_API_BASE
  || `${window.location.origin}/api`;

// Derive WebSocket URL from current page origin (ws:// or wss://)
export const WS_URL = import.meta.env.VITE_WS_URL
  || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  try {
    const token = localStorage.getItem('pl_auth_token');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } catch {
    // localStorage unavailable
  }
  return headers;
}

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...getAuthHeaders(),
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

export interface QuickStartResponse {
  started: boolean;
  session_id: string;
  project_dir: string;
  pid: number;
  provider: string;
}

export const api = {
  // Session management
  startSession: (req: StartSessionRequest) =>
    fetchJSON<StartSessionResponse>('/session/start', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  quickStart: (prompt: string, provider: string = 'claude') =>
    fetchJSON<QuickStartResponse>('/session/quick-start', {
      method: 'POST',
      body: JSON.stringify({ prompt, provider }),
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

  deleteSession: (sessionId: string) =>
    fetchJSON<{ deleted: boolean; path: string }>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),

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

  // Fix dev server errors via loki quick
  fixProject: (sessionId: string) =>
    fetchJSON<{ task_id: string; status: string; error_context?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/fix`,
      { method: 'POST' },
    ),

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

  // SSE stream URL for real-time chat output
  chatStreamUrl: (sessionId: string, taskId: string) =>
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/chat/${encodeURIComponent(taskId)}/stream`,

  // Cancel a running chat task
  chatCancel: (sessionId: string, taskId: string) =>
    fetchJSON<{ cancelled: boolean; reason?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/chat/${encodeURIComponent(taskId)}/cancel`,
      { method: 'POST' },
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

  // Dev server management
  devserver: {
    start: (sessionId: string, command?: string) =>
      fetchJSON<{
        status: string;
        port?: number;
        command?: string;
        pid?: number;
        url?: string;
        message?: string;
        output?: string[];
        portless_url?: string;
      }>(`/sessions/${encodeURIComponent(sessionId)}/devserver/start`, {
        method: 'POST',
        body: JSON.stringify({ command: command || null }),
      }),
    stop: (sessionId: string) =>
      fetchJSON<{ stopped: boolean; message: string }>(
        `/sessions/${encodeURIComponent(sessionId)}/devserver/stop`,
        { method: 'POST' },
      ),
    status: (sessionId: string) =>
      fetchJSON<{
        running: boolean;
        status: string;
        port: number | null;
        command: string | null;
        pid: number | null;
        url: string | null;
        framework: string | null;
        output: string[];
        portless_url?: string;
        auto_fix_status?: string | null;
        auto_fix_attempts?: number;
      }>(`/sessions/${encodeURIComponent(sessionId)}/devserver/status`),
  },

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

  // Docker Compose services list
  getServices: (sessionId: string) =>
    fetchJSON<{
      services: Array<{
        name: string;
        ports: number[];
        is_primary: boolean;
        has_build: boolean;
        status?: string;
        exit_code?: number;
        fix_status?: string;
      }>;
      primary_service: string | null;
      primary_port: number;
    }>(`/sessions/${encodeURIComponent(sessionId)}/services`),

  // Docker service logs
  getServiceLogs: (sessionId: string, service?: string, tail: number = 50) =>
    fetchJSON<{ logs: string[]; service?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/devserver/logs${service ? `?service=${encodeURIComponent(service)}&tail=${tail}` : `?tail=${tail}`}`
    ),

  // Restart a specific Docker service
  restartService: (sessionId: string, service: string) =>
    fetchJSON<{ restarted: boolean; service: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/devserver/restart-service`,
      { method: 'POST', body: JSON.stringify({ service }) }
    ),

  // Auth endpoints
  getMe: () =>
    fetchJSON<{ authenticated: boolean; local_mode?: boolean; sub?: string; email?: string; name?: string; avatar?: string }>('/auth/me'),

  getGitHubAuthUrl: () =>
    fetchJSON<{ url: string }>('/auth/github/url'),

  getGoogleAuthUrl: () =>
    fetchJSON<{ url: string }>('/auth/google/url'),

  githubCallback: (code: string, state: string) =>
    fetchJSON<{ token: string; user: { email: string; name: string; avatar_url: string } }>('/auth/github/callback', {
      method: 'POST',
      body: JSON.stringify({ code, state }),
    }),

  googleCallback: (code: string, state: string, redirectUri?: string) =>
    fetchJSON<{ token: string; user: { email: string; name: string; avatar_url: string } }>('/auth/google/callback', {
      method: 'POST',
      body: JSON.stringify({ code, state, redirect_uri: redirectUri || `${window.location.origin}${window.location.pathname}` }),
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
        // BUG-INT-003 fix: respond to server pings to prevent disconnection
        // during long builds. Without this, the server disconnects after 2
        // missed pong responses (120s).
        if (msg.type === 'ping') {
          this.send({ type: 'pong' });
          return;
        }
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
