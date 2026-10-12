import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { Actor } from '../../common/auth/actor';
import { ROLES } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';
import type { TenantRecord } from '../tenants/tenant.repository';

import { CreateUserDto, UpdateUserDto } from './dto';
import { UsersService } from './users.service';
import { UserList, UserView } from './views';

/**
 * Users of one tenant. Tenant admins manage viewers of their own tenant;
 * platform admins manage tenant admins and viewers of any tenant
 * (users.policy.ts).
 */
@ApiTags('users')
@Controller('tenants/:tenantKey/users')
@Roles('platform-admin', 'tenant-admin')
@TenantScope()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ type: UserList })
  async list(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<ListResponse<UserView>> {
    return { items: await this.users.list(actor, tenant) };
  }

  /** Creates the user and its Keycloak account (with the password) now. */
  @Post()
  @ApiCreatedResponse({ type: UserView })
  create(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Body() body: CreateUserDto,
  ): Promise<UserView> {
    return this.users.create(actor, tenant, body);
  }

  @Get(':userId')
  @ApiOkResponse({ type: UserView })
  get(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('userId') userId: string,
  ): Promise<UserView> {
    return this.users.get(actor, tenant, userId);
  }

  /** `{"enabled": false}` blocks the user's next request at once. */
  @Patch(':userId')
  @ApiOkResponse({ type: UserView })
  update(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('userId') userId: string,
    @Body() body: UpdateUserDto,
  ): Promise<UserView> {
    return this.users.update(actor, tenant, userId, body);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted' })
  async delete(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.users.delete(actor, tenant, userId);
  }
}

/** The caller itself (every role). */
@ApiTags('me')
@Controller('me')
@Roles(...ROLES)
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ type: UserView })
  me(@CurrentActor() actor: Actor): Promise<UserView> {
    return this.users.me(actor);
  }
}
