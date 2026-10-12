import { Injectable } from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import type { Actor } from '../../common/auth/actor';
import { DatabaseService } from '../../common/db/database.service';
import { NotFoundError } from '../../common/errors/domain-error';
import { isUuid } from '../../common/http/validation';
import { KeycloakAgentMirror } from '../../mirrors/keycloak/keycloak-agent.mirror';
import { OutboxRepository } from '../../sync/outbox.repository';
import type { TenantRecord } from '../tenants/tenant.repository';

import { type AgentRecord, AgentRepository } from './agent.repository';
import { type AgentView, toAgentView } from './views';

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
    private readonly outbox: OutboxRepository,
    private readonly keycloakAgents: KeycloakAgentMirror,
  ) {}

  async list(_actor: Actor, tenant: TenantRecord): Promise<AgentView[]> {
    return (await this.agents.listLiveByTenant(tenant.id)).map(toAgentView);
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
   * Only the enrollment exchange calls this.
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
