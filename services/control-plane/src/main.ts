import './common/http/request-context';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // LOG_LEVEL (default log): debug lines (e.g. retired Grafana orgs that
  // still cannot be deleted, rejected tokens) only with LOG_LEVEL=debug.
  app.useLogger(app.get(AppConfig).logLevels);

  configureApp(app);

  /*
   * SIGTERM -> onModuleDestroy: the outbox worker, resync and sweeper
   * stop at once. Without it, node (PID 1) ignores SIGTERM and an OLD pod
   * keeps processing outbox events for the whole grace period.
   */
  app.enableShutdownHooks();

  await app.listen(app.get(AppConfig).port);
}

void bootstrap();
