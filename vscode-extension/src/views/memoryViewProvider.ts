/**
 * Memory View Provider
 * Provides a webview panel for viewing memory context, patterns, and token economics
 *
 * @deprecated This view is deprecated in favor of the Memory tab in the main dashboard.
 * Will be removed in v6.0.0. Use `loki.openDashboard` command with memory tab instead.
 * The dashboard provides a unified view with better integration of all Loki features.
 */

import * as vscode from 'vscode';
import { LokiApiClient } from '../api/client';
import { logger } from '../utils/logger';
import { isNotAvailableStatus, NOT_AVAILABLE_TEXT } from '../api/availability';
import { getNonce } from '../utils/webview';

interface MemoryPattern {
    id: string;
    pattern: string;
    category: string;
    confidence: number;
}

interface MemoryEpisode {
    id: string;
    task_id: string;
    agent: string;
    goal: string;
    timestamp: string;
    outcome: string;
}

interface MemorySkill {
    id: string;
    name: string;
    description: string;
    success_rate: number;
}

interface TokenStats {
    discovery_tokens: number;
    read_tokens: number;
    total_tokens: number;
    savings_percent: number;
}

interface MemoryData {
    patterns: MemoryPattern[];
    episodes: MemoryEpisode[];
    skills: MemorySkill[];
    tokenStats: TokenStats;
    lastUpdated: Date;
    unavailable?: string;
}

/**
 * @deprecated This view is deprecated in favor of the Memory tab in the main dashboard.
 * Will be removed in v6.0.0. Use `loki.openDashboard` command with memory tab instead.
 */
export class MemoryViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'loki-memory';
    private static readonly REFRESH_INTERVAL = 10000;

    private _view?: vscode.WebviewView;
    private _memoryData: MemoryData = {
        patterns: [],
        episodes: [],
        skills: [],
        tokenStats: {
            discovery_tokens: 0,
            read_tokens: 0,
            total_tokens: 0,
            savings_percent: 0
        },
        lastUpdated: new Date()
    };
    private _refreshTimer?: ReturnType<typeof setInterval>;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _apiClient: LokiApiClient
    ) {
        console.warn('[DEPRECATED] MemoryViewProvider is deprecated. Use the Memory tab in the main dashboard instead. This view will be removed in v6.0.0.');
    }

    public dispose(): void {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = undefined;
        }
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

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'refresh':
                    await this._refreshMemoryData();
                    break;
                case 'ready':
                    await this._refreshMemoryData();
                    this._startAutoRefresh();
                    break;
                case 'viewPattern':
                    this._showPatternDetails(data.id);
                    break;
                case 'viewEpisode':
                    this._showEpisodeDetails(data.id);
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._refreshMemoryData();
                this._startAutoRefresh();
            } else {
                this._stopAutoRefresh();
            }
        });
    }

    private _startAutoRefresh(): void {
        if (this._refreshTimer) return;
        this._refreshTimer = setInterval(() => {
            this._refreshMemoryData();
        }, MemoryViewProvider.REFRESH_INTERVAL);
    }

    private _stopAutoRefresh(): void {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = undefined;
        }
    }

    private async _refreshMemoryData(): Promise<void> {
        try {
            const baseUrl = this._apiClient.baseUrl;

            const [patternsRes, episodesRes, skillsRes, economicsRes] = await Promise.allSettled([
                fetch(`${baseUrl}/api/memory/patterns`),
                fetch(`${baseUrl}/api/memory/episodes`),
                fetch(`${baseUrl}/api/memory/skills`),
                fetch(`${baseUrl}/api/memory/economics`)
            ]);

            const results = [patternsRes, episodesRes, skillsRes, economicsRes];
            const unavailable = results.every(r => r.status === 'fulfilled' && isNotAvailableStatus(r.value.status));
            if (unavailable) {
                // Honest degrade: the Control Plane serves no memory API. Show no data rather than stale or invented data.
                this._memoryData.patterns = [];
                this._memoryData.episodes = [];
                this._memoryData.skills = [];
                this._memoryData.unavailable = `Memory is ${NOT_AVAILABLE_TEXT}`;
                this._memoryData.lastUpdated = new Date();
                this._updateWebview();
                return;
            }
            this._memoryData.unavailable = undefined;

            if (patternsRes.status === 'fulfilled' && patternsRes.value.ok) {
                const data = await patternsRes.value.json() as { patterns?: MemoryPattern[] };
                this._memoryData.patterns = (data.patterns || []).slice(0, 10);
            }

            if (episodesRes.status === 'fulfilled' && episodesRes.value.ok) {
                const data = await episodesRes.value.json() as { episodes?: MemoryEpisode[] };
                this._memoryData.episodes = (data.episodes || []).slice(0, 5);
            }

            if (skillsRes.status === 'fulfilled' && skillsRes.value.ok) {
                const data = await skillsRes.value.json() as { skills?: MemorySkill[] };
                this._memoryData.skills = (data.skills || []).slice(0, 5);
            }

            if (economicsRes.status === 'fulfilled' && economicsRes.value.ok) {
                const data = await economicsRes.value.json() as TokenStats;
                this._memoryData.tokenStats = data;
            }

            this._memoryData.lastUpdated = new Date();
            this._updateWebview();

        } catch (error) {
            logger.debug('Memory refresh failed:', error);
        }
    }

    private _updateWebview(): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateMemory',
                data: this._memoryData
            });
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

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Loki Memory</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); padding: 12px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .header h2 { font-size: 14px; font-weight: 600; }
        .refresh-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
        .refresh-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .section { margin-bottom: 20px; }
        .section-title { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
        .section-title .count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 10px; font-size: 10px; }
        .card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; transition: background 0.15s; }
        .card:hover { background: var(--vscode-list-hoverBackground); }
        .card-title { font-weight: 500; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
        .card-meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .confidence { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .confidence.high { background: var(--vscode-testing-iconPassed); color: white; }
        .confidence.medium { background: var(--vscode-editorWarning-foreground); color: white; }
        .token-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .stat-card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 12px; text-align: center; }
        .stat-value { font-size: 18px; font-weight: 600; color: var(--vscode-foreground); }
        .stat-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-top: 4px; }
        .savings { color: var(--vscode-testing-iconPassed); }
        .empty-state { text-align: center; padding: 20px; color: var(--vscode-descriptionForeground); }
        .last-updated { font-size: 10px; color: var(--vscode-descriptionForeground); text-align: center; margin-top: 16px; }
        .outcome-success { color: var(--vscode-testing-iconPassed); }
        .outcome-failure { color: var(--vscode-testing-iconFailed); }
    </style>
