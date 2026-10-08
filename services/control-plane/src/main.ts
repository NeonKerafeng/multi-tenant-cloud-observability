import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /*
   * SIGTERM -> onModuleDestroy: the outbox worker, resync and support-access
   * timers stop at once. Without this, node (PID 1 in the container) ignores
   * SIGTERM and an OLD pod keeps processing outbox events with old logic for
   * the whole grace period of a rolling update.
   */
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
