import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentsModule } from './agents/agents.module';
import { KeycloakModule } from './keycloak/keycloak.module';
import { EnrollmentsModule } from './enrollments/enrollments.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AgentsModule,
    KeycloakModule,
    EnrollmentsModule,
    TenantsModule,
  ],
})
export class AppModule {}
