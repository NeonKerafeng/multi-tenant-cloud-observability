import {
  Controller,
  Post,
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
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async createAgent(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.agents.createAgent(req.user);
  }
}
