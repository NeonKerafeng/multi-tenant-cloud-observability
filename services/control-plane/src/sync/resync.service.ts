import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { DatabaseService } from '../database/database.service';
import { TenantRepository } from '../tenants/tenant.repository';
import { UserRepository } from '../users/user.repository';

import { OutboxRepository } from './outbox.repository';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

export interface ResyncResult {
  tenantsQueued: number;
  usersQueued: number;
}

/**
 * Slow safety net (default: at startup + every hour). It does not do the
 * sync itself; it only enqueues every tenant and user so the outbox worker
 * re-converges Grafana. It exists for changes made OUTSIDE control-plane
 * (manual edits, Grafana restored from backup / rebuilt on a new DB).
 *
 * The control-plane DB is the only source of truth: identities that exist
 * only in Keycloak are NOT imported (a user created directly in Keycloak
 * never gets Grafana access). The initial platform admin is created by
 * PlatformBootstrapService.
 *
 * Data isolation never depends on this: query-gateway enforces tenancy
 * from the token on every request.
 */
@Injectable()
export class ResyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger =
    new Logger(ResyncService.name);

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.intervalMs();

    if (interval <= 0) {
      this.logger.log('Periodic resync disabled (GRAFANA_RESYNC_INTERVAL_MS=0)');
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
      throw new Error('Resync already running');
    }

    this.running = true;

    try {
      let tenantsQueued = 0;

      for (const tenant of await this.tenants.findAll()) {
        if (
          tenant.status === 'active' ||
          tenant.status === 'deleting'
        ) {
          await this.outbox.enqueue(this.db, 'tenant', tenant.id);
          tenantsQueued++;
        }
      }

      const userIds = await this.users.findIdsForSync();

      for (const userId of userIds) {
        await this.outbox.enqueue(this.db, 'user', userId);
      }

      this.logger.log(
        `Resync queued ${tenantsQueued} tenant(s), ${userIds.length} user(s)`,
      );

      return {
        tenantsQueued,
        usersQueued: userIds.length,
      };
    } finally {
      this.running = false;
    }
  }

  private schedule(
    delayMs: number,
    intervalMs: number,
  ): void {
    this.timer = setTimeout(() => {
      void this.run()
        .catch((error) =>
          this.logger.warn(`Resync failed: ${String(error)}`),
        )
        .finally(() => this.schedule(intervalMs, intervalMs));
    }, delayMs);

    this.timer.unref();
  }

  private intervalMs(): number {
    const raw = this.config.get<string>('GRAFANA_RESYNC_INTERVAL_MS');

    if (raw === undefined || raw === '') {
      return DEFAULT_INTERVAL_MS;
    }

    const value = Number(raw);

    return Number.isFinite(value) ? value : DEFAULT_INTERVAL_MS;
  }
}
