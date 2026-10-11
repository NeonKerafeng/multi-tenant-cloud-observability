import { Module } from '@nestjs/common';

import { MirrorsModule } from '../mirrors/mirrors.module';

import { OutboxWorker } from './outbox.worker';
import { ResyncService } from './resync.service';
import { MetricsController, SyncController } from './sync.controller';

/**
 * Outbox → mirrors: the worker, the hourly resync and the operations
 * endpoints. (OutboxRepository comes from the global PersistenceModule.)
 */
@Module({
  imports: [MirrorsModule],
  controllers: [MetricsController, SyncController],
  providers: [OutboxWorker, ResyncService],
})
export class SyncModule {}
