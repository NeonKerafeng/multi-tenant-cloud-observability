import { Module } from '@nestjs/common';

import { MirrorsModule } from '../../mirrors/mirrors.module';

import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [MirrorsModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
