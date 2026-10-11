import { Injectable } from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import { type Actor, isPlatformAdmin } from '../../common/auth/actor';
import { DatabaseService } from '../../common/db/database.service';
import {
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/domain-error';
import { isUuid } from '../../common/http/validation';
import { KeycloakAgentMirror } from '../../mirrors/keycloak/keycloak-agent.mirror';
import { OutboxRepository } from '../../sync/outbox.repository';
import {
  type TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';

import { type AgentRecord, AgentRepository } from './agent.repository';

export interface AgentView {
  id: string;
  tenantKey: string;
  clientId: string;
  status: AgentRecord['status'];
  enabled: boolean;
  createdAt: Date;
}

export function toAgentView(agent: AgentRecord): AgentView {
  return {
    id: agent.id,
    tenantKey: agent.tenantKey,
    clientId: agent.clientId,
    status: agent.status,
    enabled: agent.status === 'active',
    createdAt: agent.createdAt,
  };
}

export interface IssuedAgent {
  agent: AgentView;
  clientSecret: string;
}

export interface UpdateAgentInput {
  enabled?: boolean;
}

/** Agents (host collectors) of a tenant. */
@Injectable()
export class AgentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly agents: AgentRepository,
    private readonly tenants: TenantRepository,
    private readonly outbox: OutboxRepository,
    private readonly keycloakAgents: KeycloakAgentMirror,
  ) {}

  async list(_actor: Actor, tenant: TenantRecord): Promise<AgentView[]> {
    return (await this.agents.listLiveByTenant(tenant.id)).map(toAgentView);
  }

  /** Platform-admin view across tenants (v0.7 legacy GET /agents). */
  async listAll(actor: Actor): Promise<AgentView[]> {
    if (!isPlatformAdmin(actor)) {
      throw new ForbiddenError('forbidden', 'platform-admin role required');
    }

    return (await this.agents.listLive()).map(toAgentView);
  }

  async get(
    _actor: Actor,
    tenant: TenantRecord,
    agentId: string,
  ): Promise<AgentView> {
    return toAgentView(await this.requireAgent(tenant, agentId));
  }

  async update(
    _actor: Actor,
    tenant: TenantRecord,
    agentId: string,
    input: UpdateAgentInput,
  ): Promise<AgentView> {
    const agent = await this.requireAgent(tenant, agentId);

    if (input.enabled !== undefined && agent.status !== 'provisioning') {
      const status = input.enabled ? 'active' : 'disabled';

      if (status !== agent.status) {
        await this.db.transaction(async (tx) => {
          await this.agents.setStatus(tx, agent.id, status);
          await this.outbox.enqueue(tx, 'agent', agent.id);
        });
      }
    }

    return toAgentView((await this.agents.findById(agent.id)) ?? agent);
  }

  /** Revokes (soft delete); the mirror deletes the Keycloak client. */
  async delete(
    _actor: Actor,
    tenant: TenantRecord,
    agentId: string,
  ): Promise<void> {
    const agent = await this.requireAgent(tenant, agentId);

    await this.db.transaction(async (tx) => {
      await this.agents.markRevoked(tx, agent.id);
      await this.outbox.enqueue(tx, 'agent', agent.id);
    });
  }

  /**
   * Creates an agent and its Keycloak credentials in ONE transaction and
   * returns the secret (shown once, never stored). Keycloak down → no row;
   * a half-created client is cleaned up by the v0.9 GC.
   */
  async issue(tenant: TenantRecord): Promise<IssuedAgent> {
    return this.db.transaction(async (tx) => {
      const agent = await this.agents.insert(tx, {
        id: randomUUID(),
        tenantId: tenant.id,
        status: 'provisioning',
      });

      const credentials = await this.keycloakAgents.issueCredentials(agent, tx);

      await this.agents.setStatus(tx, agent.id, 'active');
      await this.outbox.enqueue(tx, 'agent', agent.id);

      const issued = (await this.agents.findById(agent.id, tx)) ?? agent;

      return {
        agent: toAgentView(issued),
        clientSecret: credentials.clientSecret,
      };
    });
  }

  /**
   * v0.7 legacy routes `/agents/:agentId` carry no tenant: resolve it from
   * the agent (removed in v0.8, where the tenant is in the URL).
   */
  async tenantOfAgent(actor: Actor, agentId: string): Promise<TenantRecord> {
    const agent = isUuid(agentId)
      ? await this.agents.findLiveById(agentId)
      : null;
    const tenant = agent ? await this.tenants.findById(agent.tenantId) : null;

    if (!agent || !tenant || tenant.status !== 'active') {
      throw new NotFoundError('agent_not_found', 'Agent not found');
    }

    if (!isPlatformAdmin(actor) && actor.tenantId !== tenant.id) {
      throw new ForbiddenError(
        'forbidden',
        'Cannot manage an agent of another tenant',
      );
    }

    return tenant;
  }

  private async requireAgent(
    tenant: TenantRecord,
    agentId: string,
  ): Promise<AgentRecord> {
    const agent = isUuid(agentId)
      ? await this.agents.findLiveById(agentId)
      : null;

    if (!agent || agent.tenantId !== tenant.id) {
      throw new NotFoundError('agent_not_found', 'Agent not found');
    }

    return agent;
  }
}
