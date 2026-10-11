import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';
import type { TenantRecord } from '../tenants/tenant.repository';

import { activeOnly, GrantDto } from './dto';
import { type GrantView, SupportAccessService } from './support-access.service';

/**
 * Time-boxed access of platform admins to a tenant's Grafana org (D-04).
 *   POST   /tenants/:tenantId/support-access           platform-admin
 *   GET    /tenants/:tenantId/support-access[?active]  platform-admin | tenant-admin of tenant
 *   DELETE /tenants/:tenantId/support-access/:grantId  platform-admin
 *   GET    /support-access[?active]                    platform-admin
 */
@Controller()
export class SupportAccessController {
  constructor(private readonly supportAccess: SupportAccessService) {}

  @Post('tenants/:tenantId/support-access')
  @Roles('platform-admin')
  @TenantScope({ from: 'param', param: 'tenantId' })
  grant(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Body() body: GrantDto,
  ): Promise<GrantView> {
    return this.supportAccess.grant(actor, tenant, body);
  }

  @Get('tenants/:tenantId/support-access')
  @Roles('platform-admin', 'tenant-admin')
  @TenantScope({ from: 'param', param: 'tenantId' })
  async listForTenant(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Query('active') active?: string,
  ): Promise<ListResponse<GrantView>> {
    return {
      items: await this.supportAccess.listForTenant(
        actor,
        tenant,
        activeOnly(active),
      ),
    };
  }

  @Delete('tenants/:tenantId/support-access/:grantId')
  @Roles('platform-admin')
  @TenantScope({ from: 'param', param: 'tenantId' })
  revoke(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('grantId') grantId: string,
  ): Promise<GrantView> {
    return this.supportAccess.revoke(actor, tenant, grantId);
  }

  @Get('support-access')
  @Roles('platform-admin')
  async listAll(
    @CurrentActor() actor: Actor,
    @Query('active') active?: string,
  ): Promise<ListResponse<GrantView>> {
    return {
      items: await this.supportAccess.listAll(actor, activeOnly(active)),
    };
  }
}
