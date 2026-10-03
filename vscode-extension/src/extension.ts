import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { Config } from './utils/config';
import { Logger, logger } from './utils/logger';
import { ChatViewProvider } from './views/chatViewProvider';
import { LogsViewProvider } from './views/logsViewProvider';
import { MemoryViewProvider } from './views/memoryViewProvider';
import { DashboardWebviewProvider } from './views/dashboardWebview';
import { CheckpointProvider } from './views/checkpointProvider';
import { LokiApiClient } from './api/client';
import { isNotAvailableStatus, createNotAvailableError } from './api/availability';
import { parseStatusResponse, isValidTaskStatus } from './api/validators';
import { LokiEvent, Disposable } from './api/types';
import { getLearningCollector, disposeLearningCollector, LearningCollector, Outcome } from './services/learning-collector';
import { getFileEditMemoryIntegration, disposeFileEditMemoryIntegration, FileEditMemoryIntegration } from './services/memory-integration';

// State tracking
let isRunning = false;
let isPaused = false;
let statusBarItem: vscode.StatusBarItem | undefined;
let statusSubscription: Disposable | undefined;
let learningCollector: LearningCollector | undefined;
let memoryIntegration: FileEditMemoryIntegration | undefined;

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
let checkpointProvider: CheckpointProvider;
let chatViewProvider: ChatViewProvider;
let logsViewProvider: LogsViewProvider;
let memoryViewProvider: MemoryViewProvider;
let dashboardWebviewProvider: DashboardWebviewProvider;
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
 * Get the .loki directory path for the current workspace
 */
function getLokiPath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return path.join(workspaceFolders[0].uri.fsPath, '.loki');
}

/**
 * Check session state from filesystem (fallback when API unavailable).
 * Checks .loki/loki.pid, .loki/session.json, and .loki/PAUSE files.
 */
function getFilesystemState(): { running: boolean; paused: boolean } {
    const lokiPath = getLokiPath();
    if (!lokiPath) {
        return { running: false, paused: false };
    }

    let running = false;

    // Check PID file (run.sh-invoked sessions)
    const pidFile = path.join(lokiPath, 'loki.pid');
    if (fs.existsSync(pidFile)) {
        try {
            const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
                try {
                    process.kill(pid, 0);
                    running = true;
                } catch {
                    // Process not running, stale PID
                }
            }
        } catch {
            // Can't read PID file
        }
    }

    // Check session.json (skill-invoked sessions)
    if (!running) {
        const sessionFile = path.join(lokiPath, 'session.json');
        if (fs.existsSync(sessionFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                if (data.status === 'running') {
                    running = true;
                }
            } catch {
                // Can't parse session file
            }
        }
    }

    // Check PAUSE file
    const paused = running && fs.existsSync(path.join(lokiPath, 'PAUSE'));

    return { running, paused };
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

        if (isNotAvailableStatus(response.status)) {
            throw createNotAvailableError(`${method} ${endpoint}`, response.status);
        }
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
 * Manually refresh status from API (for user-triggered refresh)
 */
async function refreshStatus(): Promise<void> {
    try {
        const rawStatus = await apiRequest('/status');
        const status = parseStatusResponse(rawStatus);

        if (status.running !== undefined) {
            isRunning = status.running;
        }
        if (status.paused !== undefined) {
            isPaused = status.paused;
        }
        updateStatusBar();
        updateContext();

        if (status.tasks && Array.isArray(status.tasks)) {
            const taskItems = status.tasks.map(t => new TaskItem(
                t.title,
                t.id,
                mapTaskStatus(t.status),
                t.description
            ));
            tasksProvider.setTasks(taskItems);
        }
    } catch {
        logger.debug('Manual status refresh failed');
    }
}

/**
 * Map TaskStatus to the subset accepted by TaskItem
 */
function mapTaskStatus(status: string): 'pending' | 'in_progress' | 'completed' {
    if (!isValidTaskStatus(status)) {
        return 'pending';
    }
    // Map 'failed' and 'skipped' to 'completed' for UI display
    if (status === 'failed' || status === 'skipped') {
        return 'completed';
    }
    return status as 'pending' | 'in_progress' | 'completed';
}

/**
 * Handle status events from the API client
 */
