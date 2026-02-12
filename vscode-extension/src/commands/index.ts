import * as vscode from 'vscode';
import { TaskTreeProvider } from '../providers/taskTreeProvider';
import { SessionTreeProvider } from '../providers/sessionTreeProvider';
import { StatusBarManager, showQuickPickMenu } from '../views/statusBarItem';

/**
 * Provider options for starting a session
 * Maps display labels to provider values
 */
const PROVIDER_MAP: Record<string, 'claude' | 'codex' | 'gemini'> = {
    'Claude Code': 'claude',
    'OpenAI Codex': 'codex',
    'Google Gemini': 'gemini'
};

const PROVIDER_OPTIONS: vscode.QuickPickItem[] = [
    {
        label: 'Claude Code',
        description: 'Full features (recommended)'
    },
    {
        label: 'OpenAI Codex',
        description: 'Degraded mode - sequential only'
    },
    {
        label: 'Google Gemini',
        description: 'Degraded mode - sequential only'
    }
];

/**
 * Command handler dependencies
 */
export interface CommandDependencies {
    taskTreeProvider: TaskTreeProvider;
    sessionTreeProvider: SessionTreeProvider;
    statusBarManager: StatusBarManager;
    apiEndpoint: string;
    outputChannel: vscode.OutputChannel;
}

/**
 * Register all Loki Mode commands
 */
export function registerCommands(
    context: vscode.ExtensionContext,
    deps: CommandDependencies
): void {
    const { taskTreeProvider, sessionTreeProvider, statusBarManager, outputChannel } = deps;

    // loki.start - Start a new session
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.start', async () => {
            await startSession(deps);
        })
    );

    // loki.stop - Stop the current session
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.stop', async () => {
            await stopSession(deps);
        })
    );

    // loki.pause - Pause the current session
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.pause', async () => {
            await pauseSession(deps);
        })
    );

    // loki.resume - Resume a paused session
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.resume', async () => {
            await resumeSession(deps);
        })
    );

    // loki.status - Show status notification
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.status', async () => {
            await showStatus(deps);
        })
    );

    // loki.injectInput - Send human input to the session
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.injectInput', async () => {
            await injectInput(deps);
        })
    );

    // loki.refreshTasks - Refresh task and session views
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.refreshTasks', async () => {
            outputChannel.appendLine('Refreshing tasks and session...');
            await Promise.all([
                taskTreeProvider.refresh(),
                sessionTreeProvider.refresh()
            ]);
            const counts = taskTreeProvider.getTaskCounts();
            statusBarManager.setTaskCounts(counts.completed, counts.total);
            vscode.window.showInformationMessage('Loki Mode: Status refreshed');
        })
    );

    // loki.showQuickPick - Show the quick pick menu
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.showQuickPick', async () => {
            const command = await showQuickPickMenu(statusBarManager);
            if (command) {
                vscode.commands.executeCommand(command);
            }
        })
    );

    // loki.openPrd - Open the current PRD file
    context.subscriptions.push(
        vscode.commands.registerCommand('loki.openPrd', async () => {
            const session = sessionTreeProvider.getSession();
            if (session.prdPath) {
                const doc = await vscode.workspace.openTextDocument(session.prdPath);
                await vscode.window.showTextDocument(doc);
            } else {
                vscode.window.showWarningMessage('No PRD file associated with current session');
            }
        })
    );

    outputChannel.appendLine('All Loki Mode commands registered');
}

/**
 * Start a new Loki Mode session
 */
