import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../common/db/base.repository';
import type { Queryable } from '../../common/db/database.service';

/**
 * provisioning = credentials being issued (the Keycloak client may not be
 *                complete yet); active / disabled; revoked = soft-deleted.
 */
export type AgentStatus = 'provisioning' | 'active' | 'disabled' | 'revoked';

export interface AgentRecord {
  id: string;
  tenantId: string;
  tenantKey: string;
  vmAccountId: string;
  clientId: string;
  clientUuid: string | null;
  status: AgentStatus;
  createdAt: Date;
  revokedAt: Date | null;
}

interface AgentRow {
  id: string;
  tenant_id: string;
  tenant_key: string;
  vm_account_id: string;
  keycloak_client_id: string;
  keycloak_client_uuid: string | null;
  status: AgentStatus;
  created_at: Date;
  revoked_at: Date | null;
}

const SELECT = `
  SELECT a.id, a.tenant_id, t.tenant_key, t.vm_account_id, a.keycloak_client_id,
         a.keycloak_client_uuid, a.status, a.created_at, a.revoked_at
  FROM agents a
  JOIN tenants t ON t.id = a.tenant_id
`;

export function agentClientId(agentId: string): string {
  return `otel-agent-${agentId}`;
}

@Injectable()
export class AgentRepository extends BaseRepository<AgentRow, AgentRecord> {
  /** Any status (mirrors need revoked agents too). */
  findById(id: string, q?: Queryable): Promise<AgentRecord | null> {
    return this.one(`${SELECT} WHERE a.id = $1`, [id], q);
  }

  /** Not revoked: what the API shows. */
  findLiveById(id: string): Promise<AgentRecord | null> {
    return this.one(`${SELECT} WHERE a.id = $1 AND a.status <> 'revoked'`, [
      id,
    ]);
  }

  listLiveByTenant(tenantId: string): Promise<AgentRecord[]> {
    return this.many(
      `${SELECT} WHERE a.tenant_id = $1 AND a.status <> 'revoked' ORDER BY a.created_at`,
      [tenantId],
    );
  }

  listLive(): Promise<AgentRecord[]> {
    return this.many(
      `${SELECT} WHERE a.status <> 'revoked' AND t.status = 'active' ORDER BY a.created_at`,
    );
  }

  async insert(
    q: Queryable,
    agent: { id: string; tenantId: string; status: AgentStatus },
  ): Promise<AgentRecord> {
    await this.exec(
      `INSERT INTO agents (id, tenant_id, keycloak_client_id, status) VALUES ($1, $2, $3, $4)`,
      [agent.id, agent.tenantId, agentClientId(agent.id), agent.status],
      q,
    );

    return (await this.findById(agent.id, q)) as AgentRecord;
  }

  async setStatus(
    q: Queryable,
    id: string,
    status: Exclude<AgentStatus, 'revoked'>,
  ): Promise<void> {
    await this.exec(
      `UPDATE agents SET status = $2 WHERE id = $1 AND status <> 'revoked'`,
      [id, status],
      q,
    );
  }

  async markRevoked(q: Queryable, id: string): Promise<void> {
    await this.exec(
      `UPDATE agents SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
      [id],
      q,
    );
  }

  /** Cascade of a tenant delete (decision Q1). Returns the ids that changed. */
  revokeTenantAgents(q: Queryable, tenantId: string): Promise<string[]> {
    return this.ids(
      `UPDATE agents SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
       WHERE tenant_id = $1 AND status <> 'revoked'
       RETURNING id`,
      [tenantId],
      q,
    );
  }

  async setClientUuid(
    id: string,
    clientUuid: string | null,
    q?: Queryable,
  ): Promise<void> {
    await this.exec(
      `UPDATE agents SET keycloak_client_uuid = $2 WHERE id = $1`,
      [id, clientUuid],
      q,
    );
  }

  /** Pointer rule: live agents + revoked ones whose client is not deleted yet. */
  findIdsForResync(): Promise<string[]> {
    return this.ids(
      `SELECT id FROM agents
       WHERE status <> 'revoked' OR keycloak_client_uuid IS NOT NULL
       ORDER BY created_at`,
    );
  }

  protected map(row: AgentRow): AgentRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tenantKey: row.tenant_key,
      vmAccountId: String(row.vm_account_id),
      clientId: row.keycloak_client_id,
      clientUuid: row.keycloak_client_uuid,
      status: row.status,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }
}
