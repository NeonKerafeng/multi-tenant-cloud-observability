import { Module } from '@nestjs/common';

import { GrafanaClient } from './grafana.client';

@Module({
  providers: [GrafanaClient],
  exports: [GrafanaClient],
})
export class GrafanaModule {}