async function startSession(deps: CommandDependencies): Promise<void> {
    const { sessionTreeProvider, statusBarManager, apiEndpoint, outputChannel } = deps;

    // Check if session is already active
    if (sessionTreeProvider.isActive()) {
        const choice = await vscode.window.showWarningMessage(
            'A Loki Mode session is already active. Stop it and start a new one?',
            'Stop and Start',
            'Cancel'
        );
        if (choice !== 'Stop and Start') {
            return;
        }
        await stopSession(deps);
    }

    // Step 1: Select PRD file
    const prdUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
            'PRD Files': ['md', 'txt', 'json'],
            'All Files': ['*']
        },
        title: 'Select PRD File',
        openLabel: 'Select PRD'
    });

    if (!prdUri || prdUri.length === 0) {
        return;
    }

    const prdPath = prdUri[0].fsPath;
    outputChannel.appendLine(`Selected PRD: ${prdPath}`);

    // Step 2: Select provider
    const providerPick = await vscode.window.showQuickPick(
        PROVIDER_OPTIONS,
        {
            placeHolder: 'Select AI Provider',
            title: 'Choose Provider for Loki Mode'
        }
    );

    if (!providerPick) {
        return;
    }

    // Map the label back to the provider value
    const provider = PROVIDER_MAP[providerPick.label] || 'claude';
    outputChannel.appendLine(`Selected provider: ${provider}`);

    // Step 3: Start the session
    try {
        statusBarManager.updateStatus({
            state: 'running',
            phase: 'Starting',
            provider: provider
        });

        const response = await fetch(`${apiEndpoint}/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prd: prdPath,
                provider
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to start session: ${error}`);
        }

        const data = await response.json();
        outputChannel.appendLine(`Session started: ${JSON.stringify(data)}`);

        // Update UI
        await sessionTreeProvider.refresh();
        await deps.taskTreeProvider.refresh();

        vscode.window.showInformationMessage(
            `Loki Mode session started with ${providerPick.label}`
        );

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorCode = (error as { code?: string }).code;
        outputChannel.appendLine(`Error starting session: ${errorMessage} (code: ${errorCode})`);
        statusBarManager.setState('error');

        // Show user-friendly error with action button for connection issues
        if (errorCode === 'CONNECTION_REFUSED' || errorMessage.includes('server is not running')) {
            const action = await vscode.window.showErrorMessage(
                'Loki Mode dashboard server is not running. Start it with "loki start" or "loki dashboard start" first.',
                'Open Terminal',
                'Copy Command'
            );

            if (action === 'Open Terminal') {
                const terminal = vscode.window.createTerminal('Loki Mode Server');
                terminal.show();
                terminal.sendText('loki start || ./autonomy/run.sh');
            } else if (action === 'Copy Command') {
                await vscode.env.clipboard.writeText('loki start');
                vscode.window.showInformationMessage('Command copied: loki start');
            }
        } else {
            vscode.window.showErrorMessage(`Failed to start Loki Mode: ${errorMessage}`);
        }
    }
}

/**
 * Stop the current session
 */
async function stopSession(deps: CommandDependencies): Promise<void> {
    const { sessionTreeProvider, taskTreeProvider, statusBarManager, apiEndpoint, outputChannel } = deps;

    if (!sessionTreeProvider.isActive()) {
        vscode.window.showInformationMessage('No active Loki Mode session to stop');
        return;
    }

    // Confirm stop
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to stop the Loki Mode session?',
        'Stop Session',
        'Cancel'
    );

    if (confirm !== 'Stop Session') {
        return;
    }

    try {
        const response = await fetch(`${apiEndpoint}/stop`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to stop session: ${error}`);
        }

        outputChannel.appendLine('Session stopped');

        // Update UI
        statusBarManager.setState('idle');
        await sessionTreeProvider.refresh();
        await taskTreeProvider.refresh();

        vscode.window.showInformationMessage('Loki Mode session stopped');

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Error stopping session: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to stop session: ${errorMessage}`);
    }
}

/**
 * Pause the current session
 */
