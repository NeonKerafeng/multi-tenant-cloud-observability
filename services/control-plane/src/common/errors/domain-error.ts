/**
 * Business errors. The ErrorFilter turns them into
 * `{ error: { code, message, details? }, requestId }` with `status`.
 * `code` is a stable machine-readable string (see CLAUDE.md §18.3.2).
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidError extends DomainError {
  readonly status = 400;
}

export class UnauthenticatedError extends DomainError {
  readonly status = 401;

  constructor(message = 'Missing or invalid access token') {
    super('unauthenticated', message);
  }
}

export class ForbiddenError extends DomainError {
  readonly status = 403;
}

export class NotFoundError extends DomainError {
  readonly status = 404;
}

export class ConflictError extends DomainError {
  readonly status = 409;
}

export class GoneError extends DomainError {
  readonly status = 410;
}

export class TooManyRequestsError extends DomainError {
  readonly status = 429;
}
