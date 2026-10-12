import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';

import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';
import { ExchangeRateLimiter } from './exchange-rate-limiter';

@Module({
  imports: [AgentsModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService, ExchangeRateLimiter],
})
export class EnrollmentsModule {}
