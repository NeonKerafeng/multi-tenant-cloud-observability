import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module';

import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';

@Module({
  imports: [
    AuthModule,
    AgentsModule,
  ],

  controllers: [
    EnrollmentsController,
  ],

  providers: [
    EnrollmentsService,
  ],
})
export class EnrollmentsModule {}
