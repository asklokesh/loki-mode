import { useState, useEffect, useRef, useCallback } from 'react';
import { PurpleLabWebSocket } from '../api/client';
import type { StatusResponse, Agent, LogEntry } from '../types/api';

export interface StateUpdate {
  status: StatusResponse;
  agents: Agent[];
  logs: LogEntry[];
}

export function useWebSocket(onStateUpdate?: (update: StateUpdate) => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<PurpleLabWebSocket | null>(null);
  const onStateUpdateRef = useRef(onStateUpdate);

  // Keep ref in sync without re-creating the WebSocket on every render
  useEffect(() => {
    onStateUpdateRef.current = onStateUpdate;
  }, [onStateUpdate]);

  useEffect(() => {
    const ws = new PurpleLabWebSocket();
    wsRef.current = ws;

    ws.on('connected', () => setConnected(true));
    ws.on('disconnected', () => setConnected(false));
    ws.on('state_update', (data: unknown) => {
      if (onStateUpdateRef.current && data && typeof data === 'object') {
        onStateUpdateRef.current(data as StateUpdate);
      }
    });
    ws.connect();

    return () => {
      ws.disconnect();
      wsRef.current = null;
    };
  }, []);

  const subscribe = useCallback((type: string, callback: (data: unknown) => void) => {
    return wsRef.current?.on(type, callback) || (() => {});
  }, []);

  return { connected, subscribe };
}
