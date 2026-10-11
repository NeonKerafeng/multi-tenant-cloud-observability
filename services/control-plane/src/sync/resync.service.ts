import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { DatabaseService } from '../common/db/database.service';
import { ConflictError } from '../common/errors/domain-error';
import { AppConfig } from '../config/app-config';
import { AgentRepository } from '../modules/agents/agent.repository';
import { TenantRepository } from '../modules/tenants/tenant.repository';
import { UserRepository } from '../modules/users/user.repository';

import { OutboxRepository } from './outbox.repository';

const STARTUP_DELAY_MS = 15 * 1000;

export interface ResyncResult {
  tenantsQueued: number;
  usersQueued: number;
  agentsQueued: number;
}

/**
 * Slow safety net (at startup + every GRAFANA_RESYNC_INTERVAL_MS, default
 * 1 h): enqueues every row that is live or still holds a mirror pointer
 * (pointer rule, CLAUDE.md §18.0) for ALL its mirrors. It repairs changes
 * made outside control-plane (manual edits, Grafana/Keycloak restored or
 * rebuilt) and finishes cleanups. The DB is the only source of truth:
 * nothing is imported from Keycloak or Grafana.
 *
 * Data isolation never depends on this: query-gateway enforces tenancy
 * from the token on every request.
 */
@Injectable()
export class ResyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ResyncService.name);

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly agents: AgentRepository,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.resyncIntervalMs;

    if (interval <= 0) {
      this.logger.log(
        'Periodic resync disabled (GRAFANA_RESYNC_INTERVAL_MS=0)',
      );
      return;
    }

    this.schedule(STARTUP_DELAY_MS, interval);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async run(): Promise<ResyncResult> {
    if (this.running) {
      throw new ConflictError('resync_running', 'A resync is already running');
    }

    this.running = true;

    try {
      const tenantIds = await this.tenants.findIdsForResync();
      const userIds = await this.users.findIdsForResync();
      const agentIds = await this.agents.findIdsForResync();

      for (const id of tenantIds) {
        await this.outbox.enqueue(this.db, 'tenant', id);
      }

      for (const id of userIds) {
        await this.outbox.enqueue(this.db, 'user', id);
      }

      for (const id of agentIds) {
        await this.outbox.enqueue(this.db, 'agent', id);
      }

      this.logger.log(
        `Resync queued ${tenantIds.length} tenant(s), ${userIds.length} user(s), ${agentIds.length} agent(s)`,
      );

      return {
        tenantsQueued: tenantIds.length,
        usersQueued: userIds.length,
        agentsQueued: agentIds.length,
      };
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number, intervalMs: number): void {
    this.timer = setTimeout(() => {
      this.run()
        .catch((error) => this.logger.warn(`Resync failed: ${String(error)}`))
        .finally(() => this.schedule(intervalMs, intervalMs));
    }, delayMs);

    this.timer.unref();
  }
}
