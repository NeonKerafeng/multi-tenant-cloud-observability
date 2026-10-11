import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../common/db/base.repository';
import type { Queryable } from '../../common/db/database.service';

export type SupportAccessRole = 'Viewer' | 'Editor';

export interface SupportAccessRecord {
  id: string;
  userId: string;
  username: string;
  tenantId: string;
  tenantKey: string;
  role: SupportAccessRole;
  reason: string;
  grantedBy: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
}

/** A grant in effect right now, with its tenant's Grafana org. */
export interface ActiveSupportGrant {
  grafanaOrgId: number;
  role: SupportAccessRole;
}

export interface NewSupportAccess {
  userId: string;
  tenantId: string;
  role: SupportAccessRole;
  reason: string;
  grantedBy: string;
  minutes: number;
}

interface SupportAccessRow {
  id: string;
  user_id: string;
  username: string;
  tenant_id: string;
  tenant_key: string;
  role: SupportAccessRole;
  reason: string;
  granted_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

const SELECT = `
  SELECT s.id, s.user_id, u.username, s.tenant_id, t.tenant_key, s.role,
         s.reason, s.granted_by, s.created_at, s.expires_at, s.revoked_at,
         s.revoked_by
  FROM support_access s
  JOIN users u ON u.id = s.user_id
  JOIN tenants t ON t.id = s.tenant_id
`;

/**
 * Time-boxed access of platform admins to tenant Grafana orgs (model C,
 * D-04). Rows are never deleted: they are the audit log.
 * `expiry_synced_at` = the end of the grant has been enqueued to the
 * outbox (by revoke, by the sweeper, or by a tenant delete).
 */
@Injectable()
export class SupportAccessRepository extends BaseRepository<
  SupportAccessRow,
  SupportAccessRecord
> {
  /** Grants in effect now for this user, on active tenants with an org. */
  async findActiveGrantsForUser(userId: string): Promise<ActiveSupportGrant[]> {
    const result = await this.db.query<{
      grafana_org_id: string;
      role: SupportAccessRole;
    }>(
      `SELECT t.grafana_org_id, s.role
       FROM support_access s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE s.user_id = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND t.status = 'active'
         AND t.grafana_org_id IS NOT NULL`,
      [userId],
    );

    return result.rows.map((row) => ({
      grafanaOrgId: Number(row.grafana_org_id),
      role: row.role,
    }));
  }

  async countActive(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM support_access
       WHERE revoked_at IS NULL AND expires_at > now()`,
    );

    return Number(result.rows[0]?.count ?? 0);
  }

  /** Users holding a grant on this tenant whose end is not synced yet. */
  async findOpenUserIdsByTenant(tenantId: string): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM support_access
       WHERE tenant_id = $1 AND expiry_synced_at IS NULL`,
      [tenantId],
    );

    return result.rows.map((row) => row.user_id);
  }

  async create(q: Queryable, grant: NewSupportAccess): Promise<string> {
    const [id] = await this.ids(
      `INSERT INTO support_access (user_id, tenant_id, role, reason, granted_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))
       RETURNING id`,
      [
        grant.userId,
        grant.tenantId,
        grant.role,
        grant.reason,
        grant.grantedBy,
        grant.minutes,
      ],
      q,
    );

    return id;
  }

  findById(id: string, q?: Queryable): Promise<SupportAccessRecord | null> {
    return this.one(`${SELECT} WHERE s.id = $1`, [id], q);
  }

  /** Newest first. tenantId = null lists every tenant. */
  list(
    tenantId: string | null,
    activeOnly: boolean,
    limit = 200,
  ): Promise<SupportAccessRecord[]> {
    return this.many(
      `${SELECT}
       WHERE ($1::uuid IS NULL OR s.tenant_id = $1::uuid)
         AND (NOT $2::boolean OR (s.revoked_at IS NULL AND s.expires_at > now()))
       ORDER BY s.created_at DESC
       LIMIT $3`,
      [tenantId, activeOnly, limit],
    );
  }

  /**
   * Ends a grant still in effect. Returns its user id, or null when it was
   * already revoked or expired.
   */
  async revoke(
    q: Queryable,
    id: string,
    revokedBy: string,
  ): Promise<string | null> {
    const result = await q.query<{ user_id: string }>(
      `UPDATE support_access
       SET revoked_at = now(), revoked_by = $2, expiry_synced_at = now()
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [id, revokedBy],
    );

    return result.rows[0]?.user_id ?? null;
  }

  /** Tenant delete: ends every open grant of the tenant. Returns user ids. */
  async revokeOpenForTenant(
    q: Queryable,
    tenantId: string,
    revokedBy: string,
  ): Promise<string[]> {
    const result = await q.query<{ user_id: string }>(
      `UPDATE support_access
       SET revoked_at = COALESCE(revoked_at, CASE WHEN expires_at > now() THEN now() END),
           revoked_by = COALESCE(revoked_by, CASE WHEN expires_at > now() THEN $2 END),
           expiry_synced_at = now()
       WHERE tenant_id = $1 AND expiry_synced_at IS NULL
       RETURNING user_id`,
      [tenantId, revokedBy],
    );

    return [...new Set(result.rows.map((row) => row.user_id))];
  }

  /**
   * Claims grants that expired and whose end is not synced yet. Atomic
   * per row, so concurrent replicas never claim the same grant.
   */
  async claimExpired(
    q: Queryable,
    limit = 100,
  ): Promise<{ id: string; userId: string }[]> {
    const result = await q.query<{ id: string; user_id: string }>(
      `UPDATE support_access SET expiry_synced_at = now()
       WHERE id IN (
         SELECT id FROM support_access
         WHERE expiry_synced_at IS NULL AND expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, user_id`,
      [limit],
    );

    return result.rows.map((row) => ({ id: row.id, userId: row.user_id }));
  }

  protected map(row: SupportAccessRow): SupportAccessRecord {
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      tenantId: row.tenant_id,
      tenantKey: row.tenant_key,
      role: row.role,
      reason: row.reason,
      grantedBy: row.granted_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
    };
  }
}
