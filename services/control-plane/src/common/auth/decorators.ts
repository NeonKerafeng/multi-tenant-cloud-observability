import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import type { TenantRecord } from '../../modules/tenants/tenant.repository';

import type { Actor, Role } from './actor';
import { IS_PUBLIC_KEY, ROLES_KEY, TENANT_SCOPE_KEY } from './metadata';
import {
  TenantScopeGuard,
  type TenantScopeOptions,
} from './tenant-scope.guard';

export { IS_PUBLIC_KEY, ROLES_KEY, TENANT_SCOPE_KEY } from './metadata';

/** No authentication at all (health, metrics, enrollment exchange). */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Roles allowed to call the route. Every non-public route MUST have it:
 * a route with neither @Public nor @Roles is refused (fail closed).
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Resolves the tenant the route acts on and checks the actor may. */
export const TenantScope = (
  options: TenantScopeOptions,
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(TENANT_SCOPE_KEY, options),
    UseGuards(TenantScopeGuard),
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
  (_data: unknown, ctx: ExecutionContext): TenantRecord | null => {
    const tenant = ctx.switchToHttp().getRequest<Request>().tenant;

    if (tenant === undefined) {
      throw new Error('CurrentTenant used on a route without @TenantScope');
    }

    return tenant;
  },
);
