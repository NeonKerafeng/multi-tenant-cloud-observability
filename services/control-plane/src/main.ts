import './common/http/request-context';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { RequestContextMiddleware } from './common/http/request-context.middleware';
import { createValidationPipe } from './common/http/validation';
import { MetricsService } from './common/metrics/metrics.service';
import { AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Before any route: request id, access log, HTTP histogram.
  const requestContext = new RequestContextMiddleware(app.get(MetricsService));
  app.use(requestContext.use.bind(requestContext));

  app.useGlobalPipes(createValidationPipe());

  /*
   * SIGTERM -> onModuleDestroy: the outbox worker, resync and sweeper
   * stop at once. Without it, node (PID 1) ignores SIGTERM and an OLD pod
   * keeps processing outbox events for the whole grace period.
   */
  app.enableShutdownHooks();

  await app.listen(app.get(AppConfig).port);
}

void bootstrap();
