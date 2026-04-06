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
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('API endpoint not available. Please restart the server with the latest version.');
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
  // BUG-E2E-004: Accept optional history array for conversation context
  chatStart: (sessionId: string, message: string, mode: string = 'quick', history?: Array<{ role: string; content: string }>) =>
    fetchJSON<{ task_id: string; status: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/chat`,
      { method: 'POST', body: JSON.stringify({ message, mode, history }) },
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

  // Teams
  getTeams: () =>
    fetchJSON<import('../components/TeamPanel').TeamInfo[]>('/teams'),

  createTeam: (name: string) =>
    fetchJSON<{ id: string; name: string; created: boolean }>('/teams', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getTeamMembers: (teamId: string) =>
    fetchJSON<import('../components/TeamPanel').TeamMember[]>(`/teams/${encodeURIComponent(teamId)}/members`),

  addTeamMember: (teamId: string, email: string, role: string) =>
    fetchJSON<{ added: boolean; member_id: string }>(`/teams/${encodeURIComponent(teamId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),

  // Audit log
  getAuditLog: () =>
    fetchJSON<import('../components/RBACPanel').AuditEntry[]>('/audit-log'),

  // Docker service logs
  getServiceLogs: (sessionId: string, service?: string, tail: number = 50) =>
    fetchJSON<{ logs: string[]; service?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/devserver/logs${service ? `?service=${encodeURIComponent(service)}&tail=${tail}` : `?tail=${tail}`}`
    ),

  // Checkpoints
  getCheckpoints: (sessionId: string) =>
    fetchJSON<import('../types/api').Checkpoint[]>(
      `/sessions/${encodeURIComponent(sessionId)}/checkpoints`
    ),

  restoreCheckpoint: (sessionId: string, checkpointId: string) =>
    fetchJSON<{ restored: boolean; checkpoint_id: string; description: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
      { method: 'POST' }
    ),

  // Change preview (dry-run diffs before applying)
  previewChanges: (sessionId: string, message: string) =>
    fetchJSON<import('../types/api').ChangePreviewData>(
      `/sessions/${encodeURIComponent(sessionId)}/chat/preview`,
      { method: 'POST', body: JSON.stringify({ message }) }
    ),

  // File search within a session
  searchFiles: (sessionId: string, query: string) =>
    fetchJSON<import('../types/api').FileSearchResult[]>(
      `/sessions/${encodeURIComponent(sessionId)}/files/search?q=${encodeURIComponent(query)}`
    ),

  // Restart a specific Docker service
  restartService: (sessionId: string, service: string) =>
    fetchJSON<{ restarted: boolean; service: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/devserver/restart-service`,
      { method: 'POST', body: JSON.stringify({ service }) }
    ),

  // Deploy
  deployProject: (sessionId: string, platform: string) =>
    fetchJSON<{ url?: string; error?: string; output?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/deploy`,
      { method: 'POST', body: JSON.stringify({ platform }) },
    ),

  // GitHub push (create repo + push)
  githubPush: (sessionId: string) =>
    fetchJSON<{ repo_url?: string; error?: string; output?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/github/push`,
      { method: 'POST' },
    ),

  // GitHub Issues
  getGitHubIssues: (sessionId: string, state?: string, limit?: number) =>
    fetchJSON<import('../types/api').GitHubIssue[]>(
      `/sessions/${encodeURIComponent(sessionId)}/github/issues?${new URLSearchParams({
        ...(state ? { state } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      }).toString()}`
    ),

  getGitHubIssue: (sessionId: string, number: number) =>
    fetchJSON<import('../types/api').GitHubIssue>(
      `/sessions/${encodeURIComponent(sessionId)}/github/issues/${number}`
    ),

  fixGitHubIssue: (sessionId: string, number: number) =>
    fetchJSON<{ branch: string; pr_url: string; pr_number: number; task_id: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/github/issues/${number}/fix`,
      { method: 'POST' }
    ),

  // GitHub PRs
  getGitHubPRs: (sessionId: string, state?: string, limit?: number) =>
    fetchJSON<import('../types/api').GitHubPR[]>(
      `/sessions/${encodeURIComponent(sessionId)}/github/prs?${new URLSearchParams({
        ...(state ? { state } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      }).toString()}`
    ),

  getGitHubPR: (sessionId: string, number: number) =>
    fetchJSON<import('../types/api').GitHubPR>(
      `/sessions/${encodeURIComponent(sessionId)}/github/prs/${number}`
    ),

  getGitHubPRDiff: (sessionId: string, number: number) =>
    fetchJSON<string>(
      `/sessions/${encodeURIComponent(sessionId)}/github/prs/${number}/diff`
    ),

  reviewGitHubPR: (sessionId: string, number: number, action: string, body: string) =>
    fetchJSON<void>(
      `/sessions/${encodeURIComponent(sessionId)}/github/prs/${number}/review`,
      { method: 'POST', body: JSON.stringify({ action, body }) }
    ),

  mergeGitHubPR: (sessionId: string, number: number, method: string) =>
    fetchJSON<void>(
      `/sessions/${encodeURIComponent(sessionId)}/github/prs/${number}/merge`,
      { method: 'POST', body: JSON.stringify({ method }) }
    ),

  // GitHub Actions
  getWorkflowRuns: (sessionId: string, limit?: number) =>
    fetchJSON<import('../types/api').WorkflowRun[]>(
      `/sessions/${encodeURIComponent(sessionId)}/github/runs?${new URLSearchParams({
        ...(limit ? { limit: String(limit) } : {}),
      }).toString()}`
    ),

  getWorkflowRunDetail: (sessionId: string, runId: number) =>
    fetchJSON<import('../types/api').WorkflowRun>(
      `/sessions/${encodeURIComponent(sessionId)}/github/runs/${runId}`
    ),

  getWorkflowRunLogs: (sessionId: string, runId: number) =>
    fetchJSON<string>(
      `/sessions/${encodeURIComponent(sessionId)}/github/runs/${runId}/logs`
    ),

  getWorkflows: (sessionId: string) =>
    fetchJSON<import('../types/api').Workflow[]>(
      `/sessions/${encodeURIComponent(sessionId)}/github/workflows`
    ),

  dispatchWorkflow: (sessionId: string, workflow: string, ref: string) =>
    fetchJSON<void>(
      `/sessions/${encodeURIComponent(sessionId)}/github/workflows/dispatch`,
      { method: 'POST', body: JSON.stringify({ workflow, ref }) }
    ),

  rerunWorkflow: (sessionId: string, runId: number) =>
    fetchJSON<void>(
      `/sessions/${encodeURIComponent(sessionId)}/github/runs/${runId}/rerun`,
      { method: 'POST' }
    ),

  cancelWorkflow: (sessionId: string, runId: number) =>
    fetchJSON<void>(
      `/sessions/${encodeURIComponent(sessionId)}/github/runs/${runId}/cancel`,
      { method: 'POST' }
    ),

  // GitHub Repo import
  importGitHubRepo: (sessionId: string, repo: string, branch?: string) =>
    fetchJSON<{ success: boolean; files_count: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/github/import`,
      { method: 'POST', body: JSON.stringify({ repo, ...(branch ? { branch } : {}) }) }
    ),

  // Deploy connections
  getDeployStatus: () =>
    fetchJSON<import('../types/api').DeployStatus>('/deploy/status'),

  connectVercel: (token: string) =>
    fetchJSON<{ success: boolean; user: string }>('/deploy/vercel/connect', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  connectNetlify: (token: string) =>
    fetchJSON<{ success: boolean; user: string }>('/deploy/netlify/connect', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  disconnectPlatform: (platform: string) =>
    fetchJSON<void>(`/deploy/${encodeURIComponent(platform)}/disconnect`, {
      method: 'POST',
    }),

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

  // Git integration
  git: {
    status: (sessionId: string) =>
      fetchJSON<import('../types/api').GitStatus>(
        `/sessions/${encodeURIComponent(sessionId)}/git/status`
      ),
    log: (sessionId: string, limit: number = 20) =>
      fetchJSON<import('../types/api').GitCommit[]>(
        `/sessions/${encodeURIComponent(sessionId)}/git/log?limit=${limit}`
      ),
    branches: (sessionId: string) =>
      fetchJSON<import('../types/api').GitBranch[]>(
        `/sessions/${encodeURIComponent(sessionId)}/git/branches`
      ),
    commit: (sessionId: string, message: string, files?: string[]) =>
      fetchJSON<{ hash: string; message: string }>(
        `/sessions/${encodeURIComponent(sessionId)}/git/commit`,
        { method: 'POST', body: JSON.stringify({ message, files }) }
      ),
    createBranch: (sessionId: string, name: string, checkout: boolean = true) =>
      fetchJSON<{ branch: string; created: boolean }>(
        `/sessions/${encodeURIComponent(sessionId)}/git/branch`,
        { method: 'POST', body: JSON.stringify({ name, checkout }) }
      ),
    checkoutBranch: (sessionId: string, name: string) =>
      fetchJSON<{ branch: string; switched: boolean }>(
        `/sessions/${encodeURIComponent(sessionId)}/git/checkout`,
        { method: 'POST', body: JSON.stringify({ name }) }
      ),
    push: (sessionId: string) =>
      fetchJSON<{ pushed: boolean; message: string }>(
        `/sessions/${encodeURIComponent(sessionId)}/git/push`,
        { method: 'POST' }
      ),
    pr: (sessionId: string, title: string, body: string) =>
      fetchJSON<{ url: string; number: number }>(
        `/sessions/${encodeURIComponent(sessionId)}/git/pr`,
        { method: 'POST', body: JSON.stringify({ title, body }) }
      ),
  },

  // Documentation generation
  generateDocs: (sessionId: string) =>
    fetchJSON<{ task_id: string; message: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/docs/generate`,
      { method: 'POST' },
    ),

  getDocsStatus: (sessionId: string) =>
    fetchJSON<{ has_docs: boolean; coverage_pct: number; doc_files: string[]; commits_behind: number; last_generated: string | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/docs/status`,
    ),

  getDocFiles: (sessionId: string) =>
    fetchJSON<{ files: { name: string; size: number; generated_at: string }[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/docs/files`,
    ),

  getDocFileContent: async (sessionId: string, filename: string): Promise<string> => {
    const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/docs/files/${encodeURIComponent(filename)}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${res.statusText}`);
    }
    return res.text();
  },

  // Image upload for AI chat
  chatImageUpload: async (sessionId: string, file: File): Promise<{ image_id: string; filename: string }> => {
    const formData = new FormData();
    formData.append('image', file);
    const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/chat/image`, {
      method: 'POST',
      headers: {
        ...(() => {
          const h: Record<string, string> = {};
          try {
            const token = localStorage.getItem('pl_auth_token');
            if (token) h['Authorization'] = `Bearer ${token}`;
          } catch { /* */ }
          return h;
        })(),
      },
      body: formData,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
    return res.json();
  },
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
