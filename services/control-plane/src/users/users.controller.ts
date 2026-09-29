import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { UsersService } from './users.service';
import type { CreateUserInput } from './users.service';

type AuthenticatedRequest =
  Request & {
    user: AuthUser;
  };

@Controller(
  'tenants/:tenantId/users',
)
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users:
      UsersService,
  ) {}

  @Get()
  async list(
    @Req()
    req: AuthenticatedRequest,

    @Param('tenantId')
    tenantId: string,
  ) {
    return this.users.list(
      req.user,
      tenantId,
    );
  }

  @Get(':userId')
  async get(
    @Req()
    req: AuthenticatedRequest,

    @Param('tenantId')
    tenantId: string,

    @Param('userId')
    userId: string,
  ) {
    return this.users.get(
      req.user,
      tenantId,
      userId,
    );
  }

  @Post()
  async create(
    @Req()
    req: AuthenticatedRequest,

    @Param('tenantId')
    tenantId: string,

    @Body()
    body: CreateUserInput,
  ) {
    return this.users.create(
      req.user,
      tenantId,
      body,
    );
  }

  @Post(':userId/disable')
  async disable(
    @Req()
    req: AuthenticatedRequest,

    @Param('tenantId')
    tenantId: string,

    @Param('userId')
    userId: string,
  ) {
    return this.users.disable(
      req.user,
      tenantId,
      userId,
    );
  }

  @Post(':userId/enable')
  async enable(
    @Req()
    req: AuthenticatedRequest,

    @Param('tenantId')
    tenantId: string,

    @Param('userId')
    userId: string,
  ) {
    return this.users.enable(
      req.user,
      tenantId,
      userId,
    );
  }

  @Delete(':userId')
  async delete(
    @Req()
    req: AuthenticatedRequest,

    @Param('tenantId')
    tenantId: string,

    @Param('userId')
    userId: string,
  ) {
    return this.users.delete(
      req.user,
      tenantId,
      userId,
    );
  }
}
