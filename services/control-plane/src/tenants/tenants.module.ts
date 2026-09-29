import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { KeycloakModule } from '../keycloak/keycloak.module';

import { TenantRepository } from './tenant.repository';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    AuthModule,
    AgentsModule,
    KeycloakModule,
  ],

  controllers: [
    TenantsController,
  ],

  providers: [
    TenantsService,
    TenantRepository,
  ],
})
export class TenantsModule {}
