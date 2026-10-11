import { Global, Module } from '@nestjs/common';

import { JwtVerifier } from './auth/jwt-verifier';
import { MetricsService } from './metrics/metrics.service';

/** Process-wide singletons used everywhere. */
@Global()
@Module({
  providers: [JwtVerifier, MetricsService],
  exports: [JwtVerifier, MetricsService],
})
export class CommonModule {}
