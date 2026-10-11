import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';

import type { Request, Response } from 'express';

import { DomainError } from './domain-error';
import { UpstreamError } from './upstream-error';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

const HTTP_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'route_not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  503: 'service_unavailable',
};

/**
 * The ONLY place that turns exceptions into HTTP responses.
 * Never echoes upstream bodies or stack traces to the client.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { status, body } = this.toResponse(exception, request);

    if (response.headersSent) {
      // Streaming already started: nothing sensible left to send.
      response.end();
      return;
    }

    response.status(status).json(body);
  }

  toResponse(
    exception: unknown,
    request: Pick<Request, 'requestId' | 'method' | 'originalUrl'>,
  ): { status: number; body: ErrorBody } {
    const requestId = request.requestId;

    if (exception instanceof DomainError) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details === undefined
              ? {}
              : { details: exception.details }),
          },
          requestId,
        },
      };
    }

    if (exception instanceof UpstreamError) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} -> ${exception.service} failed (rid=${requestId ?? '-'}): ${exception.message}`,
      );

      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message:
              exception.status === 503
                ? `${exception.service} is unavailable, retry later`
                : `${exception.service} returned an unexpected response`,
            details: { service: exception.service },
          },
          requestId,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      return {
        status,
        body: {
          error: {
            code: HTTP_CODES[status] ?? 'http_error',
            message: exception.message,
          },
          requestId,
        },
      };
    }

    this.logger.error(
      `${request.method} ${request.originalUrl} failed (rid=${requestId ?? '-'})`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return {
      status: 500,
      body: {
        error: {
          code: 'internal_error',
          message: 'Internal error',
        },
        requestId,
      },
    };
  }
}
