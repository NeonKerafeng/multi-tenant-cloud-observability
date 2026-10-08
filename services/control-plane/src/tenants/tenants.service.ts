import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-user';

import { AgentRepository } from '../agents/agent.repository';

import { DatabaseService } from '../database/database.service';
import { OutboxRepository } from '../sync/outbox.repository';
import { UserRepository } from '../users/user.repository';

import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';

import {
  type TenantRecord,
  TenantRepository,
} from './tenant.repository';


@Injectable()
export class TenantsService {
  constructor(
    private readonly tenants:
      TenantRepository,

    private readonly agents:
      AgentRepository,

    private readonly keycloak:
      KeycloakAdminService,

    private readonly db:
      DatabaseService,

    private readonly outbox:
      OutboxRepository,

    private readonly users:
      UserRepository,
  ) {}

  async list(
    user: AuthUser,
  ) {
    this.requirePlatformAdmin(user);

    const tenants =
      await this.tenants.findAll();

    return tenants.map(
      (tenant) =>
        this.toResponse(tenant),
    );
  }

  async get(
    user: AuthUser,
    tenantId: string,
  ) {
    this.requirePlatformAdmin(user);

    const tenant =
      await this.tenants.findByKey(
        tenantId,
      );

    if (
      !tenant ||
      tenant.status === 'deleted'
    ) {
      throw new NotFoundException(
        'Tenant not found',
      );
    }

    return this.toResponse(
      tenant,
    );
  }

  async create(
    user: AuthUser,
    tenantId: string,
  ) {
    this.requirePlatformAdmin(user);

    this.validateTenantId(
      tenantId,
    );

    let tenant: TenantRecord;

    try {
      tenant =
        await this.tenants
          .createProvisioning(
            tenantId,
          );
    } catch (error) {
      if (
        this.isUniqueViolation(
          error,
        )
      ) {
        throw new ConflictException(
          'Tenant ID is already reserved',
        );
      }

      throw error;
    }

    try {
      const identity =
        await this.keycloak.createTenant(
          tenant.tenantKey,
          tenant.vmAccountId,
        );

      /*
       * Active + "mirror me into Grafana" in ONE transaction: the
       * outbox worker creates the org asynchronously and retries until
       * it succeeds. GET /sync/status shows progress.
       */
      const activeTenant =
        await this.db.transaction(
          async (tx) => {
            const active =
              await this.tenants.markActive(
                tenant.id,
                identity.groupId,
                tx,
              );

            await this.outbox.enqueue(
              tx,
              'tenant',
              tenant.id,
            );

            return active;
          },
        );

      return this.toResponse(
        activeTenant,
      );
    } catch (error) {
      await this.tenants.markError(
        tenant.id,
      );

      throw error;
    }
  }

  async delete(
    user: AuthUser,
    tenantId: string,
  ) {
    this.requirePlatformAdmin(user);

    const tenant =
      await this.tenants.findByKey(
        tenantId,
      );

    if (!tenant) {
      throw new NotFoundException(
        'Tenant not found',
      );
    }

    if (
      tenant.status === 'deleted'
    ) {
      return {
        tenantId,
        deleted: true,
      };
    }

    /*
     * TEMPORARY SAFETY NET.
     *
     * Agent Registry is moving to PostgreSQL,
     * but existing agents have not been
     * backfilled yet.
     *
     * After Agent Registry migration,
     * replace this with AgentRepository.
     */
    const hasAgents =
      await this.agents
        .hasLiveAgentsForTenant(
          tenantId,
        );

    if (hasAgents) {
      throw new ConflictException(
        'Tenant still has agents; revoke them first',
      );
    }

    await this.tenants.markDeleting(
      tenant.id,
    );

    try {
      await this.keycloak.deleteTenant(
        tenantId,
      );

      /*
       * Deleted + its users deleted + "remove from Grafana" events,
       * in ONE transaction. The worker deletes the Grafana org and the
       * users' Grafana accounts asynchronously.
       */
      await this.db.transaction(
        async (tx) => {
          await this.tenants.markDeletedTx(
            tx,
            tenant.id,
          );

          const userIds =
            await this.users.markTenantUsersDeleted(
              tx,
              tenant.id,
            );

          await this.outbox.enqueue(
            tx,
            'tenant',
            tenant.id,
          );

          for (const userId of userIds) {
            await this.outbox.enqueue(
              tx,
              'user',
              userId,
            );
          }
        },
      );
    } catch (error) {
      await this.tenants.markError(
        tenant.id,
      );

      throw error;
    }

    return {
      tenantId,
      deleted: true,
    };
  }

  private toResponse(
    tenant: TenantRecord,
  ) {
    return {
      tenantId:
        tenant.tenantKey,

      vmAccountId:
        tenant.vmAccountId,

      grafanaOrgId:
        tenant.grafanaOrgId,

      status:
        tenant.status,
    };
  }

  private requirePlatformAdmin(
    user: AuthUser,
  ): void {
    if (
      !user.roles.includes(
        'platform-admin',
      )
    ) {
      throw new ForbiddenException(
        'platform-admin role required',
      );
    }
  }

  private validateTenantId(
    tenantId: string,
  ): void {
    if (
      !tenantId ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        tenantId,
      )
    ) {
      throw new BadRequestException(
        'tenantId must contain only lowercase letters, digits and hyphens',
      );
    }
  }

  private isUniqueViolation(
    error: unknown,
  ): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (
        error as {
          code?: string;
        }
      ).code === '23505'
    );
  }
}
