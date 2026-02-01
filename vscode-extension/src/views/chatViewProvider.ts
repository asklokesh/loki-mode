/**
 * Chat View Provider
 * Provides a webview panel for chatting with AI while Loki Mode runs
 */

import * as vscode from 'vscode';
import { LokiApiClient } from '../api/client';
import { Provider } from '../api/types';
import { logger } from '../utils/logger';

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    provider?: Provider;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'loki-chat';
    private static readonly MAX_MESSAGES = 100;

    private _view?: vscode.WebviewView;
    private _messages: ChatMessage[] = [];
    private _currentProvider: Provider = 'claude';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _apiClient: LokiApiClient
    ) {}

    /**
     * Dispose of resources when extension deactivates
     */
    public dispose(): void {
        // Clean up resources
        this._messages = [];
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
                case 'sendMessage':
                    await this._handleSendMessage(data.message);
                    break;
                case 'setProvider':
                    // Validate provider to prevent injection
                    const validProviders: Provider[] = ['claude', 'codex', 'gemini'];
                    if (validProviders.includes(data.provider)) {
                        this._currentProvider = data.provider;
                        this._addSystemMessage(`Switched to ${data.provider} provider`);
                    }
                    break;
                case 'clearHistory':
                    this._messages = [];
                    this._updateWebview();
                    break;
                case 'ready':
                    this._updateWebview();
                    break;
            }
        });

        // Add welcome message
        if (this._messages.length === 0) {
            this._addSystemMessage('Welcome to Loki Mode Chat! You can interact with the AI while Loki Mode runs in the background.');
        }
    }

    private async _handleSendMessage(message: string) {
        if (!message.trim()) return;

        // Add user message
        const userMsg: ChatMessage = {
            id: this._generateId(),
            role: 'user',
            content: message,
            timestamp: new Date(),
            provider: this._currentProvider
        };
        this._pushMessage(userMsg);
        this._updateWebview();

        try {
            // Check if server is running
            const isHealthy = await this._apiClient.health();
            if (!isHealthy) {
                this._addSystemMessage('Loki Mode server is not running. Start it first with "loki start" command.');
                return;
            }

            // Send to the chat endpoint
            const response = await this._sendChatMessage(message);

            // Add assistant response
            const assistantMsg: ChatMessage = {
                id: this._generateId(),
                role: 'assistant',
                content: response,
                timestamp: new Date(),
                provider: this._currentProvider
            };
            this._pushMessage(assistantMsg);
            this._updateWebview();

        } catch (error) {
            logger.error('Chat error:', error);
            this._addSystemMessage(`Error: ${error instanceof Error ? error.message : 'Failed to send message'}`);
        }
    }

    private async _sendChatMessage(message: string): Promise<string> {
        // Try the chat endpoint first, fall back to input injection
        try {
            const baseUrl = this._apiClient.baseUrl;
            const response = await fetch(`${baseUrl}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message,
                    provider: this._currentProvider
                })
            });

            if (response.ok) {
                const data = await response.json();
                return data.response || data.message || 'Response received';
            }

            // Fall back to input injection if chat endpoint not available
            await this._apiClient.injectInput(message);
            return 'Message sent to Loki Mode. The AI will process it in the current session.';
        } catch {
            // If chat endpoint doesn't exist, use input injection
            await this._apiClient.injectInput(message);
            return 'Message injected into current Loki session.';
        }
    }

    private _addSystemMessage(content: string) {
        const msg: ChatMessage = {
            id: this._generateId(),
            role: 'system',
            content,
            timestamp: new Date()
        };
        this._pushMessage(msg);
        this._updateWebview();
    }

    /**
     * Push a message and enforce the max message limit
     */
    private _pushMessage(msg: ChatMessage): void {
        this._messages.push(msg);
        // Enforce max message limit
        while (this._messages.length > ChatViewProvider.MAX_MESSAGES) {
            this._messages.shift();
        }
    }

    private _updateWebview() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateMessages',
                messages: this._messages,
                provider: this._currentProvider
            });
        }
    }

    private _generateId(): string {
        return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }

    public addMessage(role: 'user' | 'assistant' | 'system', content: string) {
        const msg: ChatMessage = {
            id: this._generateId(),
            role,
            content,
            timestamp: new Date()
        };
        this._pushMessage(msg);
        this._updateWebview();
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = this._getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Loki Chat</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .header select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
        }
        .header button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .header button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .message {
            padding: 10px 14px;
            border-radius: 8px;
            max-width: 85%;
            word-wrap: break-word;
            line-height: 1.4;
        }
        .message.user {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            align-self: flex-end;
            border-bottom-right-radius: 4px;
        }
        .message.assistant {
            background: var(--vscode-editor-inactiveSelectionBackground);
            align-self: flex-start;
            border-bottom-left-radius: 4px;
        }
        .message.system {
            background: var(--vscode-editorInfo-background);
            color: var(--vscode-editorInfo-foreground);
            align-self: center;
            font-size: 12px;
            padding: 6px 12px;
            border-radius: 12px;
        }
        .message-meta {
            font-size: 10px;
            opacity: 0.7;
            margin-top: 4px;
        }
        .message pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
        .message code {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .input-area {
            padding: 12px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 8px;
            flex-shrink: 0;
        }
        .input-area textarea {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 12px;
            border-radius: 6px;
            resize: none;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            min-height: 40px;
            max-height: 120px;
        }
        .input-area textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .input-area button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
            align-self: flex-end;
        }
        .input-area button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .input-area button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
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
    <div class="header">
        <select id="provider">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
        </select>
        <button id="clearBtn">Clear</button>
    </div>
    <div class="messages" id="messages">
        <div class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <p>Start a conversation with the AI</p>
            <p style="font-size: 12px; margin-top: 8px;">Messages are sent to the active Loki session</p>
        </div>
    </div>
    <div class="input-area">
        <textarea id="messageInput" placeholder="Type a message..." rows="1"></textarea>
        <button id="sendBtn">Send</button>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const clearBtn = document.getElementById('clearBtn');
        const providerSelect = document.getElementById('provider');

        let messages = [];

        // Auto-resize textarea
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        });

        // Send message
        function sendMessage() {
            const message = messageInput.value.trim();
            if (message) {
                vscode.postMessage({ type: 'sendMessage', message });
                messageInput.value = '';
                messageInput.style.height = 'auto';
            }
        }

        sendBtn.addEventListener('click', sendMessage);
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Clear history
        clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearHistory' });
        });

        // Provider change
        providerSelect.addEventListener('change', () => {
            vscode.postMessage({ type: 'setProvider', provider: providerSelect.value });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const data = event.data;
            switch (data.type) {
                case 'updateMessages':
                    messages = data.messages;
                    providerSelect.value = data.provider;
                    renderMessages();
                    break;
            }
        });

        function renderMessages() {
            if (messages.length === 0) {
                messagesContainer.innerHTML = \`
                    <div class="empty-state">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <p>Start a conversation with the AI</p>
                        <p style="font-size: 12px; margin-top: 8px;">Messages are sent to the active Loki session</p>
                    </div>
                \`;
                return;
            }

            messagesContainer.innerHTML = messages.map(msg => {
                const time = new Date(msg.timestamp).toLocaleTimeString();
                const content = escapeHtml(msg.content)
                    .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                    .replace(/\\n/g, '<br>');

                // Escape role and provider to prevent XSS
                const safeRole = escapeHtml(msg.role || 'user');
                const safeProvider = msg.provider ? escapeHtml(msg.provider) : '';

                return \`
                    <div class="message \${safeRole}">
                        <div>\${content}</div>
                        <div class="message-meta">\${time}\${safeProvider ? ' - ' + safeProvider : ''}</div>
                    </div>
                \`;
            }).join('');

            messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
