import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Config } from './utils/config';
import { Logger, logger } from './utils/logger';
import { ChatViewProvider } from './views/chatViewProvider';
import { LogsViewProvider } from './views/logsViewProvider';
import { LokiApiClient } from './api/client';

// State tracking
let isRunning = false;
let isPaused = false;
let statusBarItem: vscode.StatusBarItem | undefined;
let pollingInterval: NodeJS.Timeout | undefined;

/**
 * Session item for the sessions tree view
 */
class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly status: 'running' | 'paused' | 'stopped',
        public readonly provider: string,
        public readonly startTime: Date,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);
        this.tooltip = `${provider} - ${status} - Started: ${startTime.toLocaleTimeString()}`;
        this.description = `${provider} (${status})`;

        switch (status) {
            case 'running':
                this.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green'));
                break;
            case 'paused':
                this.iconPath = new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
                break;
            case 'stopped':
                this.iconPath = new vscode.ThemeIcon('stop-circle', new vscode.ThemeColor('charts.red'));
                break;
        }
    }
}

/**
 * Task item for the tasks tree view
 */
class TaskItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly taskId: string,
        public readonly status: 'pending' | 'in_progress' | 'completed',
        public readonly description?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = description || label;

        switch (status) {
            case 'pending':
                this.iconPath = new vscode.ThemeIcon('circle-outline');
                this.description = 'pending';
                break;
            case 'in_progress':
                this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'));
                this.description = 'in progress';
                break;
            case 'completed':
                this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
                this.description = 'completed';
                break;
        }
    }
}

/**
 * Tree data provider for Loki sessions
 */
