import { Module } from '@nestjs/common';

import { KeycloakClient } from './keycloak.client';

@Module({
  providers: [KeycloakClient],
  exports: [KeycloakClient],
})
export class KeycloakModule {}
