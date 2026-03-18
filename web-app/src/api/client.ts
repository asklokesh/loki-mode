const API_BASE = '/api';

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  getStatus: () => fetchJSON<import('../types/api').StatusResponse>('/status'),
  getAgents: () => fetchJSON<import('../types/api').Agent[]>('/agents'),
  getLogs: (lines = 200) => fetchJSON<import('../types/api').LogEntry[]>(`/logs?lines=${lines}`),
  getMemorySummary: () => fetchJSON<import('../types/api').MemorySummary>('/memory/summary'),
  getChecklist: () => fetchJSON<import('../types/api').ChecklistSummary>('/checklist/summary'),
};

export class DashboardWebSocket {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url?: string) {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url || `${wsProtocol}//${window.location.host}/ws`;
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
