/**
 * Named error classes used across API routes.
 *
 * Routes throw one of these, and lib/apiResponse.js#fail turns them into a
 * standardised JSON error envelope: { ok:false, error:{ code, message } }
 * with the appropriate HTTP status.
 *
 * Generic Error instances are still handled by fail() but become
 * { code:'INTERNAL', status:500 }.
 */

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name   = 'AppError';
    this.code   = code;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super('VALIDATION', message, 400);
    this.name    = 'ValidationError';
    this.details = details;
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super('AUTH', message, 401);
    this.name = 'AuthError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404);
    this.name = 'NotFoundError';
  }
}

export class RouteError extends AppError {
  constructor(message = 'Routing failed') {
    super('ROUTE', message, 502);
    this.name = 'RouteError';
  }
}

export class CalendarError extends AppError {
  constructor(message) {
    super('CALENDAR', message, 502);
    this.name = 'CalendarError';
  }
}

export class IntentError extends AppError {
  constructor(message) {
    super('INTENT', message, 502);
    this.name = 'IntentError';
  }
}

export class UpstreamError extends AppError {
  constructor(message) {
    super('UPSTREAM', message, 502);
    this.name = 'UpstreamError';
  }
}
