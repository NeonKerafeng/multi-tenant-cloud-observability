import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GrafanaModule } from '../grafana/grafana.module';
import { KeycloakModule } from '../keycloak/keycloak.module';

import { TenantGrafanaService } from './tenant-grafana.service';
import { TenantRepository } from './tenant.repository';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    AuthModule,
    AgentsModule,
    KeycloakModule,
    GrafanaModule,
  ],

  controllers: [
    TenantsController,
  ],

  providers: [
    TenantsService,
    TenantRepository,
    TenantGrafanaService,
  ],

  exports: [
    TenantRepository,
    TenantGrafanaService,
  ],
})
export class TenantsModule {}
