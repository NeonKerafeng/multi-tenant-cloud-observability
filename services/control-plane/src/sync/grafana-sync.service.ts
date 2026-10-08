import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

import {
  type GrafanaOrgRole,
  GrafanaAdminService,
} from '../grafana/grafana-admin.service';

import { SupportAccessRepository } from '../support-access/support-access.repository';

import {
  DEFAULT_GRAFANA_ORG_ID,
  TenantGrafanaService,
} from '../tenants/tenant-grafana.service';
import { TenantRepository } from '../tenants/tenant.repository';

import {
  type UserRecord,
  UserRepository,
} from '../users/user.repository';

import {
  type AggregateType,
  OutboxRepository,
} from './outbox.repository';

/** Grafana org role for each control-plane role (in its home org). */
const ORG_ROLE: Record<UserRecord['role'], GrafanaOrgRole> = {
  'platform-admin': 'Editor',
  'tenant-admin': 'Editor',
  viewer: 'Viewer',
};

const ROLE_RANK: Record<GrafanaOrgRole, number> = {
  Viewer: 1,
  Editor: 2,
  Admin: 3,
};

/**
 * Converges Grafana to the control-plane DB.
 *
 * Handlers are level-triggered: they ignore what changed and re-read the
 * CURRENT state, then make Grafana match it. Running a handler twice, out
 * of order, or concurrently with another one is therefore harmless.
 *
 * A thrown error means "not converged yet": the outbox retries later.
 */
@Injectable()
export class GrafanaSyncService {
  private readonly logger =
    new Logger(GrafanaSyncService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly tenantGrafana: TenantGrafanaService,
    private readonly grafana: GrafanaAdminService,
    private readonly supportAccess: SupportAccessRepository,
  ) {}

