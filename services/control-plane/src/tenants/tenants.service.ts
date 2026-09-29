import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-user';

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

    private readonly keycloak:
      KeycloakAdminService,
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

      const activeTenant =
        await this.tenants.markActive(
          tenant.id,
          identity.groupId,
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
    const agents =
      await this.keycloak
        .listAgentIdentities();

    if (
      agents.some(
        (agent) =>
          agent.tenantId === tenantId,
      )
    ) {
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

      await this.tenants.markDeleted(
        tenant.id,
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
