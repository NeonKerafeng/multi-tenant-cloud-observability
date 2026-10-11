import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';
import type { TenantRecord } from '../tenants/tenant.repository';

import { CreateUserDto } from './dto';
import { type UserView, UsersService } from './users.service';

/**
 * v0.7 LEGACY routes (same URLs as v0.6; v0.8 moves to /api/v1 + PATCH).
 * `:userId` is the control-plane user id (UUID) from v0.7 on.
 */
@Controller('tenants/:tenantId/users')
@Roles('platform-admin', 'tenant-admin')
@TenantScope({ from: 'param', param: 'tenantId' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<ListResponse<UserView>> {
    return { items: await this.users.list(actor, tenant) };
  }

  @Get(':userId')
  get(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('userId') userId: string,
  ): Promise<UserView> {
    return this.users.get(actor, tenant, userId);
  }

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Body() body: CreateUserDto,
  ): Promise<UserView> {
    return this.users.create(actor, tenant, body);
  }

  @Post(':userId/disable')
  disable(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('userId') userId: string,
  ): Promise<UserView> {
    return this.users.update(actor, tenant, userId, { enabled: false });
  }

  @Post(':userId/enable')
  enable(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('userId') userId: string,
  ): Promise<UserView> {
    return this.users.update(actor, tenant, userId, { enabled: true });
  }

  @Delete(':userId')
  async delete(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('userId') userId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.users.delete(actor, tenant, userId);

    return { id: userId, deleted: true };
  }
}
