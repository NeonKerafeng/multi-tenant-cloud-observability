import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-user';

const OBSERVABILITY_ROLES = ['platform-admin', 'tenant-admin', 'viewer'];

export interface QueryAccess {
  platformAdmin: boolean;

  /** Tenant key (Keycloak group name). null only for platform-admin. */
  tenantId: string | null;
}

/**
 * Resolves who the caller is for query purposes.
 *
 * - platform-admin: unrestricted (tenantId = null)
 * - tenant-admin / viewer: bound to exactly one tenant group
 * - anyone else: rejected
 */
export function resolveQueryAccess(user: AuthUser): QueryAccess {
  if (!user.roles.some((role) => OBSERVABILITY_ROLES.includes(role))) {
    throw new ForbiddenException('User has no observability role');
  }

  if (user.roles.includes('platform-admin')) {
    return {
      platformAdmin: true,
      tenantId: null,
    };
  }

  const groups = user.groups
    .map((group) => group.replace(/^\/+/, ''))
    .filter(Boolean);

  if (groups.length !== 1) {
    throw new ForbiddenException(
      'User must belong to exactly one tenant group',
    );
  }

  return {
    platformAdmin: false,
    tenantId: groups[0],
  };
}
