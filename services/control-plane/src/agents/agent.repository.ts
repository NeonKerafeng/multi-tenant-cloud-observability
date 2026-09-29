import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

export type AgentStatus =
  | 'provisioning'
  | 'active'
  | 'disabled'
  | 'revoked'
  | 'error';

export interface AgentRecord {
  agentId: string;
  tenantId: string;
  vmAccountId: string;
  clientId: string;
  clientUuid: string | null;
  status: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

interface AgentRow {
  agent_id: string;
  tenant_id: string;
  vm_account_id: string;
  client_id: string;
  client_uuid: string | null;
  status: AgentStatus;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

interface IdRow {
  id: string;
}

interface ExistsRow {
  exists: boolean;
}

@Injectable()
export class AgentRepository {
  constructor(
    private readonly db: DatabaseService,
  ) {}

  async findAll(
    tenantId?: string,
  ): Promise<AgentRecord[]> {
    const result =
      await this.db.query<AgentRow>(
        `
        SELECT
          a.id AS agent_id,
          t.tenant_key AS tenant_id,
          t.vm_account_id,
          a.keycloak_client_id AS client_id,
          a.keycloak_client_uuid AS client_uuid,
          a.status,
          a.created_at,
          a.updated_at,
          a.revoked_at
        FROM agents a
        JOIN tenants t
          ON t.id = a.tenant_id
        WHERE a.status <> 'revoked'
          AND (
            $1::text IS NULL
            OR t.tenant_key = $1
          )
        ORDER BY a.created_at
        `,
        [tenantId ?? null],
      );

    return result.rows.map(
      (row) => this.map(row),
    );
  }

  async findById(
    agentId: string,
  ): Promise<AgentRecord | null> {
    const result =
      await this.db.query<AgentRow>(
        `
        SELECT
          a.id AS agent_id,
          t.tenant_key AS tenant_id,
          t.vm_account_id,
          a.keycloak_client_id AS client_id,
          a.keycloak_client_uuid AS client_uuid,
          a.status,
          a.created_at,
          a.updated_at,
          a.revoked_at
        FROM agents a
        JOIN tenants t
          ON t.id = a.tenant_id
        WHERE a.id = $1
          AND a.status <> 'revoked'
        `,
        [agentId],
      );

    const row = result.rows[0];

    return row
      ? this.map(row)
      : null;
  }

  async createProvisioning(
    agentId: string,
    tenantId: string,
  ): Promise<AgentRecord | null> {
    const clientId =
      `otel-agent-${agentId}`;

    const result =
      await this.db.query<IdRow>(
        `
        INSERT INTO agents (
          id,
          tenant_id,
          keycloak_client_id,
          status
        )
        SELECT
          $1::uuid,
          t.id,
          $2,
          'provisioning'
        FROM tenants t
        WHERE t.tenant_key = $3
          AND t.status = 'active'
        RETURNING id
        `,
        [
          agentId,
          clientId,
          tenantId,
        ],
      );

    if (result.rows.length === 0) {
      return null;
    }

    return this.findById(agentId);
  }

  async markActive(
    agentId: string,
    clientUuid: string,
  ): Promise<AgentRecord | null> {
    await this.db.query(
      `
      UPDATE agents
      SET
        keycloak_client_uuid = $2,
        status = 'active'
      WHERE id = $1
      `,
      [
        agentId,
        clientUuid,
      ],
    );

    return this.findById(agentId);
  }

  async markError(
    agentId: string,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE agents
      SET status = 'error'
      WHERE id = $1
      `,
      [agentId],
    );
  }

  async setStatus(
    agentId: string,
    status: 'active' | 'disabled',
  ): Promise<AgentRecord | null> {
    await this.db.query(
      `
      UPDATE agents
      SET status = $2
      WHERE id = $1
        AND status <> 'revoked'
      `,
      [
        agentId,
        status,
      ],
    );

    return this.findById(agentId);
  }

  async markRevoked(
    agentId: string,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE agents
      SET
        status = 'revoked',
        revoked_at = now()
      WHERE id = $1
      `,
      [agentId],
    );
  }

  async hasLiveAgentsForTenant(
    tenantId: string,
  ): Promise<boolean> {
    const result =
      await this.db.query<ExistsRow>(
        `
        SELECT EXISTS (
          SELECT 1
          FROM agents a
          JOIN tenants t
            ON t.id = a.tenant_id
          WHERE t.tenant_key = $1
            AND a.status IN (
              'provisioning',
              'active',
              'disabled'
            )
        ) AS exists
        `,
        [tenantId],
      );

    return result.rows[0]?.exists ?? false;
  }

  private map(
    row: AgentRow,
  ): AgentRecord {
    return {
      agentId: row.agent_id,
      tenantId: row.tenant_id,
      vmAccountId:
        String(row.vm_account_id),
      clientId: row.client_id,
      clientUuid: row.client_uuid,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
    };
  }
}
