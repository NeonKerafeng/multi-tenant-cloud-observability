import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import type { AuthUser } from '../auth/auth-user';
import {
  KeycloakAdminService,
  ManagedAgentIdentity,
} from '../keycloak/keycloak-admin.service';

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

    const tenantId = this.getTenantAdminTenant(user);

    const vmAccountIds = user.vmAccountIds
      .map((id) => id.trim())
      .filter(Boolean);

    if (vmAccountIds.length !== 1) {
      throw new ForbiddenException(
        'Tenant must have exactly one VictoriaMetrics account ID',
      );
    }

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

  async listAgents(
    user: AuthUser,
    requestedTenant?: string,
  ) {
    const agents =
      await this.keycloak.listAgentIdentities();

    if (this.isPlatformAdmin(user)) {
      if (!requestedTenant) {
        return agents;
      }

      return agents.filter(
        (agent) => agent.tenantId === requestedTenant,
      );
    }

    const tenantId = this.getTenantAdminTenant(user);

    if (
      requestedTenant &&
      requestedTenant !== tenantId
    ) {
      throw new ForbiddenException(
        'Cannot access agents from another tenant',
      );
    }

    return agents.filter(
      (agent) => agent.tenantId === tenantId,
    );
  }

  async getAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(agentId);

    this.assertCanManageAgent(user, agent);

    return agent;
  }

  async disableAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(agentId);

    this.assertCanManageAgent(user, agent);

    const updated =
      await this.keycloak.setAgentEnabled(
        agentId,
        false,
      );

    if (!updated) {
      throw new NotFoundException('Agent not found');
    }

    return updated;
  }

  async enableAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(agentId);

    this.assertCanManageAgent(user, agent);

    const updated =
      await this.keycloak.setAgentEnabled(
        agentId,
        true,
      );

    if (!updated) {
      throw new NotFoundException('Agent not found');
    }

    return updated;
  }

  async deleteAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(agentId);

    this.assertCanManageAgent(user, agent);

    const deleted =
      await this.keycloak.deleteAgentIdentity(agentId);

    if (!deleted) {
      throw new NotFoundException('Agent not found');
    }

    return {
      agentId,
      deleted: true,
    };
  }

  private async requireAgent(
    agentId: string,
  ): Promise<ManagedAgentIdentity> {
    const agent =
      await this.keycloak.getAgentIdentity(agentId);

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    return agent;
  }

  private assertCanManageAgent(
    user: AuthUser,
    agent: ManagedAgentIdentity,
  ): void {
    if (this.isPlatformAdmin(user)) {
      return;
    }

    const tenantId =
      this.getTenantAdminTenant(user);

    if (agent.tenantId !== tenantId) {
      throw new ForbiddenException(
        'Cannot manage agent from another tenant',
      );
    }
  }

  private isPlatformAdmin(
    user: AuthUser,
  ): boolean {
    return user.roles.includes('platform-admin');
  }

  private getTenantAdminTenant(
    user: AuthUser,
  ): string {
    if (!user.roles.includes('tenant-admin')) {
      throw new ForbiddenException(
        'tenant-admin or platform-admin role required',
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

    return groups[0];
  }
}