import { Controller, Get, Header, Post } from '@nestjs/common';

import { Public, Roles } from '../common/auth/decorators';
import { MetricsService } from '../common/metrics/metrics.service';
import { SupportAccessRepository } from '../modules/support-access/support-access.repository';

import { ALL_TARGETS } from './mirror';
import { OutboxRepository, type OutboxStatus } from './outbox.repository';
import { ResyncService, type ResyncResult } from './resync.service';

/** Operations view of the mirrors (platform-admin only). */
@Controller('sync')
export class SyncController {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly resync: ResyncService,
  ) {}

  /** Healthy = pending close to 0 and failing 0 for every target. */
  @Get('status')
  @Roles('platform-admin')
  status(): Promise<OutboxStatus> {
    return this.outbox.status();
  }

  /** Runs the slow resync now (enqueue everything for every mirror). */
  @Post('resync')
  @Roles('platform-admin')
  runResync(): Promise<ResyncResult> {
    return this.resync.run();
  }
}

/**
 * Prometheus scrape endpoint. Unauthenticated: operational counters only,
 * no tenant data. Alert on mtco_outbox_failing_events > 0 or
 * mtco_outbox_oldest_pending_seconds growing.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly outbox: OutboxRepository,
    private readonly supportAccess: SupportAccessRepository,
  ) {}

  @Get()
  @Public()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(): Promise<string> {
    await this.refreshGauges();

    return this.metrics.registry.metrics();
  }

  /** The DB-backed gauges are read at scrape time. */
  private async refreshGauges(): Promise<void> {
    try {
      const status = await this.outbox.status();

      for (const target of ALL_TARGETS) {
        const value = status.targets[target];

        this.metrics.outboxPending.set({ target }, value.pending);
        this.metrics.outboxFailing.set({ target }, value.failing);
        this.metrics.outboxOldest.set({ target }, value.oldestPendingSeconds);
      }

      this.metrics.supportAccessActive.set(
        await this.supportAccess.countActive(),
      );
    } catch {
      // DB down: still serve process metrics; the gauges keep old values
      // and readiness reports the DB problem.
    }
  }
}
