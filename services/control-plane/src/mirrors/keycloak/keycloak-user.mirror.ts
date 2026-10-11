import { Injectable, Logger } from '@nestjs/common';

import { ROLES } from '../../common/auth/actor';
import type { Queryable } from '../../common/db/database.service';
import { ConflictError } from '../../common/errors/domain-error';
import { isUuid } from '../../common/http/validation';
import { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import {
  attr,
  type KcUser,
  USER_MARKER,
} from '../../integrations/keycloak/keycloak.types';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import {
  type UserRecord,
  UserRepository,
} from '../../modules/users/user.repository';
import type { MirrorHandler } from '../../sync/mirror';

export interface UserApplyOptions {
  /** Inline create only. Set on the Keycloak account, never stored. */
  password?: string;
  /** Caller's transaction (inline create). */
  q?: Queryable;
}

/**
 * Human user → Keycloak user (FROZEN contract, §18.3.5):
 * - exists while the row is active; enabled follows the row (disabling
 *   also ends every session);
 * - tenant users are members of EXACTLY their tenant group; platform
 *   admins of no group;
 * - realm roles: exactly the row's role among the three MTCO roles
 *   (Keycloak's default roles are left alone);
 * - attribute mtco_user_id = [users.id] marks the account as ours.
 * Deleted rows: the Keycloak account is deleted and the pointer cleared.
 */
@Injectable()
export class KeycloakUserMirror implements MirrorHandler {
  readonly target = 'keycloak' as const;
  readonly aggregate = 'user' as const;

  private readonly logger = new Logger(KeycloakUserMirror.name);

  constructor(
    private readonly keycloak: KeycloakClient,
    private readonly users: UserRepository,
    private readonly tenants: TenantRepository,
  ) {}

  async sync(userId: string): Promise<void> {
    const user = await this.users.findById(userId);

    if (user) {
      await this.apply(user);
    }
  }

  /** Returns the Keycloak user id (null once deleted). */
  async apply(
    user: UserRecord,
    options: UserApplyOptions = {},
  ): Promise<string | null> {
    if (user.status === 'deleted') {
      await this.remove(user, options.q);
      return null;
    }

    const groupId = await this.desiredGroupId(user);
    const existing = await this.resolveForWrite(user);

    /*
     * Rows created before migration 005 have no names: take them over from
     * Keycloak once instead of erasing them there.
     */
    let firstName = user.firstName;
    let lastName = user.lastName;

    if (existing && (firstName === null || lastName === null)) {
      firstName ??= existing.firstName ?? null;
      lastName ??= existing.lastName ?? null;

      if (firstName !== user.firstName || lastName !== user.lastName) {
        await this.users.setNames(user.id, firstName, lastName, options.q);
      }
    }

    const desired = {
      username: user.username,
      email: user.email,
      firstName: firstName ?? undefined,
      lastName: lastName ?? undefined,
      enabled: user.enabled,
      emailVerified: true,
    };

    let id: string;

    if (!existing) {
      const created = await this.keycloak.createUser({
        ...desired,
        attributes: { [USER_MARKER]: [user.id] },
        requiredActions: [],
      });

      if (!created) {
        throw new ConflictError(
          'identity_conflict',
          `Keycloak already has an account with username "${user.username}" or email "${user.email}" that MTCO does not manage`,
        );
      }

      id = created;
      await this.assertMarker(id, user);
      this.logger.log(`${user.username}: Keycloak account created`);
    } else {
      id = existing.id;

      const attributes = {
        ...(existing.attributes ?? {}),
        [USER_MARKER]: [user.id],
      };
      const markerMissing = attr(existing.attributes, USER_MARKER) !== user.id;

      if (markerMissing || differs(existing, desired)) {
        await this.keycloak.updateUser({ ...existing, ...desired, attributes });

        if (markerMissing) {
          await this.assertMarker(id, user);
        }
      }
    }

    if (options.password !== undefined) {
      await this.keycloak.resetPassword(id, options.password);
    }

    await this.syncGroups(id, groupId);
    await this.syncRoles(id, user);

    if (!user.enabled) {
      await this.keycloak.logoutUser(id);
    }

    if (id !== user.keycloakUserId) {
      await this.users.setKeycloakUserId(user.id, id, options.q);
    }

    return id;
  }

  private async remove(user: UserRecord, q?: Queryable): Promise<void> {
    const account = await this.ownedAccount(user);

    if (account) {
      await this.keycloak.deleteUser(account.id);
      this.logger.log(`${user.username}: Keycloak account deleted`);
    }

    if (user.keycloakUserId !== null) {
      await this.users.setKeycloakUserId(user.id, null, q);
    }
  }

  private async desiredGroupId(user: UserRecord): Promise<string | null> {
    if (user.role === 'platform-admin') {
      return null;
    }

    const tenant = user.tenantId
      ? await this.tenants.findById(user.tenantId)
      : null;

    if (!tenant?.keycloakGroupId) {
      // Retried by the outbox once the tenant group exists.
      throw new Error(
        `Keycloak group of tenant ${user.tenantKey ?? '?'} is not ready yet`,
      );
    }

    return tenant.keycloakGroupId;
  }

  private async syncGroups(id: string, groupId: string | null): Promise<void> {
    const current = await this.keycloak.getUserGroups(id);

    for (const group of current) {
      if (group.id !== groupId) {
        await this.keycloak.removeUserFromGroup(id, group.id);
      }
    }

    if (groupId && !current.some((group) => group.id === groupId)) {
      await this.keycloak.addUserToGroup(id, groupId);
    }
  }

  private async syncRoles(id: string, user: UserRecord): Promise<void> {
    const current = (await this.keycloak.getUserRealmRoles(id)).map(
      (role) => role.name,
    );

    const add = current.includes(user.role)
      ? []
      : [await this.keycloak.realmRole(user.role)];

    const remove = await Promise.all(
      ROLES.filter((role) => role !== user.role && current.includes(role)).map(
        (role) => this.keycloak.realmRole(role),
      ),
    );

    await this.keycloak.addUserRealmRoles(id, add);
    await this.keycloak.removeUserRealmRoles(id, remove);
  }

  /**
   * Keycloak (≥ 24) silently drops attributes that the realm user profile
   * does not allow. keycloak-bootstrap sets unmanagedAttributePolicy =
   * ADMIN_EDIT; fail loudly if that is missing.
   */
  private async assertMarker(id: string, user: UserRecord): Promise<void> {
    const saved = await this.keycloak.getUser(id);

    if (attr(saved?.attributes, USER_MARKER) !== user.id) {
      throw new Error(
        `Keycloak dropped attribute ${USER_MARKER} of ${user.username}: is the realm user profile unmanagedAttributePolicy set to ADMIN_EDIT (keycloak-bootstrap)?`,
      );
    }
  }

  /** Adoption rules (§18.3.7) for create/update. */
  private async resolveForWrite(user: UserRecord): Promise<KcUser | null> {
    const stored = await this.storedAccount(user);

    if (stored) {
      return stored;
    }

    const byName = await this.keycloak.findUserByUsername(user.username);

    if (!byName) {
      return null;
    }

    const marker = attr(byName.attributes, USER_MARKER);

    if (marker === user.id) {
      return byName;
    }

    if (!marker) {
      throw new ConflictError(
        'identity_conflict',
        `Keycloak account "${user.username}" exists but is not managed by MTCO`,
      );
    }

    const owner = isUuid(marker) ? await this.users.findById(marker) : null;

    if (owner && owner.status === 'active') {
      throw new ConflictError(
        'identity_conflict',
        `Keycloak account "${user.username}" belongs to another MTCO user`,
      );
    }

    this.logger.warn(
      `${user.username}: adopting orphan Keycloak account ${byName.id}`,
    );

    return byName;
  }

  /** The account this row may DELETE: only one that is provably ours. */
  private async ownedAccount(user: UserRecord): Promise<KcUser | null> {
    const stored = await this.storedAccount(user);

    if (stored) {
      return stored;
    }

    const byName = await this.keycloak.findUserByUsername(user.username);

    return byName && attr(byName.attributes, USER_MARKER) === user.id
      ? byName
      : null;
  }

  private async storedAccount(user: UserRecord): Promise<KcUser | null> {
    if (!user.keycloakUserId) {
      return null;
    }

    const account = await this.keycloak.getUser(user.keycloakUserId);

    if (!account) {
      return null;
    }

    const marker = attr(account.attributes, USER_MARKER);

    return marker === user.id ||
      (!marker &&
        account.username.toLowerCase() === user.username.toLowerCase())
      ? account
      : null;
  }
}

function differs(
  account: KcUser,
  desired: Pick<
    KcUser,
    'email' | 'firstName' | 'lastName' | 'enabled' | 'emailVerified'
  >,
): boolean {
  return (
    (account.email ?? '').toLowerCase() !==
      (desired.email ?? '').toLowerCase() ||
    (account.firstName ?? undefined) !== desired.firstName ||
    (account.lastName ?? undefined) !== desired.lastName ||
    account.enabled !== desired.enabled ||
    account.emailVerified !== desired.emailVerified
  );
}
