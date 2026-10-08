import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { DatabaseService } from '../database/database.service';
import { TenantRepository } from '../tenants/tenant.repository';
import { KeycloakUsersService } from '../users/keycloak-users.service';
import { UserRepository } from '../users/user.repository';

import { OutboxRepository } from './outbox.repository';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

export interface ResyncResult {
  adoptedUsers: number;
  skippedUsers: string[];
  tenantsQueued: number;
  usersQueued: number;
}

/**
 * Slow safety net (default: at startup + every hour). It does not do the
 * sync itself; it only enqueues every aggregate so the outbox worker
 * re-converges Grafana. It exists for changes made OUTSIDE control-plane
 * (manual edits, Grafana restored from backup / lost PVC, fresh Grafana)
 * and to adopt Keycloak users that predate the users table.
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
    private readonly keycloakUsers: KeycloakUsersService,
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
      const adoption = await this.adoptKeycloakUsers();

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

      const result: ResyncResult = {
        ...adoption,
        tenantsQueued,
        usersQueued: userIds.length,
      };

      this.logger.log(
        `Resync queued ${tenantsQueued} tenant(s), ${userIds.length} user(s); adopted ${adoption.adoptedUsers}`,
      );

      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Imports Keycloak identities control-plane does not know yet:
   * - members of each active tenant group (tenant-admin / viewer)
   * - users with realm role platform-admin
   * Never changes tenant, role or status of known users.
   */
  private async adoptKeycloakUsers(): Promise<{
    adoptedUsers: number;
    skippedUsers: string[];
  }> {
    let adoptedUsers = 0;
    const skippedUsers: string[] = [];

    for (const tenant of await this.tenants.findAll()) {
      if (
        tenant.status !== 'active' ||
        !tenant.keycloakGroupId
      ) {
        continue;
      }

      const members =
        await this.keycloakUsers.listUsersInGroup(
          tenant.keycloakGroupId,
        );

      for (const member of members) {
        if (
          member.role !== 'tenant-admin' &&
          member.role !== 'viewer'
        ) {
          continue; // platform admins are adopted below
        }

        if (!member.email) {
          skippedUsers.push(member.username);
          continue;
        }

        await this.users.adopt(
          {
            keycloakUserId: member.id,
            username: member.username,
            email: member.email,
            enabled: member.enabled,
          },
          tenant.id,
          member.role,
        );

        adoptedUsers++;
      }
    }

    for (const admin of await this.keycloakUsers.listUsersWithRealmRole(
      'platform-admin',
    )) {
      if (!admin.email) {
        skippedUsers.push(admin.username);
        continue;
      }

      await this.users.adopt(
        {
          keycloakUserId: admin.id,
          username: admin.username,
          email: admin.email,
          enabled: admin.enabled,
        },
        null,
        'platform-admin',
      );

      adoptedUsers++;
    }

    if (skippedUsers.length > 0) {
      this.logger.warn(
        `Users without email cannot be mirrored to Grafana: ${skippedUsers.join(', ')}`,
      );
    }

    return { adoptedUsers, skippedUsers };
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
