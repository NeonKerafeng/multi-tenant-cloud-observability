import { Module } from '@nestjs/common';

import { GrafanaModule } from '../integrations/grafana/grafana.module';
import { KeycloakModule } from '../integrations/keycloak/keycloak.module';
import { MIRROR_HANDLERS, type MirrorHandler } from '../sync/mirror';

import { GrafanaTenantMirror } from './grafana/grafana-tenant.mirror';
import { GrafanaUserMirror } from './grafana/grafana-user.mirror';
import { KeycloakAgentMirror } from './keycloak/keycloak-agent.mirror';
import { KeycloakTenantMirror } from './keycloak/keycloak-tenant.mirror';
import { KeycloakUserMirror } from './keycloak/keycloak-user.mirror';

const MIRRORS = [
  GrafanaTenantMirror,
  GrafanaUserMirror,
  KeycloakAgentMirror,
  KeycloakTenantMirror,
  KeycloakUserMirror,
];

/**
 * Every MirrorHandler, also exported one by one: services call the
 * Keycloak mirrors INLINE for creates (secret/password handed out once).
 */
@Module({
  imports: [GrafanaModule, KeycloakModule],
  providers: [
    ...MIRRORS,
    {
      provide: MIRROR_HANDLERS,
      useFactory: (...handlers: MirrorHandler[]) => handlers,
      inject: MIRRORS,
    },
  ],
  exports: [...MIRRORS, MIRROR_HANDLERS],
})
export class MirrorsModule {}