async function pauseSession(deps: CommandDependencies): Promise<void> {
    const { sessionTreeProvider, statusBarManager, apiEndpoint, outputChannel } = deps;

    const session = sessionTreeProvider.getSession();
    if (!session.active || session.status !== 'running') {
        vscode.window.showInformationMessage('No running session to pause');
        return;
    }

    try {
        const response = await fetch(`${apiEndpoint}/pause`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to pause session: ${error}`);
        }

        outputChannel.appendLine('Session paused');

        // Update UI
        statusBarManager.setState('paused');
        await sessionTreeProvider.refresh();

        vscode.window.showInformationMessage('Loki Mode session paused');

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Error pausing session: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to pause session: ${errorMessage}`);
    }
}

/**
 * Resume a paused session
 */
async function resumeSession(deps: CommandDependencies): Promise<void> {
    const { sessionTreeProvider, statusBarManager, apiEndpoint, outputChannel } = deps;

    const session = sessionTreeProvider.getSession();
    if (!session.active || session.status !== 'paused') {
        vscode.window.showInformationMessage('No paused session to resume');
        return;
    }

    try {
        const response = await fetch(`${apiEndpoint}/resume`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to resume session: ${error}`);
        }

        outputChannel.appendLine('Session resumed');

        // Update UI
        statusBarManager.setState('running');
        await sessionTreeProvider.refresh();

        vscode.window.showInformationMessage('Loki Mode session resumed');

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Error resuming session: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to resume session: ${errorMessage}`);
    }
}

/**
 * Show detailed status notification
 */
async function showStatus(deps: CommandDependencies): Promise<void> {
    const { sessionTreeProvider, taskTreeProvider, outputChannel } = deps;

    await Promise.all([
        sessionTreeProvider.refresh(),
        taskTreeProvider.refresh()
    ]);

    const session = sessionTreeProvider.getSession();
    const counts = taskTreeProvider.getTaskCounts();

    if (!session.active) {
        vscode.window.showInformationMessage(
            'Loki Mode: No active session. Use "Start Session" to begin.'
        );
        return;
    }

    const formatProvider = (provider: string): string => {
        switch (provider) {
            case 'claude': return 'Claude Code';
            case 'codex': return 'OpenAI Codex';
            case 'gemini': return 'Google Gemini';
            default: return provider;
        }
    };

    const statusLines = [
        `Status: ${session.status}`,
        `Provider: ${formatProvider(session.provider)}`,
        `Phase: ${session.phase}`,
        `Tasks: ${counts.completed}/${counts.total} completed`,
        `In Progress: ${counts.inProgress}`
    ];

    if (session.currentTask) {
        statusLines.push(`Current: ${session.currentTask}`);
    }

    outputChannel.appendLine('Status requested:');
    statusLines.forEach(line => outputChannel.appendLine(`  ${line}`));

    const message = `Loki Mode: ${session.status} - ${session.phase} (${counts.completed}/${counts.total} tasks)`;

    if (session.status === 'error') {
        vscode.window.showErrorMessage(message, 'View Details').then(choice => {
            if (choice === 'View Details') {
                outputChannel.show();
            }
        });
    } else {
        vscode.window.showInformationMessage(message);
    }
}

/**
 * Inject human input into the session
 */
async function injectInput(deps: CommandDependencies): Promise<void> {
    const { sessionTreeProvider, apiEndpoint, outputChannel } = deps;

    if (!sessionTreeProvider.isActive()) {
        vscode.window.showWarningMessage('No active session to send input to');
        return;
    }

    // Show input box for human input
    const input = await vscode.window.showInputBox({
        placeHolder: 'Enter guidance or corrections for the AI...',
        prompt: 'Human Input for Loki Mode',
        title: 'Inject Human Input',
        ignoreFocusOut: true
    });

    if (!input || input.trim() === '') {
        return;
    }

    try {
        const response = await fetch(`${apiEndpoint}/input`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input: input.trim()
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to inject input: ${error}`);
        }

        outputChannel.appendLine(`Human input injected: ${input}`);
        vscode.window.showInformationMessage('Input sent to Loki Mode session');

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Error injecting input: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to send input: ${errorMessage}`);
    }
}
