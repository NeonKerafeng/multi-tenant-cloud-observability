import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { DatabaseService } from '../database/database.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { TenantRepository } from '../tenants/tenant.repository';
import { KeycloakUsersService } from '../users/keycloak-users.service';
import { UserRepository } from '../users/user.repository';

import { OutboxRepository } from './outbox.repository';

const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 60 * 1000;

/**
 * Makes a fresh install usable with NO manual step (TODO-18). Runs at
 * startup, is idempotent, and retries until Keycloak answers:
 *
 * 1. Every active tenant without a Keycloak group (the seeded admin-tenant)
 *    gets its group; the tenant is then mirrored into Grafana.
 * 2. If no platform admin exists in the DB, the initial one is created from
 *    PLATFORM_ADMIN_USERNAME / _EMAIL / _PASSWORD (secret platform-admin):
 *    Keycloak account + users row + Grafana via the outbox. The password is
 *    used only when the Keycloak account is created; change it afterwards.
 *
 * Safety:
 * - an initial admin that was deleted in the DB is never resurrected;
 * - a username that belongs to a tenant user is never promoted.
 */
@Injectable()
export class PlatformBootstrapService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger =
    new Logger(PlatformBootstrapService.name);

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly keycloak: KeycloakAdminService,
    private readonly keycloakUsers: KeycloakUsersService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(0, 1);
  }

  onModuleDestroy(): void {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async run(): Promise<void> {
    await this.ensureTenantGroups();
    await this.ensureInitialPlatformAdmin();
  }

  private async ensureTenantGroups(): Promise<void> {
    for (const tenant of await this.tenants.findAll()) {
      if (
        tenant.status !== 'active' ||
        tenant.keycloakGroupId
      ) {
        continue;
      }

      const groupId =
        await this.keycloak.ensureTenantGroup(
          tenant.tenantKey,
          tenant.vmAccountId,
        );

      await this.db.transaction(async (tx) => {
        await this.tenants.markActive(tenant.id, groupId, tx);
        await this.outbox.enqueue(tx, 'tenant', tenant.id);
      });

      this.logger.log(
        `Tenant ${tenant.tenantKey}: Keycloak group ensured`,
      );
    }
  }

  private async ensureInitialPlatformAdmin(): Promise<void> {
    const username =
      this.config.get<string>('PLATFORM_ADMIN_USERNAME', '').trim();

    if (!username) {
      this.logger.log(
        'No initial platform admin configured (PLATFORM_ADMIN_USERNAME empty)',
      );
      return;
    }

    if ((await this.users.findPlatformAdminIds()).length > 0) {
      return; // the platform already has an admin: nothing to bootstrap
    }

    const email =
      this.config.get<string>('PLATFORM_ADMIN_EMAIL', '').trim();

    const password =
      this.config.get<string>('PLATFORM_ADMIN_PASSWORD', '');

    if (!email || password.length < 12) {
      this.logger.error(
        'Initial platform admin not created: PLATFORM_ADMIN_EMAIL is required and PLATFORM_ADMIN_PASSWORD must have at least 12 characters',
      );
      return;
    }

    const known =
      await this.users.findByUsername(username);

    if (known && known.role !== 'platform-admin') {
      this.logger.error(
        `Initial platform admin not created: username ${username} belongs to a ${known.role}`,
      );
      return;
    }

    if (known && known.status === 'deleted') {
      this.logger.warn(
        `Initial platform admin ${username} was deleted; not re-creating it`,
      );
      return;
    }

    const account =
      await this.keycloakUsers.ensurePlatformAdmin({
        username,
        email,
        password,
        firstName:
          this.config.get<string>('PLATFORM_ADMIN_FIRST_NAME', 'Platform'),
        lastName:
          this.config.get<string>('PLATFORM_ADMIN_LAST_NAME', 'Admin'),
      });

    const userId =
      await this.users.adopt(
        {
          keycloakUserId: account.id,
          username: account.username,
          email: account.email ?? email,
          enabled: account.enabled,
        },
        null,
        'platform-admin',
      );

    await this.outbox.enqueue(this.db, 'user', userId);

    this.logger.log(
      `Initial platform admin ${account.username} ready (${account.created ? 'created' : 'already in Keycloak'})`,
    );
  }

  private schedule(
    delayMs: number,
    attempt: number,
  ): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.run()
        .then(() => this.logger.log('Platform bootstrap complete'))
        .catch((error) => {
          const next = Math.min(
            FIRST_RETRY_MS * 2 ** (attempt - 1),
            MAX_RETRY_MS,
          );

          this.logger.warn(
            `Platform bootstrap failed (attempt ${attempt}), retrying in ${next / 1000}s: ${String(error)}`,
          );

          this.schedule(next, attempt + 1);
        });
    }, delayMs);

    this.timer.unref();
  }
}
