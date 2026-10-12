import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
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

import { CreateTenantDto } from './dto';
import type { TenantRecord } from './tenant.repository';
import { TenantsService } from './tenants.service';
import { TenantList, TenantView } from './views';

@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @Roles('platform-admin')
  @ApiOkResponse({ type: TenantList })
  async list(@CurrentActor() actor: Actor): Promise<ListResponse<TenantView>> {
    return { items: await this.tenants.list(actor) };
  }

  /** Creates the tenant, its Keycloak group (now) and Grafana org (async). */
  @Post()
  @Roles('platform-admin')
  @ApiCreatedResponse({ type: TenantView })
  create(
    @CurrentActor() actor: Actor,
    @Body() body: CreateTenantDto,
  ): Promise<TenantView> {
    return this.tenants.create(actor, body.tenantKey);
  }

  /** Tenant admins may read their own tenant. */
  @Get(':tenantKey')
  @Roles('platform-admin', 'tenant-admin')
  @TenantScope()
  @ApiOkResponse({ type: TenantView })
  get(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): TenantView {
    return this.tenants.get(actor, tenant);
  }

  /**
   * Deletes the tenant with its users, agents and support grants; Keycloak
   * and Grafana follow through the outbox. The key is never reusable.
   */
  @Delete(':tenantKey')
  @Roles('platform-admin')
  @TenantScope()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted' })
  async delete(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<void> {
    await this.tenants.delete(actor, tenant);
  }
}
