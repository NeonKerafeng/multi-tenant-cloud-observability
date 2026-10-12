import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { DatabaseService } from '../../common/db/database.service';
import { AppConfig } from '../../config/app-config';
import { UserRepository } from '../users/user.repository';
import { UsersService } from '../users/users.service';

const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;

/** pg advisory lock: one replica at a time creates the initial admin. */
export const PLATFORM_BOOTSTRAP_LOCK = 727002;

export type BootstrapOutcome =
  'skipped' | 'exists' | 'created' | 'refused' | 'busy';

/**
 * Makes a fresh install usable with NO manual step: if the DB has no
 * active platform admin, creates the initial one from PLATFORM_ADMIN_*
 * (secret platform-admin) through the normal user-create path (DB row +
 * Keycloak account inline + outbox). Retries until Keycloak answers.
 * Tenant groups (incl. admin-tenant's) are created by the Keycloak tenant
 * mirror through the startup resync.
 *
 * Safety: a deleted initial admin is never resurrected; a username that
 * belongs to a tenant user is never promoted. With several replicas only
 * the one holding the advisory lock acts; the others retry and then see
 * the admin.
 */
@Injectable()
export class PlatformBootstrapService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformBootstrapService.name);

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly users: UserRepository,
    private readonly usersService: UsersService,
    private readonly config: AppConfig,
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

  /** Returns what it did (for logs and tests). */
  async run(): Promise<BootstrapOutcome> {
    const username = this.config.platformAdmin.username.trim().toLowerCase();

    if (!username) {
      this.logger.log(
        'No initial platform admin configured (PLATFORM_ADMIN_USERNAME empty)',
      );
      return 'skipped';
    }

    const locked = await this.db.withAdvisoryLock(PLATFORM_BOOTSTRAP_LOCK, () =>
      this.createIfMissing(username),
    );

    return locked.acquired ? locked.result : 'busy';
  }

  private async createIfMissing(username: string): Promise<BootstrapOutcome> {
    const admin = this.config.platformAdmin;

    if ((await this.users.countActivePlatformAdmins()) > 0) {
      return 'exists';
    }

    if (!admin.email || admin.password.length < MIN_PASSWORD_LENGTH) {
      this.logger.error(
        `Initial platform admin not created: PLATFORM_ADMIN_EMAIL is required and PLATFORM_ADMIN_PASSWORD must have at least ${MIN_PASSWORD_LENGTH} characters`,
      );
      return 'refused';
    }

    const known = await this.users.findLatestByUsername(username);

    if (known && known.role !== 'platform-admin') {
      this.logger.error(
        `Initial platform admin not created: username ${username} belongs to a ${known.role}`,
      );
      return 'refused';
    }

    if (known && known.status === 'deleted') {
      this.logger.warn(
        `Initial platform admin ${username} was deleted; not re-creating it`,
      );
      return 'refused';
    }

    await this.usersService.createPlatformAdmin({
      username,
      email: admin.email,
      password: admin.password,
      firstName: admin.firstName,
      lastName: admin.lastName,
    });

    this.logger.log(`Initial platform admin ${username} created`);

    return 'created';
  }

  private schedule(delayMs: number, attempt: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.run()
        .then((outcome) => {
          if (outcome === 'busy') {
            this.logger.log(
              'Another replica is running the platform bootstrap; checking again shortly',
            );
            this.schedule(FIRST_RETRY_MS, attempt + 1);
            return;
          }

          this.logger.log('Platform bootstrap complete');
        })
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