function handleStatusEvent(event: LokiEvent): void {
    if (event.type !== 'status') {
        return;
    }

    try {
        const status = parseStatusResponse(event.data);

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
                mapTaskStatus(t.status),
                t.description
            ));
            tasksProvider.setTasks(taskItems);
        }
    } catch {
        // API not available - fall back to filesystem state
        logger.debug('API status unavailable, checking filesystem');
        const fsState = getFilesystemState();
        if (fsState.running !== isRunning) {
            isRunning = fsState.running;
            updateStatusBar();
            updateContext();
        }
        if (fsState.paused !== isPaused) {
            isPaused = fsState.paused;
            updateStatusBar();
            updateContext();
        }
    }
}

/**
 * Start polling the API (via client subscription)
 */
function startPolling(): void {
    if (statusSubscription) {
        return;
    }

    // Subscribe to status events from the API client
    statusSubscription = apiClient.subscribeToEvents(handleStatusEvent);
    logger.info(`Started API polling (interval: ${Config.pollingInterval}ms)`);
}

/**
 * Stop polling the API
 */
function stopPolling(): void {
    if (statusSubscription) {
        statusSubscription.dispose();
        statusSubscription = undefined;
        logger.info('Stopped API polling');
    }
}

/**
 * Ensure the dashboard server is running.
 * Checks health endpoint first; if unreachable, spawns `loki dashboard start`
 * as a detached child process and waits up to 5 seconds for it to become healthy.
 * Returns true if the server is reachable, false otherwise.
 */
