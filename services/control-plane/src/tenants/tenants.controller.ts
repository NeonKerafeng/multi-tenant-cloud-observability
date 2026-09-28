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

import { TenantsService } from './tenants.service';

type AuthenticatedRequest = Request & {
  user: AuthUser;
};

interface CreateTenantBody {
  tenantId?: string;
  vmAccountId?: string;
}

@Controller('tenants')
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
  ) {}

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tenants.list(req.user);
  }

  @Get(':tenantId')
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    return this.tenants.get(
      req.user,
      tenantId,
    );
  }

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateTenantBody,
  ) {
    return this.tenants.create(
      req.user,
      body.tenantId ?? '',
      body.vmAccountId ?? '',
    );
  }

  @Delete(':tenantId')
  async delete(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    return this.tenants.delete(
      req.user,
      tenantId,
    );
  }
}
