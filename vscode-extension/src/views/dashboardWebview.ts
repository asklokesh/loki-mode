/**
 * Dashboard Webview Provider
 * Embeds the Loki Mode dashboard Web Components in a VS Code sidebar panel
 * Provides task board, session control, log stream, memory browser, and learning dashboard
 *
 * Refactored in v5.19.0 to use dashboard-ui Web Components
 * Reduced from 1,339 lines to ~390 lines (71% reduction) by delegating UI to reusable components
 */

import * as vscode from 'vscode';
import { LokiApiClient } from '../api/client';
import { logger } from '../utils/logger';
import { getNonce } from '../utils/webview';

export class DashboardWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'loki-dashboard';

    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];
    private _apiUrl: string;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _apiClient: LokiApiClient
    ) {
        this._apiUrl = _apiClient.baseUrl;
    }

    public dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri,
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'dist')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        const messageHandler = webviewView.webview.onDidReceiveMessage(
            async (message) => this._handleMessage(message),
            undefined,
            this._disposables
        );
        this._disposables.push(messageHandler);

        // Cleanup on dispose
        webviewView.onDidDispose(() => {
            // Web Components handle their own cleanup
        });
    }

    private async _handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
        switch (message.type) {
            case 'ready':
                // Components initialize themselves, just acknowledge
                logger.info('Dashboard webview ready');
                break;

            case 'startSession':
                await this._startSession(message.provider as string);
                break;

            case 'stopSession':
                await this._stopSession();
                break;

            case 'pauseSession':
                await this._pauseSession();
                break;

            case 'resumeSession':
                await this._resumeSession();
                break;

            case 'viewTaskDetails':
                await this._showTaskDetails(message.taskId as string);
                break;

            case 'viewPatternDetails':
                await this._showPatternDetails(message.patternId as string);
                break;

            case 'viewEpisodeDetails':
                await this._showEpisodeDetails(message.episodeId as string);
                break;

            case 'openExternal':
                if (message.url) {
                    vscode.env.openExternal(vscode.Uri.parse(message.url as string));
                }
                break;

            case 'showInfo':
                vscode.window.showInformationMessage(message.message as string);
                break;

            case 'showError':
                vscode.window.showErrorMessage(message.message as string);
                break;
        }
    }

    private async _startSession(provider: string): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;
            await fetch(`${baseUrl}/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider })
            });
            vscode.window.showInformationMessage(`Loki Mode started with ${provider}`);
        } catch (error) {
            logger.error('Failed to start session:', error);
            vscode.window.showErrorMessage('Failed to start Loki Mode session');
        }
    }

    private async _stopSession(): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;
            await fetch(`${baseUrl}/stop`, { method: 'POST' });
            vscode.window.showInformationMessage('Loki Mode stopped');
        } catch (error) {
            logger.error('Failed to stop session:', error);
            vscode.window.showErrorMessage('Failed to stop Loki Mode session');
        }
    }

    private async _pauseSession(): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;
            await fetch(`${baseUrl}/pause`, { method: 'POST' });
            vscode.window.showInformationMessage('Loki Mode paused');
        } catch (error) {
            logger.error('Failed to pause session:', error);
            vscode.window.showErrorMessage('Failed to pause Loki Mode session');
        }
    }

    private async _resumeSession(): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;
            await fetch(`${baseUrl}/resume`, { method: 'POST' });
            vscode.window.showInformationMessage('Loki Mode resumed');
        } catch (error) {
            logger.error('Failed to resume session:', error);
            vscode.window.showErrorMessage('Failed to resume Loki Mode session');
        }
    }

    private async _showTaskDetails(taskId: string): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;
            const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
            if (response.ok) {
                const task = await response.json();
                const content = JSON.stringify(task, null, 2);
                const doc = await vscode.workspace.openTextDocument({
                    content,
                    language: 'json'
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        } catch (error) {
            logger.error('Failed to fetch task details:', error);
        }
    }

    private async _showPatternDetails(patternId: string): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;
            const response = await fetch(`${baseUrl}/api/memory/patterns/${patternId}`);
            if (response.ok) {
                const pattern = await response.json();
                const content = JSON.stringify(pattern, null, 2);
                const doc = await vscode.workspace.openTextDocument({
                    content,
                    language: 'json'
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        } catch (error) {
            logger.error('Failed to fetch pattern details:', error);
        }
    }

    private async _showEpisodeDetails(episodeId: string): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;
            const response = await fetch(`${baseUrl}/api/memory/episodes/${episodeId}`);
            if (response.ok) {
                const episode = await response.json();
                const content = JSON.stringify(episode, null, 2);
                const doc = await vscode.workspace.openTextDocument({
                    content,
                    language: 'json'
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        } catch (error) {
            logger.error('Failed to fetch episode details:', error);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const dashboardUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'loki-dashboard.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   connect-src ${this._apiUrl};">
    <title>Loki Dashboard</title>
    <style>
        :root {
            --loki-accent: #d97757;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .dashboard-tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
            flex-shrink: 0;
        }
        .tab-btn {
            flex: 1;
            padding: 8px 4px;
            text-align: center;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            border-bottom: 2px solid transparent;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            transition: all 0.15s;
        }
        .tab-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .tab-btn.active {
            color: var(--loki-accent);
            border-bottom-color: var(--loki-accent);
        }
        .tab-content {
            display: none;
            flex: 1;
            overflow: auto;
            padding: 8px;
        }
        .tab-content.active {
            display: block;
        }
        /* Ensure Web Components fill their container */
        loki-task-board, loki-session-control, loki-log-stream,
        loki-memory-browser, loki-learning-dashboard, loki-council-dashboard {
            display: block;
            width: 100%;
        }
    </style>
</head>
<body>
    <div class="dashboard-tabs">
        <button class="tab-btn active" data-tab="tasks">Tasks</button>
        <button class="tab-btn" data-tab="sessions">Sessions</button>
        <button class="tab-btn" data-tab="logs">Logs</button>
        <button class="tab-btn" data-tab="memory">Memory</button>
        <button class="tab-btn" data-tab="learning">Learning</button>
        <button class="tab-btn" data-tab="council">Council</button>
    </div>

    <div id="tasks" class="tab-content active">
        <loki-task-board api-url="${this._apiUrl}" theme="vscode-dark"></loki-task-board>
    </div>
    <div id="sessions" class="tab-content">
        <loki-session-control api-url="${this._apiUrl}" theme="vscode-dark"></loki-session-control>
    </div>
    <div id="logs" class="tab-content">
        <loki-log-stream api-url="${this._apiUrl}" theme="vscode-dark" auto-scroll max-lines="500"></loki-log-stream>
    </div>
    <div id="memory" class="tab-content">
        <loki-memory-browser api-url="${this._apiUrl}" theme="vscode-dark"></loki-memory-browser>
    </div>
    <div id="learning" class="tab-content">
        <loki-learning-dashboard api-url="${this._apiUrl}" theme="vscode-dark"></loki-learning-dashboard>
    </div>
    <div id="council" class="tab-content">
        <loki-council-dashboard api-url="${this._apiUrl}" theme="vscode-dark"></loki-council-dashboard>
    </div>

    <script nonce="${nonce}" src="${dashboardUri}"></script>
    <script nonce="${nonce}">
        // Initialize Loki Dashboard Web Components
        if (typeof LokiDashboard !== 'undefined') {
            LokiDashboard.init({
                theme: 'vscode-dark',
                apiUrl: '${this._apiUrl}',
                autoDetectContext: true
            });
        }

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const tabId = btn.dataset.tab;
                document.getElementById(tabId).classList.add('active');
            });
        });

        // VS Code API bridge for extension communication
        const vscode = acquireVsCodeApi();

        // Forward Web Component events to VS Code extension
        document.addEventListener('session-start', (e) => {
            vscode.postMessage({ type: 'startSession', provider: e.detail?.provider || 'claude' });
        });
        document.addEventListener('session-stop', () => {
            vscode.postMessage({ type: 'stopSession' });
        });
        document.addEventListener('session-pause', () => {
            vscode.postMessage({ type: 'pauseSession' });
        });
        document.addEventListener('session-resume', () => {
            vscode.postMessage({ type: 'resumeSession' });
        });
        document.addEventListener('task-select', (e) => {
            vscode.postMessage({ type: 'viewTaskDetails', taskId: e.detail?.id });
        });
        document.addEventListener('pattern-select', (e) => {
            vscode.postMessage({ type: 'viewPatternDetails', patternId: e.detail?.id });
        });
        document.addEventListener('episode-select', (e) => {
            vscode.postMessage({ type: 'viewEpisodeDetails', episodeId: e.detail?.id });
        });
        document.addEventListener('council-action', (e) => {
            vscode.postMessage({ type: 'showInfo', message: 'Council action: ' + (e.detail?.action || 'unknown') });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'themeChanged':
                    // Update all components with new theme
                    document.querySelectorAll('[theme]').forEach(el => {
                        el.setAttribute('theme', message.theme);
                    });
                    break;
                case 'apiUrlChanged':
                    // Update all components with new API URL
                    document.querySelectorAll('[api-url]').forEach(el => {
                        el.setAttribute('api-url', message.apiUrl);
                    });
                    break;
            }
        });

        // Notify extension that webview is ready
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
