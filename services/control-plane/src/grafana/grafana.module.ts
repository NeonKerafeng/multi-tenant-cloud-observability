import { Module } from '@nestjs/common';

import { GrafanaAdminService } from './grafana-admin.service';

@Module({
  providers: [
    GrafanaAdminService,
  ],

  exports: [
    GrafanaAdminService,
  ],
})
export class GrafanaModule {}
