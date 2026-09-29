import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { KeycloakModule } from '../keycloak/keycloak.module';

import { AgentRepository } from './agent.repository';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [
    AuthModule,
    KeycloakModule,
  ],

  controllers: [
    AgentsController,
  ],

  providers: [
    AgentsService,
    AgentRepository,
  ],

  exports: [
    AgentsService,
    AgentRepository,
  ],
})
export class AgentsModule {}
