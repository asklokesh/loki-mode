import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalEmulatorProps {
  sessionId: string;
  isActive: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

export function TerminalEmulator({ sessionId, isActive }: TerminalEmulatorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);

  const sendResize = useCallback(() => {
    const ws = wsRef.current;
    const term = terminalRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && term) {
      ws.send(JSON.stringify({
        type: 'resize',
        cols: term.cols,
        rows: term.rows,
      }));
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Close any lingering previous connection before opening a new one
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      const term = terminalRef.current;
      if (term) {
        term.writeln('\x1b[32m-- Terminal connected --\x1b[0m');
      }
      // Send initial resize
      const fitAddon = fitAddonRef.current;
      if (fitAddon && term) {
        try {
          fitAddon.fit();
        } catch {
          // ignore fit errors before layout is stable
        }
        sendResize();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && terminalRef.current) {
          terminalRef.current.write(msg.data);
        } else if (msg.type === 'error' && terminalRef.current) {
          terminalRef.current.writeln(`\x1b[31m${msg.data}\x1b[0m`);
        }
      } catch {
        // Not JSON -- write raw
        if (terminalRef.current) {
          terminalRef.current.write(event.data);
        }
      }
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;
      const term = terminalRef.current;

      // Code 4000 = server says "do not retry" (e.g. pexpect not installed)
      if (event.code === 4000) {
        if (term) {
          term.writeln(
            '\r\n\x1b[31m-- Terminal unavailable: ' +
            (event.reason || 'server rejected connection') +
            '. --\x1b[0m'
          );
        }
        return;
      }

      const attempts = reconnectAttemptsRef.current;

      if (attempts >= MAX_RECONNECT_ATTEMPTS) {
        if (term) {
          term.writeln(
            '\r\n\x1b[31m-- Terminal disconnected. Max reconnect attempts reached. ' +
            'Refresh the page to try again. --\x1b[0m'
          );
        }
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
      const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, attempts), MAX_RECONNECT_MS);
      reconnectAttemptsRef.current = attempts + 1;

      if (term) {
        term.writeln(
          `\r\n\x1b[33m-- Terminal disconnected. Reconnecting in ${(delay / 1000).toFixed(0)}s ` +
          `(attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})... --\x1b[0m`
        );
      }

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror, which handles reconnection
    };
  }, [sessionId, sendResize]);

  // Initialize terminal and connect WebSocket
  useEffect(() => {
    mountedRef.current = true;
    reconnectAttemptsRef.current = 0;
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#a78bfa',
        selectionBackground: '#3d3d5c',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#74c0fc',
        magenta: '#da77f2',
        cyan: '#66d9ef',
        white: '#e0e0e0',
        brightBlack: '#4a4a6a',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#91d5ff',
        brightMagenta: '#e599f7',
        brightCyan: '#99f7f5',
        brightWhite: '#ffffff',
      },
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Fit to container
    try {
      fitAddon.fit();
    } catch {
      // ignore initial fit errors
    }

    // Forward user input to WebSocket
    terminal.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Connect WebSocket
    connect();

    // ResizeObserver to auto-fit when container size changes.
    // Debounce to avoid flooding resize messages during drag-resize.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!fitAddonRef.current || !terminalRef.current) return;
        try {
          fitAddonRef.current.fit();
          sendResize();
        } catch {
          // ignore resize errors during layout transitions
        }
      }, 50);
    });
    resizeObserver.observe(container);

    return () => {
      mountedRef.current = false;
      resizeObserver.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connect, sendResize]);

  // Re-fit when tab becomes active
  useEffect(() => {
    if (isActive && fitAddonRef.current && terminalRef.current) {
      // Small delay to let the layout settle after tab switch
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          sendResize();
        } catch {
          // ignore
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive, sendResize]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: '#1a1a2e' }}
    />
  );
}
