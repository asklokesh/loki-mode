/**
 * Autonomi SDK - Public API
 *
 * @autonomi/sdk - TypeScript/Node.js SDK for the Autonomi Control Plane API.
 *
 * Usage:
 *   import { AutonomiClient } from '@autonomi/sdk';
 *   const client = new AutonomiClient({ baseUrl: 'http://localhost:57374', token: 'loki_xxx' });
 *   const projects = await client.listProjects();
 */

// Main client
export { AutonomiClient } from './client.js';

// Types
export type {
  ClientOptions,
  Project,
  Task,
  Run,
  RunEvent,
  Tenant,
  ApiKey,
  AuditEntry,
  AuditQueryParams,
  AuditVerifyResult,
} from './types.js';

// Errors
export {
  AutonomiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from './errors.js';
