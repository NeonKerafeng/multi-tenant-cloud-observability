import { Injectable } from '@nestjs/common';

import type { Role } from '../../common/auth/actor';
import { BaseRepository } from '../../common/db/base.repository';
import type { Queryable } from '../../common/db/database.service';

export type UserStatus = 'active' | 'deleted';

export interface UserRecord {
  id: string;
  keycloakUserId: string | null;
  tenantId: string | null;
  tenantKey: string | null;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: Role;
  enabled: boolean;
  grafanaUserId: number | null;
  status: UserStatus;
  createdAt: Date;
}

export interface NewUser {
  tenantId: string | null;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: Role;
}

interface UserRow {
  id: string;
  keycloak_user_id: string | null;
  tenant_id: string | null;
  tenant_key: string | null;
  username: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: Role;
  enabled: boolean;
  grafana_user_id: string | null;
  status: UserStatus;
  created_at: Date;
}

const SELECT = `
  SELECT u.id, u.keycloak_user_id, u.tenant_id, t.tenant_key, u.username,
         u.email, u.first_name, u.last_name, u.role, u.enabled,
         u.grafana_user_id, u.status, u.created_at
  FROM users u
  LEFT JOIN tenants t ON t.id = u.tenant_id
`;

/** Unique indexes from migration 005 (active users only, case-insensitive). */
export const USERNAME_CONSTRAINT = 'uq_users_active_username';
export const EMAIL_CONSTRAINT = 'uq_users_active_email';

/**
 * Human users. control-plane is the source of truth for who belongs to
 * which tenant with which role; Keycloak and Grafana are mirrors.
 */
@Injectable()
export class UserRepository extends BaseRepository<UserRow, UserRecord> {
  findById(id: string, q?: Queryable): Promise<UserRecord | null> {
    return this.one(`${SELECT} WHERE u.id = $1`, [id], q);
  }

  /** The caller of an API request (AuthGuard). */
  findActiveByKeycloakId(keycloakUserId: string): Promise<UserRecord | null> {
    return this.one(
      `${SELECT} WHERE u.keycloak_user_id = $1 AND u.status = 'active'`,
      [keycloakUserId],
    );
  }

  listActiveByTenant(tenantId: string): Promise<UserRecord[]> {
    return this.many(
      `${SELECT} WHERE u.tenant_id = $1 AND u.status = 'active' ORDER BY u.created_at`,
      [tenantId],
    );
  }

  findActiveInTenant(
    tenantId: string,
    userId: string,
  ): Promise<UserRecord | null> {
    return this.one(
      `${SELECT} WHERE u.tenant_id = $1 AND u.id = $2 AND u.status = 'active'`,
      [tenantId, userId],
    );
  }

  /** Most recent row for a username (any status). */
  findLatestByUsername(username: string): Promise<UserRecord | null> {
    return this.one(
      `${SELECT} WHERE lower(u.username) = lower($1) ORDER BY u.created_at DESC LIMIT 1`,
      [username],
    );
  }

  async countActivePlatformAdmins(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM users WHERE role = 'platform-admin' AND status = 'active'`,
    );

    return Number(result.rows[0]?.count ?? 0);
  }

  /** Throws 23505 on a duplicate active username/email. */
  async insert(q: Queryable, user: NewUser): Promise<UserRecord> {
    const [id] = await this.ids(
      `INSERT INTO users (tenant_id, username, email, first_name, last_name, role, enabled, status)
       VALUES ($1, $2, $3, $4, $5, $6, true, 'active')
       RETURNING id`,
      [
        user.tenantId,
        user.username,
        user.email,
        user.firstName,
        user.lastName,
        user.role,
      ],
      q,
    );

    return (await this.findById(id, q)) as UserRecord;
  }

  async setEnabled(q: Queryable, id: string, enabled: boolean): Promise<void> {
    await this.exec(
      `UPDATE users SET enabled = $2 WHERE id = $1`,
      [id, enabled],
      q,
    );
  }

  async markDeleted(q: Queryable, id: string): Promise<void> {
    await this.exec(
      `UPDATE users SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`,
      [id],
      q,
    );
  }

  /** Cascade of a tenant delete. Returns the ids that changed. */
  markTenantUsersDeleted(q: Queryable, tenantId: string): Promise<string[]> {
    return this.ids(
      `UPDATE users SET status = 'deleted', deleted_at = COALESCE(deleted_at, now())
       WHERE tenant_id = $1 AND status = 'active'
       RETURNING id`,
      [tenantId],
      q,
    );
  }

  async setNames(
    id: string,
    firstName: string | null,
    lastName: string | null,
    q?: Queryable,
  ): Promise<void> {
    await this.exec(
      `UPDATE users SET first_name = $2, last_name = $3 WHERE id = $1`,
      [id, firstName, lastName],
      q,
    );
  }

  async setKeycloakUserId(
    id: string,
    keycloakUserId: string | null,
    q?: Queryable,
  ): Promise<void> {
    await this.exec(
      `UPDATE users SET keycloak_user_id = $2 WHERE id = $1`,
      [id, keycloakUserId],
      q,
    );
  }

  async setGrafanaUserId(
    id: string,
    grafanaUserId: number | null,
  ): Promise<void> {
    await this.exec(`UPDATE users SET grafana_user_id = $2 WHERE id = $1`, [
      id,
      grafanaUserId,
    ]);
  }

  /** Every user row of a tenant (any status): the Grafana tenant fan-out. */
  findIdsByTenant(tenantId: string): Promise<string[]> {
    return this.ids(`SELECT id FROM users WHERE tenant_id = $1`, [tenantId]);
  }

  /** Pointer rule: live users + deleted ones with an unfinished cleanup. */
  /** The ids among `ids` whose row is active (Keycloak GC). */
  findActiveIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return this.ids(
      `SELECT id FROM users WHERE status = 'active' AND id = ANY($1::uuid[])`,
      [ids],
    );
  }

  findIdsForResync(): Promise<string[]> {
    return this.ids(
      `SELECT id FROM users
       WHERE status = 'active'
          OR keycloak_user_id IS NOT NULL
          OR grafana_user_id IS NOT NULL
       ORDER BY created_at`,
    );
  }

  protected map(row: UserRow): UserRecord {
    return {
      id: row.id,
      keycloakUserId: row.keycloak_user_id,
      tenantId: row.tenant_id,
      tenantKey: row.tenant_key,
      username: row.username,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      enabled: row.enabled,
      grafanaUserId:
        row.grafana_user_id === null ? null : Number(row.grafana_user_id),
      status: row.status,
      createdAt: row.created_at,
    };
  }
}
