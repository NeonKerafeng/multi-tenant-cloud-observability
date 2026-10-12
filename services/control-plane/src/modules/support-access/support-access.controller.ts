import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';
import type { TenantRecord } from '../tenants/tenant.repository';

import { activeOnly, GrantDto, ListGrantsQuery } from './dto';
import { SupportAccessService } from './support-access.service';
import { GrantList, GrantView } from './views';

/**
 * Time-boxed access of platform admins to a tenant's Grafana org (D-04).
 * A platform admin grants access to HIMSELF; the tenant's admin can see
 * every grant of the tenant.
 */
@ApiTags('support-access')
@Controller()
export class SupportAccessController {
  constructor(private readonly supportAccess: SupportAccessService) {}

  @Post('tenants/:tenantKey/support-access')
  @Roles('platform-admin')
  @TenantScope()
  @ApiCreatedResponse({ type: GrantView })
  grant(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Body() body: GrantDto,
  ): Promise<GrantView> {
    return this.supportAccess.grant(actor, tenant, body);
  }

  @Get('tenants/:tenantKey/support-access')
  @Roles('platform-admin', 'tenant-admin')
  @TenantScope()
  @ApiOkResponse({ type: GrantList })
  async listForTenant(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Query() query: ListGrantsQuery,
  ): Promise<ListResponse<GrantView>> {
    return {
      items: await this.supportAccess.listForTenant(
        actor,
        tenant,
        activeOnly(query),
      ),
    };
  }

  /** Ends the grant now (the Grafana membership goes through the outbox). */
  @Delete('tenants/:tenantKey/support-access/:grantId')
  @Roles('platform-admin')
  @TenantScope()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Revoked (or already ended)' })
  async revoke(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('grantId') grantId: string,
  ): Promise<void> {
    await this.supportAccess.revoke(actor, tenant, grantId);
  }

  /** Grants of every tenant. */
  @Get('support-access')
  @Roles('platform-admin')
  @ApiOkResponse({ type: GrantList })
  async listAll(
    @CurrentActor() actor: Actor,
    @Query() query: ListGrantsQuery,
  ): Promise<ListResponse<GrantView>> {
    return {
      items: await this.supportAccess.listAll(actor, activeOnly(query)),
    };
  }
}
