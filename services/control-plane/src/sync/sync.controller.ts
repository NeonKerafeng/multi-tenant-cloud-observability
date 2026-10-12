import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiExcludeController,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Public, Roles } from '../common/auth/decorators';
import { MetricsService } from '../common/metrics/metrics.service';
import { SupportAccessRepository } from '../modules/support-access/support-access.repository';

import { ALL_TARGETS } from './mirror';
import { OutboxRepository } from './outbox.repository';
import { ResyncService } from './resync.service';
import { OutboxStatus, ResyncResult } from './views';

/** Operations view of the mirrors (platform-admin only). */
@ApiTags('admin')
@Controller('admin/sync')
@Roles('platform-admin')
export class SyncController {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly resync: ResyncService,
  ) {}

  /** Healthy = pending close to 0 and failing 0 for every target. */
  @Get('status')
  @ApiOkResponse({ type: OutboxStatus })
  status(): Promise<OutboxStatus> {
    return this.outbox.status();
  }

  /**
   * Queues every live row (and every row still holding a mirror pointer)
   * for all its mirrors now; the outbox worker does the work.
   */
  @Post('resync')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: ResyncResult })
  runResync(): Promise<ResyncResult> {
    return this.resync.run();
  }
}

/**
 * Prometheus scrape endpoint (outside /api/v1). Unauthenticated:
 * operational counters only, no tenant data. Alert on
 * mtco_outbox_failing_events > 0 or mtco_outbox_oldest_pending_seconds
 * growing.
 */
@ApiExcludeController()
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
