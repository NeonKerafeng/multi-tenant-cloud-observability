import { HttpException, NotFoundException } from '@nestjs/common';

import { ConflictError, InvalidError } from './domain-error';
import { ErrorFilter } from './error.filter';
import {
  UpstreamBadResponseError,
  UpstreamUnavailableError,
} from './upstream-error';

const request = { requestId: 'rid-1', method: 'GET', originalUrl: '/x' };

describe('ErrorFilter.toResponse', () => {
  const filter = new ErrorFilter();

  it('domain errors keep status, code, message and details', () => {
    expect(
      filter.toResponse(
        new InvalidError('validation_failed', 'bad', [
          { field: 'x', messages: ['m'] },
        ]),
        request,
      ),
    ).toEqual({
      status: 400,
      body: {
        error: {
          code: 'validation_failed',
          message: 'bad',
          details: [{ field: 'x', messages: ['m'] }],
        },
        requestId: 'rid-1',
      },
    });

    expect(
      filter.toResponse(new ConflictError('username_taken', 'x'), request)
        .status,
    ).toBe(409);
  });

  it('upstream errors never leak the upstream body', () => {
    const unavailable = filter.toResponse(
      new UpstreamUnavailableError(
        'keycloak',
        null,
        'POST /users: timeout SECRET',
      ),
      request,
    );

    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe('upstream_unavailable');
    expect(JSON.stringify(unavailable.body)).not.toContain('SECRET');

    const bad = filter.toResponse(
      new UpstreamBadResponseError('grafana', 400, 'body with SECRET'),
      request,
    );

    expect(bad.status).toBe(502);
    expect(bad.body.error).toMatchObject({
      code: 'upstream_bad_response',
      details: { service: 'grafana' },
    });
    expect(JSON.stringify(bad.body)).not.toContain('SECRET');
  });

  it('Nest HTTP exceptions map to stable codes', () => {
    expect(
      filter.toResponse(new NotFoundException('Cannot GET /nope'), request).body
        .error.code,
    ).toBe('route_not_found');
    expect(
      filter.toResponse(new HttpException('x', 418), request).body.error.code,
    ).toBe('http_error');
  });

  it('unknown errors are 500 without details', () => {
    const response = filter.toResponse(
      new Error('db password is hunter2'),
      request,
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'internal_error',
      message: 'Internal error',
    });
  });
});
