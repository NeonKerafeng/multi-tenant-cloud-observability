import { ApiProperty } from '@nestjs/swagger';

import { listOf } from '../../common/http/list';

import type { TenantRecord, TenantStatus } from './tenant.repository';

export class TenantView {
  @ApiProperty({
    example: 'alpha-tenant',
    description: 'Tenant key (its id in URLs)',
  })
  tenantKey!: string;

  @ApiProperty({
    example: '2',
    description: 'VictoriaMetrics account id (vm_account_id claim)',
  })
  vmAccountId!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Grafana org id; null until the org is provisioned',
  })
  grafanaOrgId!: number | null;

  @ApiProperty({ enum: ['active', 'deleted'] })
  status!: TenantStatus;

  @ApiProperty()
  createdAt!: Date;
}

export const TenantList = listOf(TenantView);

export function toTenantView(tenant: TenantRecord): TenantView {
  return {
    tenantKey: tenant.tenantKey,
    vmAccountId: tenant.vmAccountId,
    grafanaOrgId: tenant.grafanaOrgId,
    status: tenant.status,
    createdAt: tenant.createdAt,
  };
}
