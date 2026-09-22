import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TenantBackend {
  vmAccountId: number;
  vmProjectId?: number;
}

@Injectable()
export class TenantRegistryService {
  private readonly tenants: Record<string, TenantBackend>;

  constructor(config: ConfigService) {
    this.tenants = JSON.parse(
      config.get<string>('TENANT_BACKENDS_JSON', '{}'),
    ) as Record<string, TenantBackend>;
  }

  vmTenantId(tenantId: string): string {
    const tenant = this.tenants[tenantId];

    if (!tenant) {
      throw new ForbiddenException(`Unknown tenant: ${tenantId}`);
    }

    if (tenant.vmProjectId === undefined || tenant.vmProjectId === 0) {
      return String(tenant.vmAccountId);
    }

    return `${tenant.vmAccountId}:${tenant.vmProjectId}`;
  }
}
