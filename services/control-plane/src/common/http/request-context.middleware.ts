import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';

import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { MetricsService } from '../metrics/metrics.service';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Probes and scrapes: no access log line, no histogram sample. */
const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * X-Request-Id in/out, one access-log line per request, and the HTTP
 * duration histogram (labelled with the route TEMPLATE).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');

    req.requestId =
      incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();

    res.setHeader('X-Request-Id', req.requestId);

    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];

      if (QUIET_PATHS.has(path)) {
        return;
      }

      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeTemplate(req);

      this.metrics.httpDuration.observe(
        {
          method: req.method,
          route,
          status_code: String(res.statusCode),
        },
        seconds,
      );

      this.logger.log(
        `${req.method} ${route} ${res.statusCode} ${Math.round(seconds * 1000)}ms rid=${req.requestId} actor=${req.actor?.username ?? '-'}`,
      );
    });

    next();
  }
}

function routeTemplate(req: Request): string {
  const route: unknown = (req as { route?: unknown }).route;

  if (
    typeof route === 'object' &&
    route !== null &&
    'path' in route &&
    typeof route.path === 'string'
  ) {
    return `${req.baseUrl}${route.path}`;
  }

  return 'unmatched';
}
