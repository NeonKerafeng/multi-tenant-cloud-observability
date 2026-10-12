import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiParam } from '@nestjs/swagger';

import type { Request } from 'express';

import type { TenantRecord } from '../../modules/tenants/tenant.repository';
import { TENANT_KEY_RE } from '../http/validation';

import type { Actor, Role } from './actor';
import {
  IS_PUBLIC_KEY,
  ROLES_KEY,
  TENANT_PARAM,
  TENANT_SCOPE_KEY,
} from './metadata';
import { TenantScopeGuard } from './tenant-scope.guard';

export { IS_PUBLIC_KEY, ROLES_KEY, TENANT_SCOPE_KEY } from './metadata';

/** No authentication at all (health, metrics, enrollment exchange). */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Roles allowed to call the route. Every non-public route MUST have it:
 * a route with neither @Public nor @Roles is refused (fail closed).
 * Also documents the bearer token in OpenAPI.
 *
 * Put it on the class OR on the methods of a controller, never both:
 * OpenAPI would list the bearer requirement twice.
 */
export const Roles = (...roles: Role[]) =>
  applyDecorators(SetMetadata(ROLES_KEY, roles), ApiBearerAuth());

/**
 * The route acts on the tenant named by `:tenantKey`: the guard loads it
 * (active only, else 404 tenant_not_found) and checks the actor may act on
 * it (platform admins: any; others: their own, else 403 forbidden).
 * The result is @CurrentTenant().
 */
export const TenantScope = () =>
  applyDecorators(
    SetMetadata(TENANT_SCOPE_KEY, true),
    UseGuards(TenantScopeGuard),
    ApiParam({
      name: TENANT_PARAM,
      description: 'Tenant key',
      schema: { type: 'string', pattern: TENANT_KEY_RE.source },
    }),
  );

export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor => {
    const actor = ctx.switchToHttp().getRequest<Request>().actor;

    if (!actor) {
      throw new Error('CurrentActor used on a route without authentication');
    }

    return actor;
  },
);

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantRecord => {
    const tenant = ctx.switchToHttp().getRequest<Request>().tenant;

    if (!tenant) {
      throw new Error('CurrentTenant used on a route without @TenantScope');
    }

    return tenant;
  },
);
