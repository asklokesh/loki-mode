/**
 * Loki Mode Checkpoint Tree View Provider
 * Displays checkpoint history, supports creation and rollback.
 *
 * API endpoints:
 *   GET  /api/checkpoints              - List checkpoints
 *   POST /api/checkpoints              - Create checkpoint (body: { message })
 *   POST /api/checkpoints/{id}/rollback - Rollback to checkpoint
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { Config } from '../utils/config';
import { isNotAvailableStatus, isNotAvailableError, createNotAvailableError } from '../api/availability';

/**
 * Checkpoint data returned by the API
 */
interface Checkpoint {
    id: string;
    created_at: string;
    git_sha: string;
    message: string;
    files: string[];
}

/**
 * Tree item representing a single checkpoint
 */
class CheckpointItem extends vscode.TreeItem {
    constructor(
        public readonly checkpoint: Checkpoint
    ) {
        super(
            checkpoint.message || checkpoint.id,
            vscode.TreeItemCollapsibleState.None
        );

        const shortSha = checkpoint.git_sha
            ? checkpoint.git_sha.substring(0, 7)
            : 'no-sha';
        const relativeTime = CheckpointItem.formatRelativeTime(checkpoint.created_at);

        this.description = `${shortSha} - ${relativeTime}`;
        this.tooltip = [
            `ID: ${checkpoint.id}`,
            `Message: ${checkpoint.message || '(none)'}`,
            `SHA: ${checkpoint.git_sha || 'unknown'}`,
            `Created: ${checkpoint.created_at}`,
            `Files: ${Array.isArray(checkpoint.files) ? checkpoint.files.join(', ') : 'none'}`,
        ].join('\n');

        this.iconPath = new vscode.ThemeIcon('git-commit');
        this.contextValue = 'checkpoint';
    }

    /**
     * Format an ISO timestamp as a human-readable relative time string
     */
    private static formatRelativeTime(isoTimestamp: string): string {
        try {
            const then = new Date(isoTimestamp).getTime();
            const now = Date.now();
            const diffMs = now - then;

            if (diffMs < 0) {
                return 'just now';
            }

            const seconds = Math.floor(diffMs / 1000);
            if (seconds < 60) {
                return `${seconds}s ago`;
            }

            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) {
                return `${minutes}m ago`;
            }

            const hours = Math.floor(minutes / 60);
            if (hours < 24) {
                return `${hours}h ago`;
            }

            const days = Math.floor(hours / 24);
            return `${days}d ago`;
        } catch {
            return isoTimestamp;
        }
    }
}

/**
 * Tree data provider for Loki checkpoints
 */
export class CheckpointProvider implements vscode.TreeDataProvider<CheckpointItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<CheckpointItem | undefined | null | void> =
        new vscode.EventEmitter<CheckpointItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CheckpointItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private checkpoints: CheckpointItem[] = [];

    /**
     * Refresh the tree view by re-fetching checkpoints from the API
     */
    async refresh(): Promise<void> {
        try {
            const data = await this.apiGet<Checkpoint[]>('/api/checkpoints');
            if (Array.isArray(data)) {
                this.checkpoints = data.map(cp => new CheckpointItem(cp));
            }
        } catch (error) {
            if (isNotAvailableError(error)) {
                // Honest degrade: the Control Plane has no checkpoint API. Show nothing, never stale or invented data.
                this.checkpoints = [];
                logger.info(`Checkpoints ${error.message}`);
            } else {
                logger.debug('Failed to fetch checkpoints', error);
                // Keep existing data on failure so the view does not flash empty
            }
        }
        this._onDidChangeTreeData.fire();
    }

    /**
     * Create a new checkpoint via the API
     */
    async createCheckpoint(): Promise<void> {
        const message = await vscode.window.showInputBox({
            prompt: 'Enter a message for this checkpoint',
            placeHolder: 'e.g. Before refactoring auth module',
        });

        // User pressed Escape
        if (message === undefined) {
            return;
        }

        try {
            await this.apiPost('/api/checkpoints', { message });
            vscode.window.showInformationMessage(`Checkpoint created${message ? ': ' + message : ''}`);
            logger.info(`Checkpoint created: ${message || '(no message)'}`);
            await this.refresh();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to create checkpoint: ${errorMessage}`);
            logger.error('Failed to create checkpoint', error);
        }
    }

    /**
     * Rollback to a specific checkpoint (with confirmation).
     * Accepts the tree item passed by VS Code command handler.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rollbackCheckpoint(item: any): Promise<void> {
        const checkpoint: Checkpoint | undefined = item?.checkpoint;
        if (!checkpoint) {
            return;
        }

        const label = checkpoint.message || checkpoint.id;
        const sha = checkpoint.git_sha
            ? ` (${checkpoint.git_sha.substring(0, 7)})`
            : '';

        const confirm = await vscode.window.showWarningMessage(
            `Rollback to checkpoint "${label}"${sha}? This will restore saved state files.`,
            { modal: true },
            'Rollback'
        );

        if (confirm !== 'Rollback') {
            return;
        }

        try {
            await this.apiPost(`/api/checkpoints/${checkpoint.id}/rollback`);
            vscode.window.showInformationMessage(`Rolled back to checkpoint: ${label}`);
            logger.info(`Rolled back to checkpoint: ${checkpoint.id}`);
            await this.refresh();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to rollback: ${errorMessage}`);
            logger.error('Failed to rollback checkpoint', error);
        }
    }

    // =========================================================================
    // TreeDataProvider interface
    // =========================================================================

    getTreeItem(element: CheckpointItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<CheckpointItem[]> {
        return Promise.resolve(this.checkpoints);
    }

    // =========================================================================
    // HTTP helpers (mirrors apiRequest pattern in extension.ts)
    // =========================================================================

    private async apiGet<T>(endpoint: string): Promise<T> {
        const url = `${Config.apiBaseUrl}${endpoint}`;
        logger.debug(`Checkpoint API GET: ${url}`);

        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        if (isNotAvailableStatus(response.status)) {
            throw createNotAvailableError(`Checkpoints (${endpoint})`, response.status);
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json() as T;
    }

    private async apiPost(endpoint: string, body?: unknown): Promise<unknown> {
        const url = `${Config.apiBaseUrl}${endpoint}`;
        logger.debug(`Checkpoint API POST: ${url}`);

        const options: RequestInit = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (isNotAvailableStatus(response.status)) {
            throw createNotAvailableError(`Checkpoints (${endpoint})`, response.status);
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
            return await response.json();
        }

        return {};
    }
}
