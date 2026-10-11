import { ValidationPipe, type ValidationError } from '@nestjs/common';

import { InvalidError } from '../errors/domain-error';

export interface FieldProblem {
  field: string;
  messages: string[];
}

export function flattenValidationErrors(
  errors: ValidationError[],
  parent = '',
): FieldProblem[] {
  const problems: FieldProblem[] = [];

  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;

    if (error.constraints) {
      problems.push({
        field,
        messages: Object.values(error.constraints),
      });
    }

    if (error.children && error.children.length > 0) {
      problems.push(...flattenValidationErrors(error.children, field));
    }
  }

  return problems;
}

/** Global pipe: DTO classes + class-validator; unknown fields rejected. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new InvalidError(
        'validation_failed',
        'Request validation failed',
        flattenValidationErrors(errors),
      ),
  });
}

/** For DTO @Transform: trims strings, leaves anything else as is. */
export function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** For DTO @Transform: trims + lowercases strings. */
export function trimLower({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export const TENANT_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
