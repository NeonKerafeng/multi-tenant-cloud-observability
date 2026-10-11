import type { Actor, Role } from '../../common/auth/actor';
import { ForbiddenError } from '../../common/errors/domain-error';

import type { UserRecord } from './user.repository';

/**
 * Business rules for managing human users (pure functions, unit-tested
 * as a matrix). Tenant scope is already enforced by TenantScopeGuard.
 *
 *  platform-admin: may create/manage tenant-admin and viewer users
 *  tenant-admin:   may create/manage viewer users of their tenant only
 *  platform-admin ACCOUNTS are never managed through this API
 */
export function assertCanCreateUser(actor: Actor, role: Role): void {
  if (role === 'platform-admin') {
    throw new ForbiddenError(
      'forbidden',
      'Platform admins cannot be created through the API',
    );
  }

  if (actor.role === 'platform-admin') {
    return;
  }

  if (actor.role === 'tenant-admin' && role === 'viewer') {
    return;
  }

  throw new ForbiddenError(
    'forbidden',
    `A ${actor.role} cannot create ${role} users`,
  );
}

export function assertCanManageUser(actor: Actor, target: UserRecord): void {
  if (target.role === 'platform-admin') {
    throw new ForbiddenError(
      'forbidden',
      'Platform admins cannot be managed through the API',
    );
  }

  if (actor.role === 'platform-admin') {
    return;
  }

  if (actor.role === 'tenant-admin' && target.role === 'viewer') {
    return;
  }

  throw new ForbiddenError(
    'forbidden',
    `A ${actor.role} cannot manage ${target.role} users`,
  );
}
