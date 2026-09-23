import {
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import type { AuthUser } from '../auth/auth-user';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';

@Injectable()
export class AgentsService {
  constructor(
    private readonly keycloak: KeycloakAdminService,
  ) {}

  async createAgent(user: AuthUser) {
    if (!user.roles.includes('tenant-admin')) {
      throw new ForbiddenException(
        'Only tenant admins can create agents',
      );
    }

    const groups = user.groups
      .map((group) => group.replace(/^\/+/, ''))
      .filter(Boolean);

    if (groups.length !== 1) {
      throw new ForbiddenException(
        'User must belong to exactly one tenant group',
      );
    }

    const vmAccountIds = user.vmAccountIds
      .map((id) => id.trim())
      .filter(Boolean);

    if (vmAccountIds.length !== 1) {
      throw new ForbiddenException(
        'Tenant must have exactly one VictoriaMetrics account ID',
      );
    }

    const tenantId = groups[0];
    const vmAccountId = vmAccountIds[0];

    if (!/^\d+$/.test(vmAccountId)) {
      throw new ForbiddenException(
        'Invalid VictoriaMetrics account ID',
      );
    }

    const agentId = randomUUID();

    const identity =
      await this.keycloak.createAgentIdentity({
        agentId,
        tenantId,
        vmAccountId,
      });

    return {
      agentId,
      tenantId,
      vmAccountId,
      clientId: identity.clientId,
      clientSecret: identity.clientSecret,
    };
  }
}
