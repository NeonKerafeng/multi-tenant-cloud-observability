import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from '@nestjs/common';

import { SupportAccessRepository } from '../support-access/support-access.repository';

import { OutboxRepository } from './outbox.repository';

/**
 * Prometheus metrics of the mirrors (TODO-02). Unauthenticated: operational
 * counters only, no tenant data. Alert on mtco_outbox_failing_events > 0 or
 * mtco_outbox_oldest_pending_seconds growing.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly supportAccess: SupportAccessRepository,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async metrics(): Promise<string> {
    try {
      const status = await this.outbox.status();
      const grants = await this.supportAccess.countActive();

      return renderMetrics([
        ['mtco_outbox_pending_events', 'Outbox events not processed yet.', status.pending],
        ['mtco_outbox_failing_events', 'Pending outbox events that failed at least 3 times.', status.failing],
        ['mtco_outbox_oldest_pending_seconds', 'Age of the oldest pending outbox event (0 when none).', status.oldestPendingSeconds ?? 0],
        ['mtco_support_access_active_grants', 'Platform-admin support-access grants in effect.', grants],
      ]);
    } catch (error) {
      throw new ServiceUnavailableException(
        `metrics unavailable: ${String(error)}`,
      );
    }
  }
}

export function renderMetrics(
  gauges: [name: string, help: string, value: number][],
): string {
  return gauges
    .map(
      ([name, help, value]) =>
        `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Number.isFinite(value) ? value : 0}\n`,
    )
    .join('');
}
