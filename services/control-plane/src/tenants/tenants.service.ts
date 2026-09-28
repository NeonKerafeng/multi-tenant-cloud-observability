import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-user';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';

@Injectable()
export class TenantsService {
  constructor(
    private readonly keycloak: KeycloakAdminService,
  ) {}

  async list(user: AuthUser) {
    this.requirePlatformAdmin(user);

    return this.keycloak.listTenants();
  }

  async get(
    user: AuthUser,
    tenantId: string,
  ) {
    this.requirePlatformAdmin(user);

    const tenant =
      await this.keycloak.getTenant(tenantId);

    if (!tenant) {
      throw new NotFoundException(
        'Tenant not found',
      );
    }

    return tenant;
  }

  async create(
    user: AuthUser,
    tenantId: string,
    vmAccountId: string,
  ) {
    this.requirePlatformAdmin(user);

    this.validateTenantId(tenantId);

    if (
      !vmAccountId ||
      !/^[1-9]\d*$/.test(vmAccountId)
    ) {
      throw new BadRequestException(
        'vmAccountId must be a positive integer',
      );
    }

    const tenants =
      await this.keycloak.listTenants();

    if (
      tenants.some(
        (tenant) =>
          tenant.tenantId === tenantId,
      )
    ) {
      throw new ConflictException(
        'Tenant already exists',
      );
    }

    if (
      tenants.some(
        (tenant) =>
          tenant.vmAccountId === vmAccountId,
      )
    ) {
      throw new ConflictException(
        'VictoriaMetrics account ID is already in use',
      );
    }

    return this.keycloak.createTenant(
      tenantId,
      vmAccountId,
    );
  }

  async delete(
    user: AuthUser,
    tenantId: string,
  ) {
    this.requirePlatformAdmin(user);

    const tenant =
      await this.keycloak.getTenant(tenantId);

    if (!tenant) {
      throw new NotFoundException(
        'Tenant not found',
      );
    }

    const agents =
      await this.keycloak.listAgentIdentities();

    if (
      agents.some(
        (agent) =>
          agent.tenantId === tenantId,
      )
    ) {
      throw new ConflictException(
        'Tenant still has agents; delete its agents first',
      );
    }

    const deleted =
      await this.keycloak.deleteTenant(tenantId);

    if (!deleted) {
      throw new NotFoundException(
        'Tenant not found',
      );
    }

    return {
      tenantId,
      deleted: true,
    };
  }

  private requirePlatformAdmin(
    user: AuthUser,
  ): void {
    if (
      !user.roles.includes('platform-admin')
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
}
