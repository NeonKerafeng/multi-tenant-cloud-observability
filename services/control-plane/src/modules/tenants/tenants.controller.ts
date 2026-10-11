import { Body, Controller, Delete, Get, Post } from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';

import { LegacyCreateTenantDto } from './dto';
import type { TenantRecord } from './tenant.repository';
import { TenantsService, type TenantView } from './tenants.service';

/**
 * v0.7 LEGACY routes (same URLs as v0.6; replaced by /api/v1 in v0.8).
 * `:tenantId` is the tenant key.
 */
@Controller('tenants')
@Roles('platform-admin')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<ListResponse<TenantView>> {
    return { items: await this.tenants.list(actor) };
  }

  @Get(':tenantId')
  @TenantScope({ from: 'param', param: 'tenantId' })
  get(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): TenantView {
    return this.tenants.get(actor, tenant);
  }

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Body() body: LegacyCreateTenantDto,
  ): Promise<TenantView> {
    return this.tenants.create(actor, body.tenantId);
  }

  @Delete(':tenantId')
  @TenantScope({ from: 'param', param: 'tenantId' })
  async delete(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<{ tenantKey: string; deleted: true }> {
    await this.tenants.delete(actor, tenant);

    return { tenantKey: tenant.tenantKey, deleted: true };
  }
}
