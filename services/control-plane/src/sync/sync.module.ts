import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GrafanaModule } from '../grafana/grafana.module';
import { KeycloakModule } from '../keycloak/keycloak.module';
import { SupportAccessModule } from '../support-access/support-access.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';

import { GrafanaSyncService } from './grafana-sync.service';
import { MetricsController } from './metrics.controller';
import { OutboxWorker } from './outbox.worker';
import { PlatformBootstrapService } from './platform-bootstrap.service';
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
    KeycloakModule,
    SupportAccessModule,
    TenantsModule,
    UsersModule,
  ],

  controllers: [
    MetricsController,
    SyncController,
  ],

  providers: [
    GrafanaSyncService,
    OutboxWorker,
    PlatformBootstrapService,
    ResyncService,
  ],
})
export class SyncModule {}
