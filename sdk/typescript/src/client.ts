/**
 * Autonomi SDK - Main Client
 *
 * Core client class for interacting with the Autonomi Control Plane API.
 * Uses Node.js built-in fetch (Node 18+). No external dependencies.
 */

import type {
  ClientOptions,
  Project,
  Task,
  ApiKey,
  AuditEntry,
  AuditQueryParams,
  AuditVerifyResult,
  Run,
  RunEvent,
  Tenant,
} from './types.js';

import {
  AutonomiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from './errors.js';

export class AutonomiClient {
  private baseUrl: string;
  private token?: string;
  private timeout: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.timeout = options.timeout ?? 30000;
  }

  // ------------------------------------------------------------------
  // Private request helper
  // ------------------------------------------------------------------

  async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (params && Object.keys(params).length > 0) {
      const search = new URLSearchParams(params);
      url += `?${search.toString()}`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : 'Network error';
      throw new AutonomiError(msg, 0);
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText = await response.text();

    if (!response.ok) {
      const statusCode = response.status;
      let message = responseText;
      try {
        const parsed = JSON.parse(responseText);
        message = parsed.error || parsed.message || parsed.detail || responseText;
      } catch {
        // use raw text
      }

      switch (statusCode) {
        case 401:
          throw new AuthenticationError(message, responseText);
        case 403:
          throw new ForbiddenError(message, responseText);
        case 404:
          throw new NotFoundError(message, responseText);
        default:
          throw new AutonomiError(message, statusCode, responseText);
      }
    }

    if (responseText.length === 0) {
      return undefined as unknown as T;
    }

    return JSON.parse(responseText) as T;
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  async getStatus(): Promise<Record<string, unknown>> {
    return this._request<Record<string, unknown>>('GET', '/api/status');
  }

  // ------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------

  async listProjects(): Promise<Project[]> {
    return this._request<Project[]>('GET', '/api/projects');
  }

  async getProject(projectId: number): Promise<Project> {
    return this._request<Project>('GET', `/api/projects/${projectId}`);
  }

  async createProject(name: string, description?: string): Promise<Project> {
    const body: Record<string, unknown> = { name };
    if (description !== undefined) {
      body.description = description;
    }
    return this._request<Project>('POST', '/api/projects', body);
  }

  // ------------------------------------------------------------------
  // Tasks
  // ------------------------------------------------------------------

  async listTasks(projectId?: number, status?: string): Promise<Task[]> {
    const params: Record<string, string> = {};
    if (projectId !== undefined) params.project_id = String(projectId);
    if (status !== undefined) params.status = status;
    return this._request<Task[]>('GET', '/api/tasks', undefined, params);
  }

  async getTask(taskId: number): Promise<Task> {
    return this._request<Task>('GET', `/api/tasks/${taskId}`);
  }

  async createTask(projectId: number, title: string, description?: string): Promise<Task> {
    const body: Record<string, unknown> = { project_id: projectId, title };
    if (description !== undefined) {
      body.description = description;
    }
    return this._request<Task>('POST', '/api/tasks', body);
  }

  // ------------------------------------------------------------------
  // API Keys
  // ------------------------------------------------------------------

  async listApiKeys(): Promise<ApiKey[]> {
    return this._request<ApiKey[]>('GET', '/api/v2/api-keys');
  }

  async createApiKey(name: string, role?: string): Promise<ApiKey & { token: string }> {
    const body: Record<string, unknown> = { name };
    if (role !== undefined) {
      body.role = role;
    }
    return this._request<ApiKey & { token: string }>('POST', '/api/v2/api-keys', body);
  }

  async rotateApiKey(identifier: string, gracePeriodHours?: number): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (gracePeriodHours !== undefined) {
      body.grace_period_hours = gracePeriodHours;
    }
    return this._request<Record<string, unknown>>('POST', `/api/v2/api-keys/${identifier}/rotate`, body);
  }

  async deleteApiKey(identifier: string): Promise<void> {
    return this._request<void>('DELETE', `/api/v2/api-keys/${identifier}`);
  }

  // ------------------------------------------------------------------
  // Runs
  // ------------------------------------------------------------------

  async listRuns(projectId?: number, status?: string): Promise<Run[]> {
    const params: Record<string, string> = {};
    if (projectId !== undefined) params.project_id = String(projectId);
    if (status !== undefined) params.status = status;
    return this._request<Run[]>('GET', '/api/v2/runs', undefined, params);
  }

  async getRun(runId: number): Promise<Run> {
    return this._request<Run>('GET', `/api/v2/runs/${runId}`);
  }

  async cancelRun(runId: number): Promise<Run> {
    return this._request<Run>('POST', `/api/v2/runs/${runId}/cancel`);
  }

  async replayRun(runId: number): Promise<Run> {
    return this._request<Run>('POST', `/api/v2/runs/${runId}/replay`);
  }

  async getRunTimeline(runId: number): Promise<RunEvent[]> {
    return this._request<RunEvent[]>('GET', `/api/v2/runs/${runId}/timeline`);
  }

  // ------------------------------------------------------------------
  // Tenants
  // ------------------------------------------------------------------

  async listTenants(): Promise<Tenant[]> {
    return this._request<Tenant[]>('GET', '/api/v2/tenants');
  }

  async getTenant(tenantId: number): Promise<Tenant> {
    return this._request<Tenant>('GET', `/api/v2/tenants/${tenantId}`);
  }

  async createTenant(name: string, description?: string): Promise<Tenant> {
    const body: Record<string, unknown> = { name };
    if (description !== undefined) {
      body.description = description;
    }
    return this._request<Tenant>('POST', '/api/v2/tenants', body);
  }

  async deleteTenant(tenantId: number): Promise<void> {
    return this._request<void>('DELETE', `/api/v2/tenants/${tenantId}`);
  }

  // ------------------------------------------------------------------
  // Audit
  // ------------------------------------------------------------------

  async queryAudit(params?: AuditQueryParams): Promise<AuditEntry[]> {
    const queryParams: Record<string, string> = {};
    if (params?.start_date) queryParams.start_date = params.start_date;
    if (params?.end_date) queryParams.end_date = params.end_date;
    if (params?.action) queryParams.action = params.action;
    if (params?.limit !== undefined) queryParams.limit = String(params.limit);
    return this._request<AuditEntry[]>('GET', '/api/v2/audit', undefined, queryParams);
  }

  async verifyAudit(): Promise<AuditVerifyResult> {
    return this._request<AuditVerifyResult>('GET', '/api/audit/verify');
  }
}
