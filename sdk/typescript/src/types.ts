/**
 * Autonomi SDK - TypeScript Interfaces
 *
 * Core data types for the Autonomi Control Plane API.
 */

export interface Project {
  id: number;
  name: string;
  description?: string;
  status: string;
  tenant_id?: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description?: string;
  status: string;
  priority: string;
}

export interface Run {
  id: number;
  project_id: number;
  status: string;
  trigger: string;
  config?: Record<string, unknown>;
  started_at: string;
  ended_at?: string;
}

export interface RunEvent {
  id: number;
  run_id: number;
  event_type: string;
  phase?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface Tenant {
  id: number;
  name: string;
  slug: string;
  description?: string;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  role?: string;
  created_at: string;
  expires_at?: string;
  last_used?: string;
}

export interface AuditEntry {
  timestamp: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  user_id?: string;
  success: boolean;
}

export interface AuditQueryParams {
  start_date?: string;
  end_date?: string;
  action?: string;
  limit?: number;
}

export interface AuditVerifyResult {
  valid: boolean;
  entries_checked: number;
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  timeout?: number;
}
