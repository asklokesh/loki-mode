/**
 * Control Plane availability helpers.
 *
 * The legacy dashboard (port 57374) is being replaced by the Control Plane.
 * The Control Plane shim answers 501 for a feature it cannot back yet and 410
 * for a retired one. Clients must report that honestly and never fabricate data.
 */

export const NOT_AVAILABLE_TEXT = 'not available on the Control Plane';
export const NOT_AVAILABLE_CODE = 'NOT_AVAILABLE_ON_CONTROL_PLANE';

export function isNotAvailableStatus(status: number | undefined): boolean {
    return status === 501 || status === 410;
}

export interface NotAvailableError extends Error {
    code: typeof NOT_AVAILABLE_CODE;
    statusCode: number;
}

export function createNotAvailableError(feature: string, status: number): NotAvailableError {
    const error = new Error(`${feature}: ${NOT_AVAILABLE_TEXT}`) as NotAvailableError;
    error.name = 'NotAvailableOnControlPlaneError';
    error.code = NOT_AVAILABLE_CODE;
    error.statusCode = status;
    return error;
}

export function isNotAvailableError(error: unknown): error is NotAvailableError {
    return error instanceof Error && (error as { code?: string }).code === NOT_AVAILABLE_CODE;
}
