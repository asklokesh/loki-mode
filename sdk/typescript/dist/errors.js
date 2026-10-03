"use strict";
/**
 * Autonomi SDK - Error Classes
 *
 * Typed error hierarchy for API error handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotAvailableOnControlPlaneError = exports.NotFoundError = exports.ForbiddenError = exports.AuthenticationError = exports.AutonomiError = void 0;
class AutonomiError extends Error {
    statusCode;
    responseBody;
    constructor(message, statusCode, responseBody) {
        super(message);
        this.name = 'AutonomiError';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }
}
exports.AutonomiError = AutonomiError;
class AuthenticationError extends AutonomiError {
    constructor(message = 'Authentication required', responseBody) {
        super(message, 401, responseBody);
        this.name = 'AuthenticationError';
    }
}
exports.AuthenticationError = AuthenticationError;
class ForbiddenError extends AutonomiError {
    constructor(message = 'Access forbidden', responseBody) {
        super(message, 403, responseBody);
        this.name = 'ForbiddenError';
    }
}
exports.ForbiddenError = ForbiddenError;
class NotFoundError extends AutonomiError {
    constructor(message = 'Resource not found', responseBody) {
        super(message, 404, responseBody);
        this.name = 'NotFoundError';
    }
}
exports.NotFoundError = NotFoundError;
/**
 * Raised on 501 or 410: the Control Plane does not serve this legacy route
 * (501 = not backed yet, 410 = retired). No data is fabricated.
 */
class NotAvailableOnControlPlaneError extends AutonomiError {
    constructor(statusCode, route, responseBody) {
        super(`HTTP ${statusCode}: not available on the Control Plane (${route})`, statusCode, responseBody);
        this.name = 'NotAvailableOnControlPlaneError';
    }
}
exports.NotAvailableOnControlPlaneError = NotAvailableOnControlPlaneError;
//# sourceMappingURL=errors.js.map