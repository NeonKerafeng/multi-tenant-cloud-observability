import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Request } from 'express';

import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { ForbiddenError, NotFoundError } from '../errors/domain-error';

import { isPlatformAdmin } from './actor';
import { TENANT_PARAM, TENANT_SCOPE_KEY } from './metadata';

/**
 * Runs after AuthGuard (route-level guard) on @TenantScope routes:
 * `:tenantKey` → active tenant row (else 404 tenant_not_found), then
 * platform admins may act on any tenant, everyone else only on their own
 * (else 403 forbidden). The result is on req.tenant (@CurrentTenant()).
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scoped = this.reflector.getAllAndOverride<boolean | undefined>(
      TENANT_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!scoped) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const actor = request.actor;

    if (!actor) {
      throw new Error('TenantScopeGuard requires an authenticated route');
    }

    const raw: unknown = request.params[TENANT_PARAM];
    const tenant =
      typeof raw === 'string' && raw !== ''
        ? await this.tenants.findByKey(raw)
        : null;

    if (!tenant || tenant.status !== 'active') {
      throw new NotFoundError('tenant_not_found', 'Tenant not found');
    }

    if (!isPlatformAdmin(actor) && actor.tenantId !== tenant.id) {
      throw new ForbiddenError('forbidden', 'Cannot access another tenant');
    }

    request.tenant = tenant;

    return true;
  }
}
