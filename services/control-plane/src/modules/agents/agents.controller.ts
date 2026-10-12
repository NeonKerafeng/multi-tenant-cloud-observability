import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';
import type { TenantRecord } from '../tenants/tenant.repository';

import { AgentsService } from './agents.service';
import { UpdateAgentDto } from './dto';
import { AgentList, AgentView } from './views';

/**
 * Agents of one tenant. They are created only by an enrollment exchange
 * (POST /agent-enrollments/exchange), never directly (decision Q4).
 */
@ApiTags('agents')
@Controller('tenants/:tenantKey/agents')
@Roles('platform-admin', 'tenant-admin')
@TenantScope()
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOkResponse({ type: AgentList })
  async list(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<ListResponse<AgentView>> {
    return { items: await this.agents.list(actor, tenant) };
  }

  @Get(':agentId')
  @ApiOkResponse({ type: AgentView })
  get(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('agentId') agentId: string,
  ): Promise<AgentView> {
    return this.agents.get(actor, tenant, agentId);
  }

  /**
   * `{"enabled": false}` disables the Keycloak client: the agent cannot get
   * a new token (the current one stays valid until it expires).
   */
  @Patch(':agentId')
  @ApiOkResponse({ type: AgentView })
  update(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('agentId') agentId: string,
    @Body() body: UpdateAgentDto,
  ): Promise<AgentView> {
    return this.agents.update(actor, tenant, agentId, body);
  }

  /** Revokes the agent; its Keycloak client is deleted. */
  @Delete(':agentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Revoked' })
  async delete(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('agentId') agentId: string,
  ): Promise<void> {
    await this.agents.delete(actor, tenant, agentId);
  }
}