class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SessionItem | undefined | null | void> = new vscode.EventEmitter<SessionItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SessionItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private sessions: SessionItem[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    addSession(session: SessionItem): void {
        this.sessions.push(session);
        this.refresh();
    }

    updateSession(label: string, status: 'running' | 'paused' | 'stopped'): void {
        const session = this.sessions.find(s => s.label === label);
        if (session) {
            const index = this.sessions.indexOf(session);
            this.sessions[index] = new SessionItem(
                session.label,
                status,
                session.provider,
                session.startTime
            );
            this.refresh();
        }
    }

    clearSessions(): void {
        this.sessions = [];
        this.refresh();
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<SessionItem[]> {
        return Promise.resolve(this.sessions);
    }
}

/**
 * Tree data provider for Loki tasks
 */
class TasksProvider implements vscode.TreeDataProvider<TaskItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TaskItem | undefined | null | void> = new vscode.EventEmitter<TaskItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TaskItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private tasks: TaskItem[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setTasks(tasks: TaskItem[]): void {
        this.tasks = tasks;
        this.refresh();
    }

    clearTasks(): void {
        this.tasks = [];
        this.refresh();
    }

    getTreeItem(element: TaskItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<TaskItem[]> {
        return Promise.resolve(this.tasks);
    }
}

// Tree providers
let sessionsProvider: SessionsProvider;
let tasksProvider: TasksProvider;
let chatViewProvider: ChatViewProvider;
let logsViewProvider: LogsViewProvider;
let apiClient: LokiApiClient;

/**
 * Check if the workspace has a .loki directory
 */
function hasLokiDirectory(): boolean {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return false;
    }

    const lokiPath = path.join(workspaceFolders[0].uri.fsPath, '.loki');
    return fs.existsSync(lokiPath);
}

/**
 * Make an API request to the Loki server
 */
async function apiRequest(endpoint: string, method: string = 'GET', body?: unknown): Promise<unknown> {
    const baseUrl = Config.apiBaseUrl;
    const url = `${baseUrl}${endpoint}`;

    logger.debug(`API request: ${method} ${url}`);

    try {
        const options: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        logger.debug(`API response:`, data);
        return data;
    } catch (error) {
        logger.error(`API request failed: ${endpoint}`, error);
        throw error;
    }
}

/**
 * Update the status bar item
 */
function updateStatusBar(): void {
    if (!statusBarItem) {
        return;
    }

    if (!Config.showStatusBar) {
        statusBarItem.hide();
        return;
    }

    if (isRunning) {
        if (isPaused) {
            statusBarItem.text = '$(debug-pause) Loki: Paused';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBarItem.text = '$(play) Loki: Running';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        }
    } else {
        statusBarItem.text = '$(stop) Loki: Stopped';
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();
}

/**
 * Update VS Code context for menu visibility
 */
function updateContext(): void {
    vscode.commands.executeCommand('setContext', 'loki.isRunning', isRunning);
    vscode.commands.executeCommand('setContext', 'loki.isPaused', isPaused);
}

/**
 * Poll the API for status updates
 */
async function pollStatus(): Promise<void> {
    try {
        const status = await apiRequest('/status') as { running?: boolean; paused?: boolean; tasks?: Array<{ id: string; title: string; status: string; description?: string }> };

        if (status.running !== undefined && status.running !== isRunning) {
            isRunning = status.running;
            updateStatusBar();
            updateContext();
        }

        if (status.paused !== undefined && status.paused !== isPaused) {
            isPaused = status.paused;
            updateStatusBar();
            updateContext();
        }

        if (status.tasks && Array.isArray(status.tasks)) {
            const taskItems = status.tasks.map(t => new TaskItem(
                t.title,
                t.id,
                t.status as 'pending' | 'in_progress' | 'completed',
                t.description
            ));
            tasksProvider.setTasks(taskItems);
        }
    } catch {
        // API not available, silently ignore
        logger.debug('API polling failed - server may not be running');
    }
}

/**
 * Start polling the API
 */
function startPolling(): void {
    if (pollingInterval) {
        return;
    }

    const interval = Config.pollingInterval;
    pollingInterval = setInterval(pollStatus, interval);
    logger.info(`Started API polling (interval: ${interval}ms)`);
}

/**
 * Stop polling the API
 */
function stopPolling(): void {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = undefined;
        logger.info('Stopped API polling');
    }
}

/**
 * Connect to the Loki API
 */
async function connectToApi(): Promise<boolean> {
    logger.info(`Connecting to Loki API at ${Config.apiBaseUrl}`);

    try {
        await apiRequest('/health');
        logger.info('Successfully connected to Loki API');
        startPolling();
        return true;
    } catch {
        logger.warn('Could not connect to Loki API - server may not be running');
        return false;
    }
}

/**
 * Start Loki Mode command handler
 */
async function startLokiMode(): Promise<void> {
    if (isRunning) {
        vscode.window.showWarningMessage('Loki Mode is already running');
        return;
    }

    logger.info('Starting Loki Mode...');

    // Check for PRD file
    let prdPath = Config.prdPath;

    if (!prdPath) {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'PRD Files': ['md', 'txt', 'json'],
                'All Files': ['*']
            },
            title: 'Select PRD File (optional)'
        });

        if (result && result.length > 0) {
            prdPath = result[0].fsPath;
        }
    }

    try {
        await apiRequest('/start', 'POST', {
            provider: Config.provider,
            prd: prdPath || undefined
        });

        isRunning = true;
        isPaused = false;
        updateStatusBar();
        updateContext();

        // Add session to tree view
        const sessionName = `Session ${new Date().toLocaleTimeString()}`;
        sessionsProvider.addSession(new SessionItem(
            sessionName,
            'running',
            Config.provider,
            new Date()
        ));

        vscode.window.showInformationMessage(`Loki Mode started with provider: ${Config.provider}`);
        logger.info(`Loki Mode started (provider: ${Config.provider}, prd: ${prdPath || 'none'})`);

        startPolling();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to start Loki Mode: ${errorMessage}`);
        logger.error('Failed to start Loki Mode', error);
    }
}

/**
 * Stop Loki Mode command handler
 */
async function stopLokiMode(): Promise<void> {
    if (!isRunning) {
        vscode.window.showWarningMessage('Loki Mode is not running');
        return;
    }

    logger.info('Stopping Loki Mode...');

    try {
        await apiRequest('/stop', 'POST');

        isRunning = false;
        isPaused = false;
        updateStatusBar();
        updateContext();

        sessionsProvider.clearSessions();
        tasksProvider.clearTasks();
        stopPolling();

        vscode.window.showInformationMessage('Loki Mode stopped');
        logger.info('Loki Mode stopped');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to stop Loki Mode: ${errorMessage}`);
        logger.error('Failed to stop Loki Mode', error);
    }
}

/**
 * Pause Loki Mode command handler
 */
