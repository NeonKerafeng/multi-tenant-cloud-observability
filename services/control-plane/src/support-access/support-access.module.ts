import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenantsModule } from '../tenants/tenants.module';

import { SupportAccessController } from './support-access.controller';
import { SupportAccessRepository } from './support-access.repository';
import { SupportAccessService } from './support-access.service';

/**
 * Model C: time-boxed, audited access of platform admins to tenant
 * Grafana orgs. Imported by SyncModule, which needs the repository to
 * compute memberships. (DatabaseService / OutboxRepository come from the
 * global DatabaseModule.)
 */
@Module({
  imports: [
    AuthModule,
    TenantsModule,
  ],

  controllers: [
    SupportAccessController,
  ],

  providers: [
    SupportAccessRepository,
    SupportAccessService,
  ],

  exports: [
    SupportAccessRepository,
  ],
})
export class SupportAccessModule {}
