/**
 * Autonomi SDK - Audit Log Queries
 *
 * Audit-related operations. These are implemented as methods on AutonomiClient
 * directly (see client.ts). This module re-exports the relevant types and
 * documents the audit management interface for reference.
 *
 * Audit methods on AutonomiClient:
 *   - queryAudit(params?): Promise<AuditEntry[]>
 *   - verifyAudit(): Promise<AuditVerifyResult>
 */

export type { AuditEntry, AuditQueryParams, AuditVerifyResult } from './types.js';
