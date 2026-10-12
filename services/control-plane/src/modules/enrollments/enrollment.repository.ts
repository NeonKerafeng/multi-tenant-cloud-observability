import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../common/db/base.repository';
import type { Queryable } from '../../common/db/database.service';

export interface EnrollmentRecord {
  id: string;
  tenantId: string;
  tenantKey: string;
  /** The agent this enrollment creates (assigned at creation). */
  agentId: string;
  createdBy: string;
  createdByUsername: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedByUsername: string | null;
  /** expires_at <= now() of the DATABASE clock (one clock for all pods). */
  expired: boolean;
}

export interface NewEnrollment {
  tenantId: string;
  tokenHash: string;
  agentId: string;
  createdBy: string;
  ttlMinutes: number;
}

interface EnrollmentRow {
  id: string;
  tenant_id: string;
  tenant_key: string;
  agent_id: string;
  created_by: string;
  created_by_username: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  revoked_by_username: string | null;
  expired: boolean;
}

const SELECT = `
  SELECT e.id, e.tenant_id, t.tenant_key, e.agent_id, e.created_by,
         cu.username AS created_by_username, e.created_at, e.expires_at,
         e.used_at, e.revoked_at, ru.username AS revoked_by_username,
         (e.expires_at <= now()) AS expired
  FROM agent_enrollments e
  JOIN tenants t ON t.id = e.tenant_id
  JOIN users cu ON cu.id = e.created_by
  LEFT JOIN users ru ON ru.id = e.revoked_by
`;

/** Newest first; enough for the CLI and a future UI page. */
const LIST_LIMIT = 100;

@Injectable()
export class EnrollmentRepository extends BaseRepository<
  EnrollmentRow,
  EnrollmentRecord
> {
  async create(
    q: Queryable,
    enrollment: NewEnrollment,
  ): Promise<EnrollmentRecord> {
    const [id] = await this.ids(
      `INSERT INTO agent_enrollments (tenant_id, token_hash, agent_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
       RETURNING id`,
      [
        enrollment.tenantId,
        enrollment.tokenHash,
        enrollment.agentId,
        enrollment.createdBy,
        enrollment.ttlMinutes,
      ],
      q,
    );

    return (await this.findById(id, q)) as EnrollmentRecord;
  }

  findById(id: string, q?: Queryable): Promise<EnrollmentRecord | null> {
    return this.one(`${SELECT} WHERE e.id = $1`, [id], q);
  }

  listByTenant(tenantId: string): Promise<EnrollmentRecord[]> {
    return this.many(
      `${SELECT} WHERE e.tenant_id = $1 ORDER BY e.created_at DESC LIMIT ${LIST_LIMIT}`,
      [tenantId],
    );
  }

  /**
   * The exchange's lock: a second exchange of the same token waits here
   * until the first commits (then sees used_at) or rolls back (then may
   * retry). Locks only the enrollment row.
   */
  lockByTokenHash(
    q: Queryable,
    tokenHash: string,
  ): Promise<EnrollmentRecord | null> {
    return this.one(
      `${SELECT} WHERE e.token_hash = $1 FOR UPDATE OF e`,
      [tokenHash],
      q,
    );
  }

  async markUsed(q: Queryable, id: string): Promise<void> {
    await this.exec(
      `UPDATE agent_enrollments SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
      [id],
      q,
    );
  }

  /** Revokes an unused, not yet revoked enrollment; false if not. */
  async revoke(q: Queryable, id: string, userId: string): Promise<boolean> {
    return (
      (await this.exec(
        `UPDATE agent_enrollments SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
        [id, userId],
        q,
      )) === 1
    );
  }

  /** Cascade of a tenant delete: unused tokens stop working. */
  revokeOpenForTenant(
    q: Queryable,
    tenantId: string,
    userId: string,
  ): Promise<number> {
    return this.exec(
      `UPDATE agent_enrollments SET revoked_at = now(), revoked_by = $2
       WHERE tenant_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [tenantId, userId],
      q,
    );
  }

  /**
   * Agent ids an exchange may still create (unused, unrevoked, unexpired):
   * their Keycloak client may exist before the agent row (GC must wait).
   */
  openAgentIds(): Promise<string[]> {
    return this.ids(
      `SELECT agent_id AS id FROM agent_enrollments
       WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    );
  }

  protected map(row: EnrollmentRow): EnrollmentRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tenantKey: row.tenant_key,
      agentId: row.agent_id,
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
      revokedByUsername: row.revoked_by_username,
      expired: row.expired,
    };
  }
}
