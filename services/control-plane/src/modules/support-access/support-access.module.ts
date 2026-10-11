import { Module } from '@nestjs/common';

import { SupportAccessController } from './support-access.controller';
import { SupportAccessService } from './support-access.service';

/** Model C support access (repository: global PersistenceModule). */
@Module({
  controllers: [SupportAccessController],
  providers: [SupportAccessService],
})
export class SupportAccessModule {}
