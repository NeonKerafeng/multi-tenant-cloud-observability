import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AgentsModule } from './agents/agents.module';
import { DatabaseModule } from './database/database.module';
import { EnrollmentsModule } from './enrollments/enrollments.module';
import { KeycloakModule } from './keycloak/keycloak.module';
import { SyncModule } from './sync/sync.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    DatabaseModule,
    KeycloakModule,
    AgentsModule,
    EnrollmentsModule,
    TenantsModule,
    UsersModule,
    SyncModule,
  ],
})
export class AppModule {}
