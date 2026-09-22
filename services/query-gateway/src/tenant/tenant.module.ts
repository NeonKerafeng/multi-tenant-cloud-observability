import { Module } from '@nestjs/common';

import { TenantService } from './tenant.service';
import { TenantRegistryService } from './tenant-registry.service';

@Module({
  providers: [TenantService, TenantRegistryService],

  exports: [TenantService, TenantRegistryService],
})
export class TenantModule {}
