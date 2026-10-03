/**
 * Autonomi SDK - Error Classes
 *
 * Typed error hierarchy for API error handling.
 */
export declare class AutonomiError extends Error {
    statusCode: number;
    responseBody?: string;
    constructor(message: string, statusCode: number, responseBody?: string);
}
export declare class AuthenticationError extends AutonomiError {
    constructor(message?: string, responseBody?: string);
}
export declare class ForbiddenError extends AutonomiError {
    constructor(message?: string, responseBody?: string);
}
export declare class NotFoundError extends AutonomiError {
    constructor(message?: string, responseBody?: string);
}
/**
 * Raised on 501 or 410: the Control Plane does not serve this legacy route
 * (501 = not backed yet, 410 = retired). No data is fabricated.
 */
export declare class NotAvailableOnControlPlaneError extends AutonomiError {
    constructor(statusCode: number, route: string, responseBody?: string);
}
//# sourceMappingURL=errors.d.ts.map