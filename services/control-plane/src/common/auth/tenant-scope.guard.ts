import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Request } from 'express';

import {
  type TenantRecord,
  TenantRepository,
} from '../../modules/tenants/tenant.repository';
import {
  ForbiddenError,
  InvalidError,
  NotFoundError,
} from '../errors/domain-error';

import { type Actor, isPlatformAdmin } from './actor';
import { TENANT_SCOPE_KEY } from './metadata';

export type TenantScopeOptions =
  /** `:param` in the route holds the tenant key (the only mode from v0.8). */
  | { from: 'param'; param: string }
  /**
   * v0.7 legacy routes without a tenant in the URL: the actor's own
   * tenant. Platform admins have none → 400 tenant_required.
   */
  | { from: 'actor-home' }
  /**
   * v0.7 legacy `GET /agents?tenant=`: platform admins may name a tenant
   * or omit it (req.tenant = null = everything); others get their own
   * tenant and may not name another one.
   */
  | { from: 'query'; query: string };

/**
 * Runs after AuthGuard (route-level guard). Resolves the tenant from the
 * DB, requires it to be active, and checks the actor may act on it:
 * platform admins on any tenant, everyone else only on their own.
 * The result is on req.tenant (@CurrentTenant()).
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<
      TenantScopeOptions | undefined
    >(TENANT_SCOPE_KEY, [context.getHandler(), context.getClass()]);

    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const actor = request.actor;

    if (!actor) {
      throw new Error('TenantScopeGuard requires an authenticated route');
    }

    request.tenant = await this.resolve(options, request, actor);

    return true;
  }

  private async resolve(
    options: TenantScopeOptions,
    request: Request,
    actor: Actor,
  ): Promise<TenantRecord | null> {
    if (options.from === 'param') {
      const raw: unknown = request.params[options.param];
      const key = typeof raw === 'string' ? raw : undefined;

      return this.authorize(actor, await this.byKey(key));
    }

    if (options.from === 'actor-home') {
      if (!actor.tenantId) {
        throw new InvalidError(
          'tenant_required',
          'This operation needs a tenant; platform admins must name one',
        );
      }

      return this.authorize(actor, await this.byId(actor.tenantId));
    }

    const raw = request.query[options.query];
    const key = typeof raw === 'string' && raw !== '' ? raw : undefined;

    if (isPlatformAdmin(actor)) {
      return key === undefined ? null : await this.byKey(key);
    }

    if (!actor.tenantId) {
      throw new ForbiddenError('forbidden', 'No tenant');
    }

    const own = await this.byId(actor.tenantId);

    if (key !== undefined && key !== own.tenantKey) {
      throw new ForbiddenError('forbidden', 'Cannot access another tenant');
    }

    return own;
  }

  private authorize(actor: Actor, tenant: TenantRecord): TenantRecord {
    if (isPlatformAdmin(actor) || actor.tenantId === tenant.id) {
      return tenant;
    }

    throw new ForbiddenError('forbidden', 'Cannot access another tenant');
  }

  private async byKey(key: string | undefined): Promise<TenantRecord> {
    const tenant = key ? await this.tenants.findByKey(key) : null;

    if (!tenant || tenant.status !== 'active') {
      throw new NotFoundError('tenant_not_found', 'Tenant not found');
    }

    return tenant;
  }

  private async byId(id: string): Promise<TenantRecord> {
    const tenant = await this.tenants.findById(id);

    if (!tenant || tenant.status !== 'active') {
      throw new NotFoundError('tenant_not_found', 'Tenant not found');
    }

    return tenant;
  }
}
