import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import type { AuthUser } from '../auth/auth-user';
import { DatabaseService } from '../database/database.service';
import { OutboxRepository } from '../sync/outbox.repository';
import { DEFAULT_GRAFANA_ORG_ID } from '../tenants/tenant-grafana.service';
import {
  type TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';

import {
  type SupportAccessRecord,
  type SupportAccessRole,
  SupportAccessRepository,
} from './support-access.repository';

export interface GrantSupportAccessInput {
  reason?: unknown;
  minutes?: unknown;
  role?: unknown;
}

const DEFAULT_MINUTES = 60;
const MIN_MINUTES = 5;
const DEFAULT_MAX_MINUTES = 8 * 60;
const DEFAULT_SWEEP_MS = 30 * 1000;

/**
 * Model C: platform admins live in the platform org (Grafana org 1).
 * To look inside a tenant's org they open a time-boxed, audited grant;
 * the outbox mirrors it into Grafana and its end (expiry or revocation)
 * removes the membership again.
 *
 * - grant:  platform-admin, for themself, with a reason
 * - list:   platform-admin (any tenant) or that tenant's tenant-admin
 * - revoke: platform-admin or that tenant's tenant-admin
 */
@Injectable()
export class SupportAccessService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger =
    new Logger(SupportAccessService.name);

  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly tenants: TenantRepository,
    private readonly grants: SupportAccessRepository,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const interval =
      this.numberFromEnv(
        'SUPPORT_ACCESS_SWEEP_MS',
        DEFAULT_SWEEP_MS,
      );

    if (interval <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      void this.sweepExpired().catch((error) =>
        this.logger.warn(
          `Support access sweep failed: ${String(error)}`,
        ),
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
    actor: AuthUser,
    tenantKey: string,
    input: GrantSupportAccessInput,
  ) {
    this.requirePlatformAdmin(actor);

    const tenant =
      await this.requireActiveTenant(tenantKey);

    if (tenant.grafanaOrgId === DEFAULT_GRAFANA_ORG_ID) {
      throw new BadRequestException(
        'Platform admins are already members of the platform org',
      );
    }

    const reason = this.validateReason(input.reason);
    const minutes = this.validateMinutes(input.minutes);
    const role = this.validateRole(input.role);

    const userId =
      await this.grants.findPlatformAdminUserId(actor.sub);

    if (!userId) {
      // Platform admins are adopted from Keycloak by the resync.
      throw new ConflictException(
        'Your account is not registered in control-plane yet; run POST /sync/resync and retry',
      );
    }

    const grantId =
      await this.db.transaction(async (tx) => {
        const id =
          await this.grants.create(tx, {
            userId,
            tenantId: tenant.id,
            role,
            reason,
            grantedBy: actor.username,
            minutes,
          });

        await this.outbox.enqueue(tx, 'user', userId);

        return id;
      });

    this.logger.log(
      `Support access ${grantId}: ${actor.username} -> ${tenant.tenantKey} as ${role} for ${minutes} min (${reason})`,
    );

    return this.toResponse(
      await this.requireGrant(grantId),
    );
  }

  async listForTenant(
    actor: AuthUser,
    tenantKey: string,
    activeOnly: boolean,
  ) {
    const tenant =
      await this.requireTenant(tenantKey);

    this.requireTenantOversight(actor, tenant.tenantKey);

    const grants =
      await this.grants.list(tenant.id, activeOnly);

    return grants.map((grant) => this.toResponse(grant));
  }

  async listAll(
    actor: AuthUser,
    activeOnly: boolean,
  ) {
    this.requirePlatformAdmin(actor);

    const grants =
      await this.grants.list(null, activeOnly);

    return grants.map((grant) => this.toResponse(grant));
  }

  async revoke(
    actor: AuthUser,
    tenantKey: string,
    grantId: string,
  ) {
    const tenant =
      await this.requireTenant(tenantKey);

    this.requireTenantOversight(actor, tenant.tenantKey);

    if (!this.isUuid(grantId)) {
      throw new NotFoundException('Support access not found');
    }

    const existing =
      await this.grants.findById(grantId);

    if (!existing || existing.tenantId !== tenant.id) {
      throw new NotFoundException('Support access not found');
    }

    const revoked =
      await this.db.transaction(async (tx) => {
        const userId =
          await this.grants.revoke(tx, grantId, actor.username);

        if (userId) {
          await this.outbox.enqueue(tx, 'user', userId);
        }

        return userId !== null;
      });

    if (revoked) {
      this.logger.log(
        `Support access ${grantId} revoked by ${actor.username}`,
      );
    }

    return this.toResponse(
      await this.requireGrant(grantId),
    );
  }

  /**
   * Enqueues the users of grants that just expired, so the outbox
   * removes their membership. Safe with several replicas (SKIP LOCKED).
   * The Grafana sync is level-triggered, so even a late sweep never
   * leaves access in place: any other sync of the user drops it too.
   */
  async sweepExpired(): Promise<number> {
    if (this.sweeping) {
      return 0;
    }

    this.sweeping = true;

    try {
      const expired =
        await this.db.transaction(async (tx) => {
          const claimed =
            await this.grants.claimExpired(tx);

          for (const userId of new Set(
            claimed.map((grant) => grant.userId),
          )) {
            await this.outbox.enqueue(tx, 'user', userId);
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

  private toResponse(
    grant: SupportAccessRecord,
  ) {
    const now = Date.now();

    return {
      id: grant.id,
      tenantId: grant.tenantKey,
      username: grant.username,
      role: grant.role,
      reason: grant.reason,
      grantedBy: grant.grantedBy,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      revokedBy: grant.revokedBy,
      active:
        grant.revokedAt === null &&
        grant.expiresAt.getTime() > now,
    };
  }

  private async requireGrant(
    id: string,
  ): Promise<SupportAccessRecord> {
    const grant = await this.grants.findById(id);

    if (!grant) {
      throw new NotFoundException('Support access not found');
    }

    return grant;
  }

  private async requireTenant(
    tenantKey: string,
  ): Promise<TenantRecord> {
    const tenant =
      await this.tenants.findByKey(tenantKey);

    if (!tenant || tenant.status === 'deleted') {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  private async requireActiveTenant(
    tenantKey: string,
  ): Promise<TenantRecord> {
    const tenant = await this.requireTenant(tenantKey);

    if (tenant.status !== 'active') {
      throw new ConflictException(
        `Tenant is ${tenant.status}`,
      );
    }

    return tenant;
  }

  private requirePlatformAdmin(
    actor: AuthUser,
  ): void {
    if (!actor.roles.includes('platform-admin')) {
      throw new ForbiddenException(
        'platform-admin role required',
      );
    }
  }

  /** platform-admin, or tenant-admin of exactly this tenant. */
  private requireTenantOversight(
    actor: AuthUser,
    tenantKey: string,
  ): void {
    if (actor.roles.includes('platform-admin')) {
      return;
    }

    const groups = actor.groups
      .map((group) => group.replace(/^\/+/, ''))
      .filter(Boolean);

    if (
      actor.roles.includes('tenant-admin') &&
      groups.length === 1 &&
      groups[0] === tenantKey
    ) {
      return;
    }

    throw new ForbiddenException(
      'tenant-admin of this tenant or platform-admin role required',
    );
  }

  private validateReason(
    value: unknown,
  ): string {
    const reason =
      typeof value === 'string' ? value.trim() : '';

    if (reason.length < 10 || reason.length > 500) {
      throw new BadRequestException(
        'reason is required (10-500 characters), e.g. a ticket id and what you need to check',
      );
    }

    return reason;
  }

  private validateMinutes(
    value: unknown,
  ): number {
    if (value === undefined || value === null) {
      return DEFAULT_MINUTES;
    }

    const max =
      this.numberFromEnv(
        'SUPPORT_ACCESS_MAX_MINUTES',
        DEFAULT_MAX_MINUTES,
      );

    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < MIN_MINUTES ||
      value > max
    ) {
      throw new BadRequestException(
        `minutes must be an integer between ${MIN_MINUTES} and ${max}`,
      );
    }

    return value;
  }

  private validateRole(
    value: unknown,
  ): SupportAccessRole {
    if (value === undefined || value === null) {
      return 'Viewer';
    }

    if (value !== 'Viewer' && value !== 'Editor') {
      throw new BadRequestException(
        'role must be Viewer or Editor',
      );
    }

    return value;
  }

  private isUuid(
    value: string,
  ): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private numberFromEnv(
    key: string,
    fallback: number,
  ): number {
    const raw = this.config.get<string>(key);

    if (raw === undefined || raw === '') {
      return fallback;
    }

    const value = Number(raw);

    return Number.isFinite(value) ? value : fallback;
  }
}
