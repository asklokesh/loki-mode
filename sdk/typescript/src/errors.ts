/**
 * Autonomi SDK - Error Classes
 *
 * Typed error hierarchy for API error handling.
 */

export class AutonomiError extends Error {
  public statusCode: number;
  public responseBody?: string;

  constructor(message: string, statusCode: number, responseBody?: string) {
    super(message);
    this.name = 'AutonomiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class AuthenticationError extends AutonomiError {
  constructor(message: string = 'Authentication required', responseBody?: string) {
    super(message, 401, responseBody);
    this.name = 'AuthenticationError';
  }
}

export class ForbiddenError extends AutonomiError {
  constructor(message: string = 'Access forbidden', responseBody?: string) {
    super(message, 403, responseBody);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AutonomiError {
  constructor(message: string = 'Resource not found', responseBody?: string) {
    super(message, 404, responseBody);
    this.name = 'NotFoundError';
  }
}
