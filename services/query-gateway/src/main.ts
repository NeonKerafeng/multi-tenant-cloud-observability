import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  app.use(
    raw({
      type: ['application/x-ndjson', 'application/ndjson'],
      limit: '5mb',
    }),
  );

  app.use(
    json({
      limit: '2mb',
    }),
  );

  app.use(
    urlencoded({
      extended: true,
      limit: '2mb',
    }),
  );

  await app.listen(process.env.PORT ?? 8080, '0.0.0.0');
}

bootstrap();
