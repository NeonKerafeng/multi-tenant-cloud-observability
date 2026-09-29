import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import type { AuthUser } from '../auth/auth-user';

import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';

import {
  AgentRecord,
  AgentRepository,
} from './agent.repository';

@Injectable()
export class AgentsService {
  constructor(
    private readonly keycloak:
      KeycloakAdminService,

    private readonly agents:
      AgentRepository,
  ) {}

  async createAgent(
    user: AuthUser,
  ) {
    if (
      !user.roles.includes(
        'tenant-admin',
      )
    ) {
      throw new ForbiddenException(
        'Only tenant admins can create agents',
      );
    }

    const tenantId =
      this.getTenantAdminTenant(user);

    return this.provisionAgentForTenant(
      tenantId,
    );
  }

  async provisionAgentForTenant(
    tenantId: string,
  ) {
    const agentId = randomUUID();

    const agent =
      await this.agents
        .createProvisioning(
          agentId,
          tenantId,
        );

    if (!agent) {
      throw new BadRequestException(
        'Tenant does not exist or is not active',
      );
    }

    try {
      const identity =
        await this.keycloak
          .createAgentIdentity({
            agentId,
            tenantId:
              agent.tenantId,
            vmAccountId:
              agent.vmAccountId,
          });

      const activeAgent =
        await this.agents.markActive(
          agentId,
          identity.clientUuid,
        );

      if (!activeAgent) {
        throw new Error(
          'Failed to activate agent registry record',
        );
      }

      return {
        ...this.toResponse(
          activeAgent,
        ),

        clientSecret:
          identity.clientSecret,
      };
    } catch (error) {
      await this.agents
        .markError(agentId)
        .catch(() => undefined);

      throw error;
    }
  }

  async listAgents(
    user: AuthUser,
    requestedTenant?: string,
  ) {
    if (this.isPlatformAdmin(user)) {
      const agents =
        await this.agents.findAll(
          requestedTenant,
        );

      return agents.map(
        (agent) =>
          this.toResponse(agent),
      );
    }

    const tenantId =
      this.getTenantAdminTenant(user);

    if (
      requestedTenant &&
      requestedTenant !== tenantId
    ) {
      throw new ForbiddenException(
        'Cannot access agents from another tenant',
      );
    }

    const agents =
      await this.agents.findAll(
        tenantId,
      );

    return agents.map(
      (agent) =>
        this.toResponse(agent),
    );
  }

  async getAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(
        agentId,
      );

    this.assertCanManageAgent(
      user,
      agent,
    );

    return this.toResponse(agent);
  }

  async disableAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(
        agentId,
      );

    this.assertCanManageAgent(
      user,
      agent,
    );

    const identity =
      await this.keycloak
        .setAgentEnabled(
          agentId,
          false,
        );

    if (!identity) {
      throw new ConflictException(
        'Agent exists in registry but Keycloak identity is missing',
      );
    }

    const updated =
      await this.agents.setStatus(
        agentId,
        'disabled',
      );

    if (!updated) {
      throw new NotFoundException(
        'Agent not found',
      );
    }

    return this.toResponse(updated);
  }

  async enableAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(
        agentId,
      );

    this.assertCanManageAgent(
      user,
      agent,
    );

    const identity =
      await this.keycloak
        .setAgentEnabled(
          agentId,
          true,
        );

    if (!identity) {
      throw new ConflictException(
        'Agent exists in registry but Keycloak identity is missing',
      );
    }

    const updated =
      await this.agents.setStatus(
        agentId,
        'active',
      );

    if (!updated) {
      throw new NotFoundException(
        'Agent not found',
      );
    }

    return this.toResponse(updated);
  }

  async deleteAgent(
    user: AuthUser,
    agentId: string,
  ) {
    const agent =
      await this.requireAgent(
        agentId,
      );

    this.assertCanManageAgent(
      user,
      agent,
    );

    /*
     * DB is source of truth.
     * If Keycloak identity is already gone,
     * revocation is already satisfied there.
     */
    await this.keycloak
      .deleteAgentIdentity(
        agentId,
      );

    await this.agents.markRevoked(
      agentId,
    );

    return {
      agentId,
      deleted: true,
    };
  }

  private async requireAgent(
    agentId: string,
  ): Promise<AgentRecord> {
    const agent =
      await this.agents.findById(
        agentId,
      );

    if (!agent) {
      throw new NotFoundException(
        'Agent not found',
      );
    }

    return agent;
  }

  private assertCanManageAgent(
    user: AuthUser,
    agent: AgentRecord,
  ): void {
    if (this.isPlatformAdmin(user)) {
      return;
    }

    const tenantId =
      this.getTenantAdminTenant(user);

    if (
      agent.tenantId !== tenantId
    ) {
      throw new ForbiddenException(
        'Cannot manage agent from another tenant',
      );
    }
  }

  private toResponse(
    agent: AgentRecord,
  ) {
    return {
      agentId:
        agent.agentId,

      clientId:
        agent.clientId,

      tenantId:
        agent.tenantId,

      vmAccountId:
        agent.vmAccountId,

      enabled:
        agent.status === 'active',

      status:
        agent.status,
    };
  }

  private isPlatformAdmin(
    user: AuthUser,
  ): boolean {
    return user.roles.includes(
      'platform-admin',
    );
  }

  private getTenantAdminTenant(
    user: AuthUser,
  ): string {
    if (
      !user.roles.includes(
        'tenant-admin',
      )
    ) {
      throw new ForbiddenException(
        'tenant-admin or platform-admin role required',
      );
    }

    const groups =
      user.groups
        .map(
          (group) =>
            group.replace(/^\/+/, ''),
        )
        .filter(Boolean);

    if (groups.length !== 1) {
      throw new ForbiddenException(
        'User must belong to exactly one tenant group',
      );
    }

    return groups[0];
  }
}
