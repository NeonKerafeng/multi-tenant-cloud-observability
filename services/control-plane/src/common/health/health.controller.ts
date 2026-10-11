import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { Public } from '../auth/decorators';
import { DatabaseService } from '../db/database.service';

/**
 * Probes. Readiness checks only what this process needs to serve requests
 * (its DB); Keycloak/Grafana outages surface as 503 on the affected calls
 * and as outbox backlog, not as a restart loop.
 */
@Controller()
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get('healthz')
  @Public()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await this.db.ping();
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }

    return { status: 'ok' };
  }
}