  async handle(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<void> {
    if (aggregateType === 'tenant') {
      await this.syncTenant(aggregateId);
    } else {
      await this.syncUser(aggregateId);
    }
  }

  /**
   * active            -> org + datasources exist
   * deleting/deleted  -> org removed
   * Then the users whose desired memberships depend on this org are
   * re-synced: the tenant's own users and platform admins holding an
   * open support-access grant on it.
   */
  async syncTenant(
    tenantId: string,
  ): Promise<void> {
    const tenant =
      await this.tenants.findById(tenantId);

    if (!tenant) {
      return;
    }

    if (tenant.status === 'active') {
      await this.tenantGrafana.provisionOrg(tenant);
    } else if (
      tenant.status === 'deleting' ||
      tenant.status === 'deleted'
    ) {
      await this.tenantGrafana.removeOrg(tenant);
    } else {
      // provisioning / error: nothing to mirror yet.
      return;
    }

    await this.enqueueUsers([
      ...(await this.users.findIdsByTenant(tenant.id)),
      ...(await this.supportAccess.findOpenUserIdsByTenant(tenant.id)),
    ]);
  }

  /**
   * Makes the user's Grafana account match the DB:
   * - exists only while the user is active, enabled, and its tenant
   *   active. Grafana refuses to enable/disable SSO-linked users through
   *   the API, so a disabled user's Grafana account is DELETED (this also
   *   kills its sessions) and re-created when re-enabled; the next
   *   Keycloak login re-links it by email.
   * - member of exactly the desired orgs with the desired role
   */
  async syncUser(
    userId: string,
  ): Promise<void> {
    const user =
      await this.users.findById(userId);

    if (!user) {
      return;
    }

    const desired =
      await this.desiredMemberships(user);

    if (desired === null) {
      if (user.grafanaUserId !== null) {
        await this.grafana.deleteUser(
          user.grafanaUserId,
        );

        this.logger.log(
          `Grafana user ${user.grafanaUserId} (${user.username}) deleted`,
        );

        await this.users.setGrafanaUserId(
          user.id,
          null,
        );
      }

      return;
    }

    if (desired.size === 0) {
      throw new Error(
        `Grafana org of tenant ${user.tenantKey ?? '?'} is not provisioned yet`,
      );
    }

    const grafanaUserId =
      await this.ensureGrafanaUser(
        user,
        desired.keys().next().value as number,
      );

    const current =
      await this.grafana.getUserOrgs(
        grafanaUserId,
      );

    for (const [orgId, role] of desired) {
      const membership =
        current.find(
          (org) => org.orgId === orgId,
        );

      if (!membership) {
        await this.grafana.addOrgUser(
          orgId,
          user.email,
          role,
        );

        this.logger.log(
          `${user.username}: added to org ${orgId} as ${role}`,
        );
      } else if (membership.role !== role) {
        await this.grafana.updateOrgUserRole(
          orgId,
          grafanaUserId,
          role,
        );

        this.logger.log(
          `${user.username}: role in org ${orgId} ${membership.role} -> ${role}`,
        );
      }
    }

    for (const membership of current) {
      if (!desired.has(membership.orgId)) {
        await this.grafana.removeOrgUser(
          membership.orgId,
          grafanaUserId,
        );

        this.logger.log(
          `${user.username}: removed from org ${membership.orgId}`,
        );
      }
    }
  }

  /**
   * null      -> the user must not exist in Grafana
   * empty map -> should exist, but its org is not ready (retry later)
   *
   * Platform admins (model C): the platform org (org 1) as Editor, plus
   * every tenant org they hold a support-access grant for RIGHT NOW,
   * with the grant's role. Expired / revoked grants simply drop out.
   */
  async desiredMemberships(
    user: UserRecord,
  ): Promise<Map<number, GrafanaOrgRole> | null> {
    if (
      user.status !== 'active' ||
      !user.enabled
    ) {
      return null;
    }

    const desired =
      new Map<number, GrafanaOrgRole>();

    if (user.role === 'platform-admin') {
      desired.set(
        DEFAULT_GRAFANA_ORG_ID,
        ORG_ROLE[user.role],
      );

      for (const grant of await this.supportAccess.findActiveGrantsForUser(
        user.id,
      )) {
        const existing = desired.get(grant.grafanaOrgId);

        if (
          !existing ||
          ROLE_RANK[grant.role] > ROLE_RANK[existing]
        ) {
          desired.set(grant.grafanaOrgId, grant.role);
        }
      }

      return desired;
    }

    const tenant =
      user.tenantId === null
        ? null
        : await this.tenants.findById(user.tenantId);

    if (!tenant || tenant.status !== 'active') {
      return null;
    }

    if (tenant.grafanaOrgId !== null) {
      desired.set(
        tenant.grafanaOrgId,
        ORG_ROLE[user.role],
      );
    }

    return desired;
  }

  /**
   * Finds the Grafana account for this user (stored id, then email,
   * then login) or creates it, and stores its id.
   */
  private async ensureGrafanaUser(
    user: UserRecord,
    initialOrgId: number,
  ): Promise<number> {
    if (user.grafanaUserId !== null) {
      const existing =
        await this.grafana.getUser(
          user.grafanaUserId,
        );

      if (existing) {
        return existing.id;
      }
    }

    const found =
      (await this.grafana.lookupUser(user.email)) ??
      (await this.grafana.lookupUser(user.username));

    const grafanaUserId =
      found?.id ??
      (await this.grafana.createUser({
        login: user.username,
        email: user.email,
        name: user.username,
        orgId: initialOrgId,
      }));

    if (grafanaUserId !== user.grafanaUserId) {
      await this.users.setGrafanaUserId(
        user.id,
        grafanaUserId,
      );
    }

    return grafanaUserId;
  }

  private async enqueueUsers(
    userIds: string[],
  ): Promise<void> {
    for (const userId of new Set(userIds)) {
      await this.outbox.enqueue(
        this.db,
        'user',
        userId,
      );
    }
  }
}
