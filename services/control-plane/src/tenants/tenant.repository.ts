import {
  Injectable,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

export interface TenantRecord {
  id: string;
  tenantKey: string;
  vmAccountId: string;
  keycloakGroupId: string | null;

  status:
    | 'provisioning'
    | 'active'
    | 'error'
    | 'deleting'
    | 'deleted';

  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface TenantRow {
  id: string;
  tenant_key: string;
  vm_account_id: string;
  keycloak_group_id: string | null;
  status: TenantRecord['status'];
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

@Injectable()
export class TenantRepository {
  constructor(
    private readonly db: DatabaseService,
  ) {}

  async findAll(): Promise<TenantRecord[]> {
    const result =
      await this.db.query<TenantRow>(
        `
        SELECT
          id,
          tenant_key,
          vm_account_id,
          keycloak_group_id,
          status,
          created_at,
          updated_at,
          deleted_at
        FROM tenants
        WHERE deleted_at IS NULL
        ORDER BY vm_account_id
        `,
      );

    return result.rows.map(
      (row) => this.map(row),
    );
  }

  async findByKey(
    tenantKey: string,
  ): Promise<TenantRecord | null> {
    const result =
      await this.db.query<TenantRow>(
        `
        SELECT
          id,
          tenant_key,
          vm_account_id,
          keycloak_group_id,
          status,
          created_at,
          updated_at,
          deleted_at
        FROM tenants
        WHERE tenant_key = $1
        `,
        [tenantKey],
      );

    const row = result.rows[0];

    return row
      ? this.map(row)
      : null;
  }

  async createProvisioning(
    tenantKey: string,
  ): Promise<TenantRecord> {
    const result =
      await this.db.query<TenantRow>(
        `
        INSERT INTO tenants (
          tenant_key,
          status
        )
        VALUES (
          $1,
          'provisioning'
        )
        RETURNING
          id,
          tenant_key,
          vm_account_id,
          keycloak_group_id,
          status,
          created_at,
          updated_at,
          deleted_at
        `,
        [tenantKey],
      );

    return this.map(
      result.rows[0],
    );
  }

  async markActive(
    id: string,
    keycloakGroupId: string,
  ): Promise<TenantRecord> {
    const result =
      await this.db.query<TenantRow>(
        `
        UPDATE tenants
        SET
          keycloak_group_id = $2,
          status = 'active'
        WHERE id = $1
        RETURNING
          id,
          tenant_key,
          vm_account_id,
          keycloak_group_id,
          status,
          created_at,
          updated_at,
          deleted_at
        `,
        [
          id,
          keycloakGroupId,
        ],
      );

    return this.map(
      result.rows[0],
    );
  }

  async markError(
    id: string,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE tenants
      SET status = 'error'
      WHERE id = $1
      `,
      [id],
    );
  }

  async markDeleting(
    id: string,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE tenants
      SET status = 'deleting'
      WHERE id = $1
      `,
      [id],
    );
  }

  async markDeleted(
    id: string,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE tenants
      SET
        status = 'deleted',
        deleted_at = now()
      WHERE id = $1
      `,
      [id],
    );
  }

  private map(
    row: TenantRow,
  ): TenantRecord {
    return {
      id: row.id,

      tenantKey:
        row.tenant_key,

      vmAccountId:
        String(row.vm_account_id),

      keycloakGroupId:
        row.keycloak_group_id,

      status:
        row.status,

      createdAt:
        row.created_at,

      updatedAt:
        row.updated_at,

      deletedAt:
        row.deleted_at,
    };
  }
}
