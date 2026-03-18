import { useState, useEffect, useRef, useCallback } from 'react';
import { DashboardWebSocket } from '../api/client';

export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<DashboardWebSocket | null>(null);

  useEffect(() => {
    const ws = new DashboardWebSocket();
    wsRef.current = ws;

    ws.on('connected', () => setConnected(true));
    ws.on('disconnected', () => setConnected(false));
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
