import type { INestApplication } from '@nestjs/common';

import { serveOpenApi } from './common/http/openapi';
import { RequestContextMiddleware } from './common/http/request-context.middleware';
import { createValidationPipe } from './common/http/validation';
import { MetricsService } from './common/metrics/metrics.service';

/** Prefix of every API route (CLAUDE.md §18.5.1). */
export const API_PREFIX = 'api/v1';

/** Routes outside the prefix: probes and the Prometheus scrape. */
export const UNPREFIXED_ROUTES = ['healthz', 'readyz', 'metrics'];

/**
 * Everything main.ts applies to the app, shared with the HTTP tests so they
 * exercise exactly the production setup.
 */
export function configureApp(app: INestApplication): void {
  // Before any route: request id, access log, HTTP histogram.
  const requestContext = new RequestContextMiddleware(app.get(MetricsService));
  app.use(requestContext.use.bind(requestContext));

  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  app.useGlobalPipes(createValidationPipe());

  serveOpenApi(app);
}
