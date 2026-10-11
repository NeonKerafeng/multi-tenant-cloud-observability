import { Injectable, Logger } from '@nestjs/common';

import type { Role } from '../../common/auth/actor';
import {
  GrafanaClient,
  type GrafanaOrgRole,
} from '../../integrations/grafana/grafana.client';
import { SupportAccessRepository } from '../../modules/support-access/support-access.repository';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import {
  type UserRecord,
  UserRepository,
} from '../../modules/users/user.repository';
import type { MirrorHandler } from '../../sync/mirror';

import { DEFAULT_GRAFANA_ORG_ID } from './grafana-tenant.mirror';

/** Grafana org role for each control-plane role (in its home org). */
const ORG_ROLE: Record<Role, GrafanaOrgRole> = {
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
 * Human user → Grafana account + org memberships.
 * - The account exists only while the user is active, enabled and its
 *   tenant active. Grafana refuses to enable/disable SSO-linked users
 *   through the API, so a disabled user's account is DELETED (this also
 *   kills its sessions) and re-created when re-enabled; the next Keycloak
 *   login re-links it by email.
 * - Member of exactly the desired orgs with the desired role. Platform
 *   admins (model C, D-04): org 1 as Editor + every tenant org with an
 *   active support-access grant (strongest role wins).
 */
@Injectable()
export class GrafanaUserMirror implements MirrorHandler {
  readonly target = 'grafana' as const;
  readonly aggregate = 'user' as const;

  private readonly logger = new Logger(GrafanaUserMirror.name);

  constructor(
    private readonly grafana: GrafanaClient,
    private readonly users: UserRepository,
    private readonly tenants: TenantRepository,
    private readonly supportAccess: SupportAccessRepository,
  ) {}

  async sync(userId: string): Promise<void> {
    const user = await this.users.findById(userId);

    if (!user) {
      return;
    }

    const desired = await this.desiredMemberships(user);

    if (desired === null) {
      if (user.grafanaUserId !== null) {
        await this.grafana.deleteUser(user.grafanaUserId);
        this.logger.log(
          `Grafana user ${user.grafanaUserId} (${user.username}) deleted`,
        );
        await this.users.setGrafanaUserId(user.id, null);
      }

      return;
    }

    if (desired.size === 0) {
      throw new Error(
        `Grafana org of tenant ${user.tenantKey ?? '?'} is not provisioned yet`,
      );
    }

    const grafanaUserId = await this.ensureGrafanaUser(
      user,
      desired.keys().next().value as number,
    );

    const current = await this.grafana.getUserOrgs(grafanaUserId);

    for (const [orgId, role] of desired) {
      const membership = current.find((org) => org.orgId === orgId);

      if (!membership) {
        await this.grafana.addOrgUser(orgId, user.email, role);
        this.logger.log(`${user.username}: added to org ${orgId} as ${role}`);
      } else if (membership.role !== role) {
        await this.grafana.updateOrgUserRole(orgId, grafanaUserId, role);
        this.logger.log(
          `${user.username}: role in org ${orgId} ${membership.role} -> ${role}`,
        );
      }
    }

    for (const membership of current) {
      if (!desired.has(membership.orgId)) {
        await this.grafana.removeOrgUser(membership.orgId, grafanaUserId);
        this.logger.log(
          `${user.username}: removed from org ${membership.orgId}`,
        );
      }
    }
  }

  /**
   * null      -> the user must not exist in Grafana
   * empty map -> should exist, but its org is not ready (retry later)
   */
  async desiredMemberships(
    user: UserRecord,
  ): Promise<Map<number, GrafanaOrgRole> | null> {
    if (user.status !== 'active' || !user.enabled) {
      return null;
    }

    const desired = new Map<number, GrafanaOrgRole>();

    if (user.role === 'platform-admin') {
      desired.set(DEFAULT_GRAFANA_ORG_ID, ORG_ROLE[user.role]);

      for (const grant of await this.supportAccess.findActiveGrantsForUser(
        user.id,
      )) {
        const existing = desired.get(grant.grafanaOrgId);

        if (!existing || ROLE_RANK[grant.role] > ROLE_RANK[existing]) {
          desired.set(grant.grafanaOrgId, grant.role);
        }
      }

      return desired;
    }

    const tenant = user.tenantId
      ? await this.tenants.findById(user.tenantId)
      : null;

    if (!tenant || tenant.status !== 'active') {
      return null;
    }

    if (tenant.grafanaOrgId !== null) {
      desired.set(tenant.grafanaOrgId, ORG_ROLE[user.role]);
    }

    return desired;
  }

  /**
   * Finds the Grafana account for this user (stored id, then email, then
   * login) or creates it, and stores its id.
   */
  private async ensureGrafanaUser(
    user: UserRecord,
    initialOrgId: number,
  ): Promise<number> {
    if (user.grafanaUserId !== null) {
      const existing = await this.grafana.getUser(user.grafanaUserId);

      /*
       * Trust a stored id only if it still belongs to THIS person: after a
       * Grafana rebuild ids are reassigned.
       */
      if (
        existing &&
        (existing.login === user.username || existing.email === user.email)
      ) {
        return existing.id;
      }

      if (existing) {
        this.logger.warn(
          `${user.username}: stored Grafana user ${user.grafanaUserId} belongs to ${existing.login}; ignoring it`,
        );
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
      await this.users.setGrafanaUserId(user.id, grafanaUserId);
    }

    return grafanaUserId;
  }
}
