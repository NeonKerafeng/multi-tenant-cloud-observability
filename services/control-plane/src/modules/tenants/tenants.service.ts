import { Injectable } from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  DatabaseService,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from '../../common/db/database.service';
import { ConflictError } from '../../common/errors/domain-error';
import { AppConfig } from '../../config/app-config';
import { KeycloakTenantMirror } from '../../mirrors/keycloak/keycloak-tenant.mirror';
import { OutboxRepository } from '../../sync/outbox.repository';
import { AgentRepository } from '../agents/agent.repository';
import { EnrollmentRepository } from '../enrollments/enrollment.repository';
import { SupportAccessRepository } from '../support-access/support-access.repository';
import { UserRepository } from '../users/user.repository';

import { type TenantRecord, TenantRepository } from './tenant.repository';
import { type TenantView, toTenantView } from './views';

/**
 * Tenant lifecycle. Authorization (platform-admin, tenant scope) is done
 * by the guards before these methods are called.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly agents: AgentRepository,
    private readonly grants: SupportAccessRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly outbox: OutboxRepository,
    private readonly keycloakTenants: KeycloakTenantMirror,
    private readonly config: AppConfig,
  ) {}

  async list(_actor: Actor): Promise<TenantView[]> {
    return (await this.tenants.listActive()).map(toTenantView);
  }

  get(_actor: Actor, tenant: TenantRecord): TenantView {
    return toTenantView(tenant);
  }

  /**
   * One transaction: row + Keycloak group (inline, so users can be created
   * right away) + outbox (Grafana org). Keycloak down → nothing created.
   */
  async create(_actor: Actor, tenantKey: string): Promise<TenantView> {
    return this.db.transaction(async (tx) => {
      let tenant: TenantRecord;

      try {
        tenant = await this.tenants.insertActive(tx, tenantKey);
      } catch (error) {
        if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
          throw new ConflictError(
            'tenant_key_reserved',
            'This tenant key is already used or was used before',
          );
        }

        throw error;
      }

      await this.keycloakTenants.apply(tenant, tx);
      await this.outbox.enqueue(tx, 'tenant', tenant.id);

      return toTenantView(
        (await this.tenants.findById(tenant.id, tx)) ?? tenant,
      );
    });
  }

  /**
   * One transaction: tenant deleted + its users deleted + its agents
   * revoked (decision Q1) + open support grants and unused enrollments
   * ended; the mirrors then
   * delete the Keycloak group/users/clients and the Grafana org.
   * Metrics and logs stay in storage (TODO-08).
   */
  async delete(actor: Actor, tenant: TenantRecord): Promise<void> {
    if (tenant.tenantKey === this.config.grafana.defaultTenant) {
      throw new ConflictError(
        'tenant_is_platform',
        'The platform tenant cannot be deleted',
      );
    }

    await this.db.transaction(async (tx) => {
      await this.tenants.markDeleted(tx, tenant.id);

      const userIds = await this.users.markTenantUsersDeleted(tx, tenant.id);
      const agentIds = await this.agents.revokeTenantAgents(tx, tenant.id);
      const grantUserIds = await this.grants.revokeOpenForTenant(
        tx,
        tenant.id,
        actor.username,
      );

      // Unused tokens of a deleted tenant must not create agents.
      await this.enrollments.revokeOpenForTenant(tx, tenant.id, actor.userId);

      await this.outbox.enqueue(tx, 'tenant', tenant.id);

      for (const id of new Set([...userIds, ...grantUserIds])) {
        await this.outbox.enqueue(tx, 'user', id);
      }

      for (const id of agentIds) {
        await this.outbox.enqueue(tx, 'agent', id);
      }
    });
  }
}