async function ensureDashboardRunning(): Promise<boolean> {
    // Check if already running via health endpoint
    try {
        await apiRequest('/health');
        logger.info('Dashboard server is already running');
        return true;
    } catch {
        logger.info('Dashboard server not running, attempting to start...');
    }

    // Spawn the dashboard server in detached mode
    const lokiPath = getLokiPath();
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (lokiPath) {
        env.LOKI_DIR = lokiPath;
    }

    try {
        const child = spawn('loki', ['dashboard', 'start'], {
            detached: true,
            stdio: 'ignore',
            env,
        });

        // Allow the child to outlive the extension process
        child.unref();

        child.on('error', (err) => {
            logger.error('Failed to spawn loki dashboard process', err);
        });

        logger.info('Spawned loki dashboard start process');
    } catch (error) {
        logger.error('Failed to spawn dashboard server', error);
        return false;
    }

    // Poll health endpoint for up to 5 seconds (500ms intervals)
    const maxAttempts = 10;
    const intervalMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        try {
            await apiRequest('/health');
            logger.info(`Dashboard server became healthy after ${attempt * intervalMs}ms`);
            return true;
        } catch {
            logger.debug(`Health check attempt ${attempt}/${maxAttempts} failed`);
        }
    }

    logger.error('Dashboard server did not become healthy within 5 seconds');
    return false;
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
        logger.warn('Could not connect to Loki API - attempting to start dashboard server');
        const started = await ensureDashboardRunning();
        if (started) {
            logger.info('Dashboard server started, connected to Loki API');
            startPolling();
            return true;
        }
        logger.warn('Could not start dashboard server');
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

    // Ensure the dashboard API server is running before making API calls
    const dashboardReady = await ensureDashboardRunning();
    if (!dashboardReady) {
        vscode.window.showErrorMessage('Failed to start Loki dashboard server. Cannot start Loki Mode.');
        logger.error('Dashboard server not available, aborting start');
        return;
    }

    // Track command and start workflow
    learningCollector?.trackCommand('loki.start', ['loki.stop', 'loki.pause']);
    learningCollector?.startWorkflow('loki_session_start');
    learningCollector?.addWorkflowStep('loki_session_start', 'initiate_start');

    // Check for PRD file
    let prdPath = Config.prdPath;

    if (!prdPath) {
        learningCollector?.addWorkflowStep('loki_session_start', 'select_prd');
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
            // Track PRD file selection preference
            learningCollector?.emitUserPreference(
                'prd_file_type',
                path.extname(prdPath),
                ['.md', '.txt', '.json'].filter(ext => ext !== path.extname(prdPath)),
                { prdPath }
            );
        }
    }

    try {
        learningCollector?.addWorkflowStep('loki_session_start', 'api_request');
        await apiRequest('/api/control/start', 'POST', {
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

        // Track provider preference
        learningCollector?.emitUserPreference(
            'provider_choice',
            Config.provider,
            ['claude', 'codex', 'gemini'].filter(p => p !== Config.provider),
            { sessionName }
        );

        vscode.window.showInformationMessage(`Loki Mode started with provider: ${Config.provider}`);
        logger.info(`Loki Mode started (provider: ${Config.provider}, prd: ${prdPath || 'none'})`);

        startPolling();

        // Complete workflow successfully
        learningCollector?.addWorkflowStep('loki_session_start', 'session_active');
        learningCollector?.completeWorkflow('loki_session_start', {
            context: { provider: Config.provider, hasPrd: !!prdPath }
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to start Loki Mode: ${errorMessage}`);
        logger.error('Failed to start Loki Mode', error);

        // Emit error pattern
        learningCollector?.emitErrorPattern(
            'session_start_failed',
            errorMessage,
            {
                stackTrace: error instanceof Error ? error.stack : undefined,
                context: { provider: Config.provider, hasPrd: !!prdPath }
            }
        );

        // Complete workflow with failure
        learningCollector?.completeWorkflow('loki_session_start', { outcome: Outcome.FAILURE });
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
    learningCollector?.trackCommand('loki.stop', ['loki.pause', 'loki.resume']);

    try {
        await apiRequest('/api/control/stop', 'POST');

        isRunning = false;
        isPaused = false;
        updateStatusBar();
        updateContext();

        sessionsProvider.clearSessions();
        tasksProvider.clearTasks();
        stopPolling();

        // Emit success pattern for clean stop
        learningCollector?.emitSuccessPattern(
            'session_stop',
            ['initiate_stop', 'api_request', 'cleanup_ui'],
            { postconditions: ['session_inactive', 'ui_cleared'] }
        );

        vscode.window.showInformationMessage('Loki Mode stopped');
        logger.info('Loki Mode stopped');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to stop Loki Mode: ${errorMessage}`);
        logger.error('Failed to stop Loki Mode', error);

        // Emit error pattern
        learningCollector?.emitErrorPattern(
            'session_stop_failed',
            errorMessage,
            { stackTrace: error instanceof Error ? error.stack : undefined }
        );
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
    learningCollector?.trackCommand('loki.pause', ['loki.stop', 'loki.resume']);

    try {
        await apiRequest('/api/control/pause', 'POST');

        isPaused = true;
        updateStatusBar();
        updateContext();

        learningCollector?.emitSuccessPattern(
            'session_pause',
            ['initiate_pause', 'api_request', 'update_ui'],
            { preconditions: ['session_running'], postconditions: ['session_paused'] }
        );

        vscode.window.showInformationMessage('Loki Mode paused');
        logger.info('Loki Mode paused');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to pause Loki Mode: ${errorMessage}`);
        logger.error('Failed to pause Loki Mode', error);

        learningCollector?.emitErrorPattern(
            'session_pause_failed',
            errorMessage,
            { stackTrace: error instanceof Error ? error.stack : undefined }
        );
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
    learningCollector?.trackCommand('loki.resume', ['loki.stop', 'loki.pause']);

    try {
        await apiRequest('/api/control/resume', 'POST');

        isPaused = false;
        updateStatusBar();
        updateContext();

        learningCollector?.emitSuccessPattern(
            'session_resume',
            ['initiate_resume', 'api_request', 'update_ui'],
            { preconditions: ['session_paused'], postconditions: ['session_running'] }
        );

        vscode.window.showInformationMessage('Loki Mode resumed');
        logger.info('Loki Mode resumed');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to resume Loki Mode: ${errorMessage}`);
        logger.error('Failed to resume Loki Mode', error);

        learningCollector?.emitErrorPattern(
            'session_resume_failed',
            errorMessage,
            { stackTrace: error instanceof Error ? error.stack : undefined }
        );
    }
}

/**
 * Show Loki status command handler
 */
async function showStatus(): Promise<void> {
    logger.info('Fetching Loki status...');
    learningCollector?.trackCommand('loki.status', ['loki.refreshTasks']);

    try {
        const rawStatus = await apiRequest('/status');
        const status = parseStatusResponse(rawStatus);

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

    learningCollector?.trackCommand('loki.injectInput', []);

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

        // Track input injection as a success pattern
        learningCollector?.emitSuccessPattern(
            'input_injection',
            ['open_input_box', 'enter_text', 'submit'],
            {
                context: { inputLength: input.length },
                postconditions: ['input_queued']
            }
        );

        vscode.window.showInformationMessage('Input injected successfully');
        logger.info(`Input injected: ${input.substring(0, 50)}...`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to inject input: ${errorMessage}`);
        logger.error('Failed to inject input', error);

        learningCollector?.emitErrorPattern(
            'input_injection_failed',
            errorMessage,
            { stackTrace: error instanceof Error ? error.stack : undefined }
        );
    }
}

/**
 * Show quick pick menu for Loki commands
 */
async function showQuickPick(): Promise<void> {
    learningCollector?.trackCommand('loki.showQuickPick', []);

    const items: vscode.QuickPickItem[] = [
        { label: '$(play) Start Loki Mode', description: 'Start autonomous mode' },
        { label: '$(stop) Stop Loki Mode', description: 'Stop autonomous mode' },
        { label: '$(debug-pause) Pause Loki Mode', description: 'Pause current session' },
        { label: '$(debug-continue) Resume Loki Mode', description: 'Resume paused session' },
        { label: '$(info) Show Status', description: 'Display current status' },
        { label: '$(file) Open PRD', description: 'Open PRD file' },
        { label: '$(terminal) Inject Input', description: 'Send input to Loki Mode' },
        { label: '$(outline-view-icon) Analyze PRD', description: 'Run loki plan' },
        { label: '$(checklist) Review Code', description: 'Run loki review' },
        { label: '$(book) Onboard Project', description: 'Run loki onboard' },
        { label: '$(pass) CI Quality Gates', description: 'Run loki ci' },
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Loki Mode command',
    });

    if (!selected) {
        return;
    }

    // Track menu selection as user preference
    const allLabels = items.map(i => i.label);
    learningCollector?.emitUserPreference(
        'quick_pick_selection',
        selected.label,
        allLabels.filter(l => l !== selected.label),
        { menuType: 'command_palette' }
    );

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
        case '$(outline-view-icon) Analyze PRD':
            vscode.commands.executeCommand('loki.plan');
            break;
        case '$(checklist) Review Code':
            vscode.commands.executeCommand('loki.review');
            break;
        case '$(book) Onboard Project':
            vscode.commands.executeCommand('loki.onboard');
            break;
        case '$(pass) CI Quality Gates':
            vscode.commands.executeCommand('loki.ci');
            break;
    }
}

/**
 * Open PRD file command handler
 */
async function openPrd(): Promise<void> {
    learningCollector?.trackCommand('loki.openPrd', []);

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

        // Track PRD file open as user preference
        learningCollector?.emitUserPreference(
            'prd_file_opened',
            path.extname(prdPath),
            [],
            { prdPath }
        );
    }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
    logger.info('Activating Loki Mode extension...');

    // Initialize learning collector for signal emission
    learningCollector = getLearningCollector();
    logger.info('Learning collector initialized');

    // Initialize file edit memory integration for episodic memory
    memoryIntegration = getFileEditMemoryIntegration();
    logger.info('File edit memory integration initialized');

    // Initialize API client with configurable polling interval
    apiClient = new LokiApiClient(Config.apiBaseUrl, { pollingInterval: Config.pollingInterval });

    // Initialize tree providers
    sessionsProvider = new SessionsProvider();
    tasksProvider = new TasksProvider();
    checkpointProvider = new CheckpointProvider();

    // Initialize webview providers
    chatViewProvider = new ChatViewProvider(context.extensionUri, apiClient);
    logsViewProvider = new LogsViewProvider(context.extensionUri, apiClient);
    // TODO: Remove MemoryViewProvider in v6.0.0 - deprecated in favor of dashboard Memory tab
    memoryViewProvider = new MemoryViewProvider(context.extensionUri, apiClient);
    dashboardWebviewProvider = new DashboardWebviewProvider(context.extensionUri, apiClient);

    // Register tree views
    const sessionsView = vscode.window.createTreeView('loki-sessions', {
        treeDataProvider: sessionsProvider,
        showCollapseAll: false
    });

    const tasksView = vscode.window.createTreeView('loki-tasks', {
        treeDataProvider: tasksProvider,
        showCollapseAll: false
    });

    const checkpointsView = vscode.window.createTreeView('loki-checkpoints', {
        treeDataProvider: checkpointProvider,
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

    // TODO: Remove memoryView registration in v6.0.0 - deprecated in favor of dashboard Memory tab
    const memoryView = vscode.window.registerWebviewViewProvider(
        MemoryViewProvider.viewType,
        memoryViewProvider
    );

    const dashboardView = vscode.window.registerWebviewViewProvider(
        DashboardWebviewProvider.viewType,
        dashboardWebviewProvider
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
        vscode.commands.registerCommand('loki.refreshTasks', async () => {
            tasksProvider.refresh();
            await refreshStatus();
            logger.debug('Tasks refreshed');
        }),
        vscode.commands.registerCommand('loki.showQuickPick', showQuickPick),
        vscode.commands.registerCommand('loki.openPrd', openPrd),
        vscode.commands.registerCommand('loki.openDashboard', () => {
            // Focus the dashboard view in the sidebar
            vscode.commands.executeCommand('workbench.view.extension.loki-mode');
            logger.info('Dashboard opened');
        }),
        vscode.commands.registerCommand('loki.refreshCheckpoints', async () => {
            await checkpointProvider.refresh();
            logger.debug('Checkpoints refreshed');
        }),
        vscode.commands.registerCommand('loki.createCheckpoint', async () => {
            await checkpointProvider.createCheckpoint();
        }),
        vscode.commands.registerCommand('loki.rollbackCheckpoint', async (item) => {
            await checkpointProvider.rollbackCheckpoint(item);
        }),
        vscode.commands.registerCommand('loki.plan', async () => {
            const prdUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'PRD Files': ['md', 'txt', 'json'],
                    'All Files': ['*']
                },
                title: 'Select PRD File to Analyze'
            });
            const prdArg = prdUri && prdUri.length > 0 ? ` "${prdUri[0].fsPath}"` : '';
            const terminal = vscode.window.createTerminal('Loki Plan');
            terminal.show();
            terminal.sendText(`loki plan${prdArg}`);
            logger.info(`Running loki plan${prdArg}`);
        }),
        vscode.commands.registerCommand('loki.review', () => {
            const terminal = vscode.window.createTerminal('Loki Review');
            terminal.show();
            terminal.sendText('loki review');
            logger.info('Running loki review');
        }),
        vscode.commands.registerCommand('loki.onboard', () => {
            const terminal = vscode.window.createTerminal('Loki Onboard');
            terminal.show();
            terminal.sendText('loki onboard');
            logger.info('Running loki onboard');
        }),
        vscode.commands.registerCommand('loki.ci', () => {
            const terminal = vscode.window.createTerminal('Loki CI');
            terminal.show();
            terminal.sendText('loki ci');
            logger.info('Running loki ci');
        })
    ];

    // Register configuration change listener
    const configListener = Config.onDidChange((e) => {
        logger.info('Configuration changed');

        if (Config.didChange(e, 'showStatusBar')) {
            updateStatusBar();
        }

        if (Config.didChange(e, 'pollingInterval')) {
            if (statusSubscription) {
                stopPolling();
                startPolling();
            }
        }

        if (Config.didChange(e, 'apiPort') || Config.didChange(e, 'apiHost')) {
            logger.info(`API endpoint changed to ${Config.apiBaseUrl}`);
            stopPolling();
            apiClient.dispose();
            apiClient = new LokiApiClient(Config.apiBaseUrl, { pollingInterval: Config.pollingInterval });
            startPolling();
        }
    });

    // Add disposables to context
    context.subscriptions.push(
        sessionsView,
        tasksView,
        checkpointsView,
        chatView,
        logsView,
        memoryView,
        dashboardView,
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
    if (memoryViewProvider) {
        memoryViewProvider.dispose();
    }
    if (dashboardWebviewProvider) {
        dashboardWebviewProvider.dispose();
    }
    if (apiClient) {
        apiClient.dispose();
    }
    // Dispose learning collector
    disposeLearningCollector();
    // Dispose file edit memory integration
    disposeFileEditMemoryIntegration();
    logger.info('Loki Mode extension deactivated');
    Logger.dispose();
}
