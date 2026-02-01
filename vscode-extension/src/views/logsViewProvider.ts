/**
 * Logs View Provider
 * Provides a webview panel for viewing real-time logs from Loki Mode
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LokiApiClient } from '../api/client';
import { logger } from '../utils/logger';

interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    source?: string;
}

export class LogsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'loki-logs';

    private _view?: vscode.WebviewView;
    private _logs: LogEntry[] = [];
    private _filterLevel: string = 'all';
    private _autoScroll: boolean = true;
    private _pollingInterval?: NodeJS.Timeout;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _apiClient: LokiApiClient
    ) {}

    /**
     * Dispose of resources when extension deactivates
     */
    public dispose(): void {
        this._stopLogPolling();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'setFilter':
                    this._filterLevel = data.level;
                    this._updateWebview();
                    break;
                case 'toggleAutoScroll':
                    this._autoScroll = data.enabled;
                    break;
                case 'clearLogs':
                    this._logs = [];
                    this._updateWebview();
                    break;
                case 'ready':
                    // Await initial fetch to avoid race condition
                    await this._fetchLogs();
                    this._startLogPolling();
                    break;
                case 'refresh':
                    await this._fetchLogs();
                    break;
            }
        });

        // Cleanup on view disposal
        webviewView.onDidDispose(() => {
            this._stopLogPolling();
        });
    }

    private async _fetchLogs() {
        try {
            // Try to fetch logs from API first
            const baseUrl = this._apiClient.baseUrl;
            const response = await fetch(`${baseUrl}/logs?limit=100`);

            if (response.ok) {
                const data = await response.json();
                if (data.logs && Array.isArray(data.logs)) {
                    this._logs = data.logs;
                    this._updateWebview();
                    return;
                }
            }
        } catch {
            // API logs endpoint not available, try file-based logs
        }

        // Fall back to reading log file
        await this._readLogFile();
    }

    private async _readLogFile() {
        // Find workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const lokiDir = path.join(workspaceFolders[0].uri.fsPath, '.loki');
        const logFile = path.join(lokiDir, 'logs', 'session.log');

        try {
            if (!fs.existsSync(logFile)) {
                // Try alternative log location
                const altLogFile = path.join(lokiDir, 'session.log');
                if (fs.existsSync(altLogFile)) {
                    await this._parseLogFile(altLogFile);
                }
                return;
            }

            await this._parseLogFile(logFile);
        } catch (error) {
            logger.error('Error reading log file:', error);
        }
    }

    private async _parseLogFile(logFile: string) {
        try {
            // Use async file reading to avoid blocking
            const content = await fs.promises.readFile(logFile, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());

            // Parse last 200 lines
            const recentLines = lines.slice(-200);
            this._logs = recentLines.map(line => this._parseLogLine(line)).filter(Boolean) as LogEntry[];
            this._updateWebview();
        } catch (error) {
            logger.error('Error parsing log file:', error);
        }
    }

    /**
     * Validate and normalize log level
     */
    private _normalizeLogLevel(level: string): LogEntry['level'] {
        const validLevels: LogEntry['level'][] = ['debug', 'info', 'warn', 'error'];
        const normalized = level.toLowerCase();
        // Map common alternatives
        if (normalized === 'warning') return 'warn';
        if (normalized === 'trace') return 'debug';
        if (normalized === 'fatal' || normalized === 'critical') return 'error';
        return validLevels.includes(normalized as LogEntry['level'])
            ? normalized as LogEntry['level']
            : 'info';
    }

    private _parseLogLine(line: string): LogEntry | null {
        // Common log formats:
        // [2026-01-31 10:00:00] [INFO] Message here
        // 2026-01-31T10:00:00.000Z INFO Message here
        // [INFO] Message here

        try {
            // Format 1: [timestamp] [level] message
            const match1 = line.match(/^\[(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]\s*\[(\w+)\]\s*(.*)$/);
            if (match1) {
                return {
                    timestamp: match1[1],
                    level: this._normalizeLogLevel(match1[2]),
                    message: match1[3]
                };
            }

            // Format 2: timestamp level message
            const match2 = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(\w+)\s+(.*)$/);
            if (match2) {
                return {
                    timestamp: match2[1],
                    level: this._normalizeLogLevel(match2[2]),
                    message: match2[3]
                };
            }

            // Format 3: [level] message (use current time)
            const match3 = line.match(/^\[(\w+)\]\s*(.*)$/);
            if (match3) {
                return {
                    timestamp: new Date().toISOString(),
                    level: this._normalizeLogLevel(match3[1]),
                    message: match3[2]
                };
            }

            // No match, treat as info message
            if (line.trim()) {
                return {
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    message: line
                };
            }

            return null;
        } catch {
            return null;
        }
    }

    private _startLogPolling() {
        // Poll for new logs every 2 seconds
        this._pollingInterval = setInterval(async () => {
            await this._fetchLogs();
        }, 2000);
    }

    private _stopLogPolling() {
        if (this._pollingInterval) {
            clearInterval(this._pollingInterval);
            this._pollingInterval = undefined;
        }
    }

    public addLog(entry: LogEntry) {
        this._logs.push(entry);
        // Keep only last 500 logs
        if (this._logs.length > 500) {
            this._logs = this._logs.slice(-500);
        }
        this._updateWebview();
    }

    private _updateWebview() {
        if (this._view) {
            // Filter logs based on level
            const filteredLogs = this._filterLevel === 'all'
                ? this._logs
                : this._logs.filter(log => log.level === this._filterLevel);

            this._view.webview.postMessage({
                type: 'updateLogs',
                logs: filteredLogs.slice(-200), // Send last 200 filtered
                autoScroll: this._autoScroll,
                filterLevel: this._filterLevel
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = this._getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Loki Logs</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .toolbar {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
            flex-wrap: wrap;
        }
        .toolbar-group {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .toolbar select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
        }
        .toolbar button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .toolbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .toolbar button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .log-count {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .logs {
            flex: 1;
            overflow-y: auto;
            padding: 8px 12px;
            font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
        }
        .log-entry {
            padding: 4px 8px;
            border-radius: 3px;
            margin-bottom: 2px;
            display: flex;
            gap: 8px;
            line-height: 1.4;
        }
        .log-entry:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .log-timestamp {
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            font-size: 11px;
        }
        .log-level {
            font-weight: 600;
            text-transform: uppercase;
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 3px;
            white-space: nowrap;
        }
        .log-level.debug {
            color: var(--vscode-debugIcon-pauseForeground);
            background: var(--vscode-debugIcon-pauseForeground);
            background-opacity: 0.1;
        }
        .log-level.info {
            color: var(--vscode-editorInfo-foreground);
            background: var(--vscode-editorInfo-background);
        }
        .log-level.warn {
            color: var(--vscode-editorWarning-foreground);
            background: var(--vscode-editorWarning-background);
        }
        .log-level.error {
            color: var(--vscode-editorError-foreground);
            background: var(--vscode-editorError-background);
        }
        .log-message {
            flex: 1;
            word-break: break-word;
        }
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: 20px;
        }
        .empty-state svg {
            width: 48px;
            height: 48px;
            margin-bottom: 16px;
            opacity: 0.5;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="toolbar-group">
            <select id="levelFilter">
                <option value="all">All Levels</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warning</option>
                <option value="error">Error</option>
            </select>
            <button id="refreshBtn" title="Refresh logs">Refresh</button>
            <button id="clearBtn" title="Clear logs">Clear</button>
        </div>
        <div class="toolbar-group">
            <button id="autoScrollBtn" class="active" title="Toggle auto-scroll">Auto-scroll</button>
            <span class="log-count" id="logCount">0 entries</span>
        </div>
    </div>
    <div class="logs" id="logs">
        <div class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <p>No logs available</p>
            <p style="font-size: 11px; margin-top: 8px;">Logs will appear when Loki Mode is running</p>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const logsContainer = document.getElementById('logs');
        const levelFilter = document.getElementById('levelFilter');
        const refreshBtn = document.getElementById('refreshBtn');
        const clearBtn = document.getElementById('clearBtn');
        const autoScrollBtn = document.getElementById('autoScrollBtn');
        const logCount = document.getElementById('logCount');

        let logs = [];
        let autoScroll = true;

        // Level filter change
        levelFilter.addEventListener('change', () => {
            vscode.postMessage({ type: 'setFilter', level: levelFilter.value });
        });

        // Refresh button
        refreshBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        // Clear button
        clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearLogs' });
        });

        // Auto-scroll toggle
        autoScrollBtn.addEventListener('click', () => {
            autoScroll = !autoScroll;
            autoScrollBtn.classList.toggle('active', autoScroll);
            vscode.postMessage({ type: 'toggleAutoScroll', enabled: autoScroll });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const data = event.data;
            switch (data.type) {
                case 'updateLogs':
                    logs = data.logs;
                    autoScroll = data.autoScroll;
                    levelFilter.value = data.filterLevel;
                    autoScrollBtn.classList.toggle('active', autoScroll);
                    renderLogs();
                    break;
            }
        });

        function renderLogs() {
            logCount.textContent = logs.length + ' entries';

            if (logs.length === 0) {
                logsContainer.innerHTML = \`
                    <div class="empty-state">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <line x1="16" y1="13" x2="8" y2="13"></line>
                            <line x1="16" y1="17" x2="8" y2="17"></line>
                            <polyline points="10 9 9 9 8 9"></polyline>
                        </svg>
                        <p>No logs available</p>
                        <p style="font-size: 11px; margin-top: 8px;">Logs will appear when Loki Mode is running</p>
                    </div>
                \`;
                return;
            }

            logsContainer.innerHTML = logs.map(log => {
                const time = formatTimestamp(log.timestamp);
                const message = escapeHtml(log.message);

                return \`
                    <div class="log-entry">
                        <span class="log-timestamp">\${time}</span>
                        <span class="log-level \${log.level}">\${log.level}</span>
                        <span class="log-message">\${message}</span>
                    </div>
                \`;
            }).join('');

            if (autoScroll) {
                logsContainer.scrollTop = logsContainer.scrollHeight;
            }
        }

        function formatTimestamp(ts) {
            try {
                const date = new Date(ts);
                return date.toLocaleTimeString();
            } catch {
                return ts;
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Notify extension that webview is ready
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }

    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
