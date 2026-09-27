import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { AgentsService } from './agents.service';

type AuthenticatedRequest = Request & {
  user: AuthUser;
};

@Controller('agents')
@UseGuards(JwtAuthGuard)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
  ) {}

  @Post()
  async createAgent(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.agents.createAgent(req.user);
  }

  @Get()
  async listAgents(
    @Req() req: AuthenticatedRequest,
    @Query('tenant') tenant?: string,
  ) {
    return this.agents.listAgents(
      req.user,
      tenant,
    );
  }

  @Get(':agentId')
  async getAgent(
    @Req() req: AuthenticatedRequest,
    @Param('agentId') agentId: string,
  ) {
    return this.agents.getAgent(
      req.user,
      agentId,
    );
  }

  @Post(':agentId/disable')
  async disableAgent(
    @Req() req: AuthenticatedRequest,
    @Param('agentId') agentId: string,
  ) {
    return this.agents.disableAgent(
      req.user,
      agentId,
    );
  }

  @Post(':agentId/enable')
  async enableAgent(
    @Req() req: AuthenticatedRequest,
    @Param('agentId') agentId: string,
  ) {
    return this.agents.enableAgent(
      req.user,
      agentId,
    );
  }

  @Delete(':agentId')
  async deleteAgent(
    @Req() req: AuthenticatedRequest,
    @Param('agentId') agentId: string,
  ) {
    return this.agents.deleteAgent(
      req.user,
      agentId,
    );
  }
}