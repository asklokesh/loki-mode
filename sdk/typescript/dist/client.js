"use strict";
/**
 * Autonomi SDK - Main Client
 *
 * Core client class for interacting with the Autonomi Control Plane API.
 * Uses Node.js built-in fetch (Node 18+). No external dependencies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutonomiClient = void 0;
const errors_js_1 = require("./errors.js");
class AutonomiClient {
    baseUrl;
    token;
    timeout;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/$/, '');
        this.token = options.token;
        this.timeout = options.timeout ?? 30000;
    }
    // ------------------------------------------------------------------
    // Private request helper
    // ------------------------------------------------------------------
    async _request(method, path, body, params) {
        let url = `${this.baseUrl}${path}`;
        if (params && Object.keys(params).length > 0) {
            const search = new URLSearchParams(params);
            url += `?${search.toString()}`;
        }
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body != null ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        }
        catch (err) {
            clearTimeout(timeoutId);
            const msg = err instanceof Error ? err.message : 'Network error';
            throw new errors_js_1.AutonomiError(msg, 0);
        }
        finally {
            clearTimeout(timeoutId);
        }
        const responseText = await response.text();
        if (!response.ok) {
            const statusCode = response.status;
            let message = responseText;
            try {
                const parsed = JSON.parse(responseText);
                message = parsed.error || parsed.message || parsed.detail || responseText;
            }
            catch {
                // use raw text
            }
            switch (statusCode) {
                case 401:
                    throw new errors_js_1.AuthenticationError(message, responseText);
                case 403:
                    throw new errors_js_1.ForbiddenError(message, responseText);
                case 404:
                    throw new errors_js_1.NotFoundError(message, responseText);
                case 410:
                case 501:
                    throw new errors_js_1.NotAvailableOnControlPlaneError(statusCode, `${method} ${path}`, responseText);
                default:
                    throw new errors_js_1.AutonomiError(message, statusCode, responseText);
            }
        }
        if (responseText.length === 0) {
            return undefined;
        }
        return JSON.parse(responseText);
    }
    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------
    async getStatus() {
        return this._request('GET', '/api/status');
    }
    // ------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------
    async listProjects() {
        return this._request('GET', '/api/projects');
    }
    async getProject(projectId) {
        return this._request('GET', `/api/projects/${projectId}`);
    }
    async createProject(name, description) {
        const body = { name };
        if (description !== undefined) {
            body.description = description;
        }
        return this._request('POST', '/api/projects', body);
    }
    // ------------------------------------------------------------------
    // Tasks
    // ------------------------------------------------------------------
    async listTasks(projectId, status) {
        const params = {};
        if (projectId !== undefined)
            params.project_id = String(projectId);
        if (status !== undefined)
            params.status = status;
        return this._request('GET', '/api/tasks', undefined, params);
    }
    async getTask(taskId) {
        return this._request('GET', `/api/tasks/${taskId}`);
    }
    async createTask(projectId, title, description) {
        const body = { project_id: projectId, title };
        if (description !== undefined) {
            body.description = description;
        }
        return this._request('POST', '/api/tasks', body);
    }
    // ------------------------------------------------------------------
    // API Keys
    // ------------------------------------------------------------------
    async listApiKeys() {
        return this._request('GET', '/api/v2/api-keys');
    }
    async createApiKey(name, role) {
        const body = { name };
        if (role !== undefined) {
            body.role = role;
        }
        return this._request('POST', '/api/v2/api-keys', body);
    }
    async rotateApiKey(identifier, gracePeriodHours) {
        const body = {};
        if (gracePeriodHours !== undefined) {
            body.grace_period_hours = gracePeriodHours;
        }
        return this._request('POST', `/api/v2/api-keys/${identifier}/rotate`, body);
    }
    async deleteApiKey(identifier) {
        return this._request('DELETE', `/api/v2/api-keys/${identifier}`);
    }
    // ------------------------------------------------------------------
    // Runs
    // ------------------------------------------------------------------
    async listRuns(projectId, status) {
        const params = {};
        if (projectId !== undefined)
            params.project_id = String(projectId);
        if (status !== undefined)
            params.status = status;
        return this._request('GET', '/api/v2/runs', undefined, params);
    }
    async getRun(runId) {
        return this._request('GET', `/api/v2/runs/${runId}`);
    }
    async cancelRun(runId) {
        return this._request('POST', `/api/v2/runs/${runId}/cancel`);
    }
    async replayRun(runId) {
        return this._request('POST', `/api/v2/runs/${runId}/replay`);
    }
    async getRunTimeline(runId) {
        return this._request('GET', `/api/v2/runs/${runId}/timeline`);
    }
    // ------------------------------------------------------------------
    // Tenants
    // ------------------------------------------------------------------
    async listTenants() {
        return this._request('GET', '/api/v2/tenants');
    }
    async getTenant(tenantId) {
        return this._request('GET', `/api/v2/tenants/${tenantId}`);
    }
    async createTenant(name, description) {
        const body = { name };
        if (description !== undefined) {
            body.description = description;
        }
        return this._request('POST', '/api/v2/tenants', body);
    }
    async deleteTenant(tenantId) {
        return this._request('DELETE', `/api/v2/tenants/${tenantId}`);
    }
    // ------------------------------------------------------------------
    // Audit
    // ------------------------------------------------------------------
    async queryAudit(params) {
        const queryParams = {};
        if (params?.start_date)
            queryParams.start_date = params.start_date;
        if (params?.end_date)
            queryParams.end_date = params.end_date;
        if (params?.action)
            queryParams.action = params.action;
        if (params?.limit !== undefined)
            queryParams.limit = String(params.limit);
        return this._request('GET', '/api/v2/audit', undefined, queryParams);
    }
    async verifyAudit() {
        return this._request('GET', '/api/audit/verify');
    }
}
exports.AutonomiClient = AutonomiClient;
//# sourceMappingURL=client.js.map