async function pauseLokiMode(): Promise<void> {
    if (!isRunning) {
        vscode.window.showWarningMessage('Loki Mode is not running');
        return;
    }

    if (isPaused) {
        vscode.window.showWarningMessage('Loki Mode is already paused');
        return;
    }

    logger.info('Pausing Loki Mode...');

    try {
        await apiRequest('/pause', 'POST');

        isPaused = true;
        updateStatusBar();
        updateContext();

        vscode.window.showInformationMessage('Loki Mode paused');
        logger.info('Loki Mode paused');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to pause Loki Mode: ${errorMessage}`);
        logger.error('Failed to pause Loki Mode', error);
    }
}

/**
 * Resume Loki Mode command handler
 */
async function resumeLokiMode(): Promise<void> {
    if (!isPaused) {
        vscode.window.showWarningMessage('Loki Mode is not paused');
        return;
    }

    logger.info('Resuming Loki Mode...');

    try {
        await apiRequest('/resume', 'POST');

        isPaused = false;
        updateStatusBar();
        updateContext();

        vscode.window.showInformationMessage('Loki Mode resumed');
        logger.info('Loki Mode resumed');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to resume Loki Mode: ${errorMessage}`);
        logger.error('Failed to resume Loki Mode', error);
    }
}

/**
 * Show Loki status command handler
 */
async function showStatus(): Promise<void> {
    logger.info('Fetching Loki status...');

    try {
        const status = await apiRequest('/status') as { running?: boolean; paused?: boolean; provider?: string; uptime?: number; tasksCompleted?: number; tasksPending?: number };

        const statusMessage = [
            `Running: ${status.running ? 'Yes' : 'No'}`,
            `Paused: ${status.paused ? 'Yes' : 'No'}`,
            `Provider: ${status.provider || Config.provider}`,
            `Uptime: ${status.uptime || 0}s`,
            `Tasks Completed: ${status.tasksCompleted || 0}`,
            `Tasks Pending: ${status.tasksPending || 0}`
        ].join('\n');

        vscode.window.showInformationMessage(statusMessage, { modal: true });
        logger.info('Status displayed', status);
    } catch (error) {
        const localStatus = [
            `Running: ${isRunning ? 'Yes' : 'No'}`,
            `Paused: ${isPaused ? 'Yes' : 'No'}`,
            `Provider: ${Config.provider}`,
            `API: Not connected`
        ].join('\n');

        vscode.window.showInformationMessage(localStatus, { modal: true });
        logger.warn('Could not fetch remote status, showing local state');
    }
}

/**
 * Inject input command handler
 */
