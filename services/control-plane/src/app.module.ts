import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './common/auth/auth.guard';
import { CommonModule } from './common/common.module';
import { PersistenceModule } from './common/db/persistence.module';
import { ErrorFilter } from './common/errors/error.filter';
import { HealthController } from './common/health/health.controller';
import { ConfigModule } from './config/config.module';
import { AgentsModule } from './modules/agents/agents.module';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module';
import { PlatformModule } from './modules/platform/platform.module';
import { SupportAccessModule } from './modules/support-access/support-access.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    PersistenceModule,
    TenantsModule,
    UsersModule,
    AgentsModule,
    EnrollmentsModule,
    SupportAccessModule,
    PlatformModule,
    SyncModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
