import { Injectable } from '@nestjs/common';

import {
  DatabaseService,
  type Queryable,
} from '../database/database.service';

export type UserRole =
  | 'platform-admin'
  | 'tenant-admin'
  | 'viewer';

export interface UserRecord {
  id: string;
  keycloakUserId: string;
  tenantId: string | null;
  tenantKey: string | null;
  username: string;
  email: string;
  role: UserRole;
  enabled: boolean;
  grafanaUserId: number | null;
  status: 'active' | 'deleted';
}

export interface UserIdentity {
  keycloakUserId: string;
  username: string;
  email: string;
  enabled: boolean;
}

interface UserRow {
  id: string;
  keycloak_user_id: string;
  tenant_id: string | null;
  tenant_key: string | null;
  username: string;
  email: string;
  role: UserRole;
  enabled: boolean;
  grafana_user_id: string | null;
  status: 'active' | 'deleted';
}

const SELECT_USER = `
  SELECT
    u.id,
    u.keycloak_user_id,
    u.tenant_id,
    t.tenant_key,
    u.username,
    u.email,
    u.role,
    u.enabled,
    u.grafana_user_id,
    u.status
  FROM users u
  LEFT JOIN tenants t
    ON t.id = u.tenant_id
`;

/**
 * Human users. control-plane is the source of truth for who belongs to
 * which tenant with which role; Keycloak and Grafana are mirrors.
 */
@Injectable()
export class UserRepository {
  constructor(
    private readonly db: DatabaseService,
  ) {}

  async findById(
    id: string,
  ): Promise<UserRecord | null> {
    const result =
      await this.db.query<UserRow>(
        `${SELECT_USER} WHERE u.id = $1`,
        [id],
      );

    return result.rows[0]
      ? this.map(result.rows[0])
      : null;
  }

  async findIdsForSync(): Promise<string[]> {
    const result =
      await this.db.query<{ id: string }>(
        `
        SELECT id
        FROM users
        WHERE status = 'active'
           OR grafana_user_id IS NOT NULL
        `,
      );

    return result.rows.map((row) => row.id);
  }

  async findIdsByTenant(
    tenantId: string,
  ): Promise<string[]> {
    const result =
      await this.db.query<{ id: string }>(
        `
        SELECT id
        FROM users
        WHERE tenant_id = $1
        `,
        [tenantId],
      );

    return result.rows.map((row) => row.id);
  }

  async findPlatformAdminIds(): Promise<string[]> {
    const result =
      await this.db.query<{ id: string }>(
        `
        SELECT id
        FROM users
        WHERE role = 'platform-admin'
          AND status = 'active'
        `,
      );

    return result.rows.map((row) => row.id);
  }

  /**
   * Creates or (re)activates the user row for a Keycloak identity and
   * returns its id. Used by the users API inside a transaction.
   */
  async upsertActive(
    q: Queryable,
    identity: UserIdentity,
    tenantId: string | null,
    role: UserRole,
  ): Promise<string> {
    const result =
      await q.query<{ id: string }>(
        `
        INSERT INTO users (
          keycloak_user_id,
          tenant_id,
          username,
          email,
          role,
          enabled,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active')
        ON CONFLICT (keycloak_user_id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          enabled = EXCLUDED.enabled,
          status = 'active',
          deleted_at = NULL
        RETURNING id
        `,
        [
          identity.keycloakUserId,
          tenantId,
          identity.username,
          identity.email,
          role,
          identity.enabled,
        ],
      );

    return result.rows[0].id;
  }

  /**
   * Adopts a Keycloak identity that control-plane does not know yet
   * (users created before this table existed, platform admins).
   * Known rows only get their identity attributes refreshed; tenant,
   * role and status stay owned by control-plane, and deleted rows are
   * never resurrected. Returns the row id.
   */
  async adopt(
    identity: UserIdentity,
    tenantId: string | null,
    role: UserRole,
  ): Promise<string> {
    const result =
      await this.db.query<{ id: string }>(
        `
        INSERT INTO users (
          keycloak_user_id,
          tenant_id,
          username,
          email,
          role,
          enabled,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active')
        ON CONFLICT (keycloak_user_id) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          enabled = CASE
            WHEN users.status = 'active' THEN EXCLUDED.enabled
            ELSE users.enabled
          END
        RETURNING id
        `,
        [
          identity.keycloakUserId,
          tenantId,
          identity.username,
          identity.email,
          role,
          identity.enabled,
        ],
      );

    return result.rows[0].id;
  }

  async setEnabled(
    q: Queryable,
    keycloakUserId: string,
    enabled: boolean,
  ): Promise<string | null> {
    const result =
      await q.query<{ id: string }>(
        `
        UPDATE users
        SET enabled = $2
        WHERE keycloak_user_id = $1
        RETURNING id
        `,
        [
          keycloakUserId,
          enabled,
        ],
      );

    return result.rows[0]?.id ?? null;
  }

  async markDeleted(
    q: Queryable,
    keycloakUserId: string,
  ): Promise<string | null> {
    const result =
      await q.query<{ id: string }>(
        `
        UPDATE users
        SET
          status = 'deleted',
          deleted_at = now()
        WHERE keycloak_user_id = $1
        RETURNING id
        `,
        [keycloakUserId],
      );

    return result.rows[0]?.id ?? null;
  }

  async markTenantUsersDeleted(
    q: Queryable,
    tenantId: string,
  ): Promise<string[]> {
    const result =
      await q.query<{ id: string }>(
        `
        UPDATE users
        SET
          status = 'deleted',
          deleted_at = COALESCE(deleted_at, now())
        WHERE tenant_id = $1
        RETURNING id
        `,
        [tenantId],
      );

    return result.rows.map((row) => row.id);
  }

  async setGrafanaUserId(
    id: string,
    grafanaUserId: number | null,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE users
      SET grafana_user_id = $2
      WHERE id = $1
      `,
      [
        id,
        grafanaUserId,
      ],
    );
  }

  private map(
    row: UserRow,
  ): UserRecord {
    return {
      id: row.id,
      keycloakUserId: row.keycloak_user_id,
      tenantId: row.tenant_id,
      tenantKey: row.tenant_key,
      username: row.username,
      email: row.email,
      role: row.role,
      enabled: row.enabled,
      grafanaUserId:
        row.grafana_user_id === null
          ? null
          : Number(row.grafana_user_id),
      status: row.status,
    };
  }
}
