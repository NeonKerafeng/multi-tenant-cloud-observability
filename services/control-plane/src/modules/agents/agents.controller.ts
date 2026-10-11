import { Controller, Delete, Get, Param, Post } from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';
import type { TenantRecord } from '../tenants/tenant.repository';

import { type AgentView, AgentsService } from './agents.service';

/**
 * v0.7 LEGACY routes (flat /agents, tenant from the actor or ?tenant=).
 * v0.8 replaces them with /api/v1/tenants/{tenantKey}/agents and drops
 * POST /agents (agents come from enrollment only, decision Q4).
 */
@Controller('agents')
@Roles('platform-admin', 'tenant-admin')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /** Legacy direct creation (tenant-admin, own tenant). Removed in v0.8. */
  @Post()
  @Roles('tenant-admin')
  @TenantScope({ from: 'actor-home' })
  async create(
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<AgentView & { agentId: string; clientSecret: string }> {
    const issued = await this.agents.issue(tenant);

    return {
      ...issued.agent,
      agentId: issued.agent.id,
      clientSecret: issued.clientSecret,
    };
  }

  @Get()
  @TenantScope({ from: 'query', query: 'tenant' })
  async list(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord | null,
  ): Promise<ListResponse<AgentView>> {
    return {
      items: tenant
        ? await this.agents.list(actor, tenant)
        : await this.agents.listAll(actor),
    };
  }

  @Get(':agentId')
  async get(
    @CurrentActor() actor: Actor,
    @Param('agentId') agentId: string,
  ): Promise<AgentView> {
    const tenant = await this.agents.tenantOfAgent(actor, agentId);

    return this.agents.get(actor, tenant, agentId);
  }

  @Post(':agentId/disable')
  async disable(
    @CurrentActor() actor: Actor,
    @Param('agentId') agentId: string,
  ): Promise<AgentView> {
    const tenant = await this.agents.tenantOfAgent(actor, agentId);

    return this.agents.update(actor, tenant, agentId, { enabled: false });
  }

  @Post(':agentId/enable')
  async enable(
    @CurrentActor() actor: Actor,
    @Param('agentId') agentId: string,
  ): Promise<AgentView> {
    const tenant = await this.agents.tenantOfAgent(actor, agentId);

    return this.agents.update(actor, tenant, agentId, { enabled: true });
  }

  @Delete(':agentId')
  async delete(
    @CurrentActor() actor: Actor,
    @Param('agentId') agentId: string,
  ): Promise<{ agentId: string; deleted: true }> {
    const tenant = await this.agents.tenantOfAgent(actor, agentId);

    await this.agents.delete(actor, tenant, agentId);

    return { agentId, deleted: true };
  }
}
