import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GrafanaModule } from '../grafana/grafana.module';
import { SupportAccessModule } from '../support-access/support-access.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';

import { GrafanaSyncService } from './grafana-sync.service';
import { OutboxWorker } from './outbox.worker';
import { ResyncService } from './resync.service';
import { SyncController } from './sync.controller';

/**
 * Mirrors the control-plane DB (source of truth) into Grafana:
 * transactional outbox -> OutboxWorker -> GrafanaSyncService,
 * plus a slow ResyncService safety net. Support-access grants (model C)
 * feed the platform admins' desired memberships.
 * (OutboxRepository / UserRepository come from the global DatabaseModule.)
 */
@Module({
  imports: [
    AuthModule,
    GrafanaModule,
    SupportAccessModule,
    TenantsModule,
    UsersModule,
  ],

  controllers: [
    SyncController,
  ],

  providers: [
    GrafanaSyncService,
    OutboxWorker,
    ResyncService,
  ],
})
export class SyncModule {}
