/**
 * Autonomi SDK - Tenant Management
 *
 * Tenant-related operations. These are implemented as methods on AutonomiClient
 * directly (see client.ts). This module re-exports the relevant types and
 * documents the tenant management interface for reference.
 *
 * Tenant methods on AutonomiClient:
 *   - listTenants(): Promise<Tenant[]>
 *   - getTenant(tenantId): Promise<Tenant>
 *   - createTenant(name, description?): Promise<Tenant>
 *   - deleteTenant(tenantId): Promise<void>
 */

export type { Tenant } from './types.js';
