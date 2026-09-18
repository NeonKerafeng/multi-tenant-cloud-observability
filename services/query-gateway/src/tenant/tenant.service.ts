import {
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-user';
import type { TenantContext } from './tenant-context';

@Injectable()
export class TenantService {
  resolve(
    user: AuthUser,
    requestedTenant?: string,
  ): TenantContext {
    const platformAdmin =
      user.roles.includes('platform-admin');

    if (platformAdmin) {
      return {
        tenantId: requestedTenant?.trim() || null,
        platformAdmin: true,
      };
    }

    const allowedRole =
      user.roles.includes('viewer') ||
      user.roles.includes('tenant-admin');

    if (!allowedRole) {
      throw new ForbiddenException(
        'User has no observability role',
      );
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
      tenantId: groups[0],
      platformAdmin: false,
    };
  }
}