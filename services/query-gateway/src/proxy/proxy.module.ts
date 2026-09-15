import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { HttpProxyService } from './http-proxy.service';
import { VictoriaMetricsController } from './victoriametrics.controller';
import { OpenSearchController } from './opensearch.controller';

@Module({
  imports: [HttpModule],
  controllers: [
    VictoriaMetricsController,
    OpenSearchController,
  ],
  providers: [HttpProxyService],
})
export class ProxyModule {}