async function injectInput(): Promise<void> {
    if (!isRunning) {
        vscode.window.showWarningMessage('Loki Mode is not running');
        return;
    }

    const input = await vscode.window.showInputBox({
        prompt: 'Enter input to inject into Loki Mode',
        placeHolder: 'Type your message...'
    });

    if (!input) {
        return;
    }

    logger.info('Injecting input...');

    try {
        await apiRequest('/input', 'POST', { input });

        vscode.window.showInformationMessage('Input injected successfully');
        logger.info(`Input injected: ${input.substring(0, 50)}...`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to inject input: ${errorMessage}`);
        logger.error('Failed to inject input', error);
    }
}

/**
 * Show quick pick menu for Loki commands
 */
async function showQuickPick(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
        { label: '$(play) Start Loki Mode', description: 'Start autonomous mode' },
        { label: '$(stop) Stop Loki Mode', description: 'Stop autonomous mode' },
        { label: '$(debug-pause) Pause Loki Mode', description: 'Pause current session' },
        { label: '$(debug-continue) Resume Loki Mode', description: 'Resume paused session' },
        { label: '$(info) Show Status', description: 'Display current status' },
        { label: '$(file) Open PRD', description: 'Open PRD file' },
        { label: '$(terminal) Inject Input', description: 'Send input to Loki Mode' },
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Loki Mode command',
    });

    if (!selected) {
        return;
    }

    switch (selected.label) {
        case '$(play) Start Loki Mode':
            await startLokiMode();
            break;
        case '$(stop) Stop Loki Mode':
            await stopLokiMode();
            break;
        case '$(debug-pause) Pause Loki Mode':
            await pauseLokiMode();
            break;
        case '$(debug-continue) Resume Loki Mode':
            await resumeLokiMode();
            break;
        case '$(info) Show Status':
            await showStatus();
            break;
        case '$(file) Open PRD':
            await openPrd();
            break;
        case '$(terminal) Inject Input':
            await injectInput();
            break;
    }
}

/**
 * Open PRD file command handler
 */
async function openPrd(): Promise<void> {
    let prdPath = Config.prdPath;

    if (!prdPath) {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'PRD Files': ['md', 'txt', 'json'],
                'All Files': ['*']
            },
            title: 'Select PRD File'
        });

        if (result && result.length > 0) {
            prdPath = result[0].fsPath;
        }
    }

    if (prdPath) {
        const doc = await vscode.workspace.openTextDocument(prdPath);
        await vscode.window.showTextDocument(doc);
        logger.info(`Opened PRD file: ${prdPath}`);
    }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
    logger.info('Activating Loki Mode extension...');

    // Initialize API client
    apiClient = new LokiApiClient(Config.apiBaseUrl);

    // Initialize tree providers
    sessionsProvider = new SessionsProvider();
    tasksProvider = new TasksProvider();

    // Initialize webview providers
    chatViewProvider = new ChatViewProvider(context.extensionUri, apiClient);
    logsViewProvider = new LogsViewProvider(context.extensionUri, apiClient);

    // Register tree views
    const sessionsView = vscode.window.createTreeView('loki-sessions', {
        treeDataProvider: sessionsProvider,
        showCollapseAll: false
    });

    const tasksView = vscode.window.createTreeView('loki-tasks', {
        treeDataProvider: tasksProvider,
        showCollapseAll: false
    });

    // Register webview providers
    const chatView = vscode.window.registerWebviewViewProvider(
        ChatViewProvider.viewType,
        chatViewProvider
    );

    const logsView = vscode.window.registerWebviewViewProvider(
        LogsViewProvider.viewType,
        logsViewProvider
    );

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'loki.status';
    statusBarItem.tooltip = 'Loki Mode Status (click for details)';
    updateStatusBar();

    // Register commands
    const commands = [
        vscode.commands.registerCommand('loki.start', startLokiMode),
        vscode.commands.registerCommand('loki.stop', stopLokiMode),
        vscode.commands.registerCommand('loki.pause', pauseLokiMode),
        vscode.commands.registerCommand('loki.resume', resumeLokiMode),
        vscode.commands.registerCommand('loki.status', showStatus),
        vscode.commands.registerCommand('loki.injectInput', injectInput),
        vscode.commands.registerCommand('loki.refreshSessions', () => {
            sessionsProvider.refresh();
            logger.debug('Sessions refreshed');
        }),
        vscode.commands.registerCommand('loki.refreshTasks', () => {
            tasksProvider.refresh();
            pollStatus();
            logger.debug('Tasks refreshed');
        }),
        vscode.commands.registerCommand('loki.showQuickPick', showQuickPick),
        vscode.commands.registerCommand('loki.openPrd', openPrd)
    ];

    // Register configuration change listener
    const configListener = Config.onDidChange((e) => {
        logger.info('Configuration changed');

        if (Config.didChange(e, 'showStatusBar')) {
            updateStatusBar();
        }

        if (Config.didChange(e, 'pollingInterval')) {
            if (pollingInterval) {
                stopPolling();
                startPolling();
            }
        }
    });

    // Add disposables to context
    context.subscriptions.push(
        sessionsView,
        tasksView,
        chatView,
        logsView,
        statusBarItem,
        configListener,
        ...commands
    );

    // Auto-connect if workspace has .loki directory
    if (Config.autoConnect && hasLokiDirectory()) {
        logger.info('Found .loki directory, attempting to connect to API...');
        connectToApi().then(connected => {
            if (connected) {
                vscode.window.showInformationMessage('Connected to Loki Mode API');
            }
        });
    }

    // Initialize context
    updateContext();

    logger.info('Loki Mode extension activated');
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    logger.info('Deactivating Loki Mode extension...');
    stopPolling();
    if (logsViewProvider) {
        logsViewProvider.dispose();
    }
    if (chatViewProvider) {
        chatViewProvider.dispose();
    }
    if (apiClient) {
        apiClient.dispose();
    }
    logger.info('Loki Mode extension deactivated');
    Logger.dispose();
}