</head>
<body>
    <div class="header"><h2>Memory Context</h2><button class="refresh-btn" id="refreshBtn">Refresh</button></div>
    <div class="section"><div class="section-title">Token Economics</div><div class="token-stats" id="tokenStats"><div class="stat-card"><div class="stat-value" id="totalTokens">-</div><div class="stat-label">Total Tokens</div></div><div class="stat-card"><div class="stat-value savings" id="savings">-</div><div class="stat-label">Savings</div></div></div></div>
    <div class="section"><div class="section-title">Patterns <span class="count" id="patternCount">0</span></div><div id="patterns"><div class="empty-state">No patterns learned yet</div></div></div>
    <div class="section"><div class="section-title">Recent Episodes <span class="count" id="episodeCount">0</span></div><div id="episodes"><div class="empty-state">No episodes recorded</div></div></div>
    <div class="section"><div class="section-title">Skills <span class="count" id="skillCount">0</span></div><div id="skills"><div class="empty-state">No skills learned</div></div></div>
    <div class="last-updated" id="lastUpdated">-</div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('refreshBtn').addEventListener('click', () => { vscode.postMessage({ type: 'refresh' }); });
        window.addEventListener('message', event => { if (event.data.type === 'updateMemory') updateUI(event.data.data); });
        function updateUI(data) {
            document.getElementById('totalTokens').textContent = formatNumber(data.tokenStats.total_tokens || 0);
            document.getElementById('savings').textContent = (data.tokenStats.savings_percent || 0).toFixed(1) + '%';
            document.getElementById('patternCount').textContent = data.patterns.length;
            const patternsEl = document.getElementById('patterns');
            patternsEl.innerHTML = data.patterns.length === 0 ? '<div class="empty-state">No patterns learned yet</div>' : data.patterns.map(p => '<div class="card" onclick="viewPattern(\\'' + escapeAttr(p.id) + '\\')"><div class="card-title"><span>' + escapeHtml(truncate(p.pattern, 50)) + '</span><span class="confidence ' + (p.confidence > 0.8 ? 'high' : p.confidence > 0.5 ? 'medium' : '') + '">' + (p.confidence * 100).toFixed(0) + '%</span></div><div class="card-meta">' + escapeHtml(p.category) + '</div></div>').join('');
            document.getElementById('episodeCount').textContent = data.episodes.length;
            const episodesEl = document.getElementById('episodes');
            episodesEl.innerHTML = data.episodes.length === 0 ? '<div class="empty-state">No episodes recorded</div>' : data.episodes.map(e => '<div class="card" onclick="viewEpisode(\\'' + escapeAttr(e.id) + '\\')"><div class="card-title"><span>' + escapeHtml(truncate(e.goal, 40)) + '</span><span class="' + (e.outcome === 'success' ? 'outcome-success' : 'outcome-failure') + '">' + escapeHtml(e.outcome) + '</span></div><div class="card-meta">' + escapeHtml(e.agent) + ' - ' + formatDate(e.timestamp) + '</div></div>').join('');
            document.getElementById('skillCount').textContent = data.skills.length;
            const skillsEl = document.getElementById('skills');
            skillsEl.innerHTML = data.skills.length === 0 ? '<div class="empty-state">No skills learned</div>' : data.skills.map(s => '<div class="card"><div class="card-title"><span>' + escapeHtml(s.name) + '</span><span class="confidence">' + (s.success_rate * 100).toFixed(0) + '%</span></div><div class="card-meta">' + escapeHtml(truncate(s.description, 60)) + '</div></div>').join('');
            document.getElementById('lastUpdated').textContent = data.unavailable ? data.unavailable : 'Updated: ' + new Date(data.lastUpdated).toLocaleTimeString();
        }
        function viewPattern(id) { vscode.postMessage({ type: 'viewPattern', id: id }); }
        function viewEpisode(id) { vscode.postMessage({ type: 'viewEpisode', id: id }); }
        function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text || ''; return div.innerHTML; }
        function escapeAttr(text) { return (text || '').replace(/'/g, "\\\\'").replace(/"/g, '\\\\"'); }
        function truncate(text, len) { return !text ? '' : text.length > len ? text.substring(0, len) + '...' : text; }
        function formatNumber(n) { return n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toString(); }
        function formatDate(d) { return !d ? '-' : new Date(d).toLocaleDateString() + ' ' + new Date(d).toLocaleTimeString(); }
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
