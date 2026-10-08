import {
  Body,
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

import {
  type GrantSupportAccessInput,
  SupportAccessService,
} from './support-access.service';

type AuthenticatedRequest = Request & {
  user: AuthUser;
};

/** ?active=true|1 -> only grants in effect now. */
function activeOnly(
  value: string | undefined,
): boolean {
  return value === 'true' || value === '1';
}

/**
 * Time-boxed access of platform admins to a tenant's Grafana org.
 *
 *   POST   /tenants/:tenantId/support-access           platform-admin
 *   GET    /tenants/:tenantId/support-access[?active]  platform-admin | tenant-admin
 *   DELETE /tenants/:tenantId/support-access/:id       platform-admin | tenant-admin
 *   GET    /support-access[?active]                    platform-admin
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class SupportAccessController {
  constructor(
    private readonly supportAccess: SupportAccessService,
  ) {}

  @Post('tenants/:tenantId/support-access')
  async grant(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: GrantSupportAccessInput | undefined,
  ) {
    return this.supportAccess.grant(
      req.user,
      tenantId,
      body ?? {},
    );
  }

  @Get('tenants/:tenantId/support-access')
  async listForTenant(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
    @Query('active') active?: string,
  ) {
    return this.supportAccess.listForTenant(
      req.user,
      tenantId,
      activeOnly(active),
    );
  }

  @Delete('tenants/:tenantId/support-access/:grantId')
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
    @Param('grantId') grantId: string,
  ) {
    return this.supportAccess.revoke(
      req.user,
      tenantId,
      grantId,
    );
  }

  @Get('support-access')
  async listAll(
    @Req() req: AuthenticatedRequest,
    @Query('active') active?: string,
  ) {
    return this.supportAccess.listAll(
      req.user,
      activeOnly(active),
    );
  }
}
