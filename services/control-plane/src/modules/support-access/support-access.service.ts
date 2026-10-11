import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import { DatabaseService } from '../../common/db/database.service';
import {
  ConflictError,
  InvalidError,
  NotFoundError,
} from '../../common/errors/domain-error';
import { isUuid } from '../../common/http/validation';
import { AppConfig } from '../../config/app-config';
import { DEFAULT_GRAFANA_ORG_ID } from '../../mirrors/grafana/grafana-tenant.mirror';
import { OutboxRepository } from '../../sync/outbox.repository';
import type { TenantRecord } from '../tenants/tenant.repository';

import type { GrantDto } from './dto';
import {
  type SupportAccessRecord,
  SupportAccessRepository,
} from './support-access.repository';

export const DEFAULT_GRANT_MINUTES = 60;

export interface GrantView {
  id: string;
  tenantKey: string;
  username: string;
  role: SupportAccessRecord['role'];
  reason: string;
  grantedBy: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  active: boolean;
}

export function toGrantView(
  grant: SupportAccessRecord,
  now = Date.now(),
): GrantView {
  return {
    id: grant.id,
    tenantKey: grant.tenantKey,
    username: grant.username,
    role: grant.role,
    reason: grant.reason,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    revokedBy: grant.revokedBy,
    active: grant.revokedAt === null && grant.expiresAt.getTime() > now,
  };
}

/**
 * Model C (D-04): platform admins live in the platform org (Grafana org 1).
 * To look inside a tenant's org they open a time-boxed, audited grant FOR
 * THEMSELVES; the outbox mirrors it into Grafana and its end (expiry or
 * revocation) removes the membership again.
 *   grant / revoke: platform-admin (guards)    list: + that tenant's admin
 */
@Injectable()
export class SupportAccessService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SupportAccessService.name);

  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly grants: SupportAccessRepository,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.supportAccess.sweepMs;

    if (interval <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      this.sweepExpired().catch((error) =>
        this.logger.warn(`Support access sweep failed: ${String(error)}`),
      );
    }, interval);

    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async grant(
    actor: Actor,
    tenant: TenantRecord,
    dto: GrantDto,
  ): Promise<GrantView> {
    if (tenant.grafanaOrgId === DEFAULT_GRAFANA_ORG_ID) {
      throw new ConflictError(
        'tenant_is_platform',
        'Platform admins are already members of the platform org',
      );
    }

    const minutes = dto.minutes ?? DEFAULT_GRANT_MINUTES;
    const max = this.config.supportAccess.maxMinutes;

    if (minutes > max) {
      throw new InvalidError(
        'validation_failed',
        `minutes must be at most ${max}`,
        [
          {
            field: 'minutes',
            messages: [`minutes must not be greater than ${max}`],
          },
        ],
      );
    }

    const role = dto.role ?? 'Viewer';

    const grantId = await this.db.transaction(async (tx) => {
      const id = await this.grants.create(tx, {
        userId: actor.userId,
        tenantId: tenant.id,
        role,
        reason: dto.reason,
        grantedBy: actor.username,
        minutes,
      });

      await this.outbox.enqueue(tx, 'user', actor.userId, ['grafana']);

      return id;
    });

    this.logger.log(
      `Support access ${grantId}: ${actor.username} -> ${tenant.tenantKey} as ${role} for ${minutes} min (${dto.reason})`,
    );

    return toGrantView(await this.requireGrant(grantId));
  }

  async listForTenant(
    _actor: Actor,
    tenant: TenantRecord,
    activeOnly: boolean,
  ): Promise<GrantView[]> {
    const now = Date.now();

    return (await this.grants.list(tenant.id, activeOnly)).map((g) =>
      toGrantView(g, now),
    );
  }

  async listAll(_actor: Actor, activeOnly: boolean): Promise<GrantView[]> {
    const now = Date.now();

    return (await this.grants.list(null, activeOnly)).map((g) =>
      toGrantView(g, now),
    );
  }

  async revoke(
    actor: Actor,
    tenant: TenantRecord,
    grantId: string,
  ): Promise<GrantView> {
    const existing = isUuid(grantId)
      ? await this.grants.findById(grantId)
      : null;

    if (!existing || existing.tenantId !== tenant.id) {
      throw new NotFoundError('grant_not_found', 'Support access not found');
    }

    const revoked = await this.db.transaction(async (tx) => {
      const userId = await this.grants.revoke(tx, grantId, actor.username);

      if (userId) {
        await this.outbox.enqueue(tx, 'user', userId, ['grafana']);
      }

      return userId !== null;
    });

    if (revoked) {
      this.logger.log(`Support access ${grantId} revoked by ${actor.username}`);
    }

    return toGrantView(await this.requireGrant(grantId));
  }

  /**
   * Enqueues the users of grants that just expired so the outbox removes
   * their membership. SKIP LOCKED: safe with several replicas. The Grafana
   * sync is level-triggered, so even a late sweep never leaves access in
   * place for long: any other sync of the user drops it too.
   */
  async sweepExpired(): Promise<number> {
    if (this.sweeping) {
      return 0;
    }

    this.sweeping = true;

    try {
      const expired = await this.db.transaction(async (tx) => {
        const claimed = await this.grants.claimExpired(tx);

        for (const userId of new Set(claimed.map((grant) => grant.userId))) {
          await this.outbox.enqueue(tx, 'user', userId, ['grafana']);
        }

        return claimed;
      });

      for (const grant of expired) {
        this.logger.log(`Support access ${grant.id} expired`);
      }

      return expired.length;
    } finally {
      this.sweeping = false;
    }
  }

  private async requireGrant(id: string): Promise<SupportAccessRecord> {
    const grant = await this.grants.findById(id);

    if (!grant) {
      throw new NotFoundError('grant_not_found', 'Support access not found');
    }

    return grant;
  }
}
