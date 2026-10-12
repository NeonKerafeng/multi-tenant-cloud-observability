import { Injectable, Logger } from '@nestjs/common';

import { isUuid } from '../../common/http/validation';
import { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import {
  attr,
  TENANT_MARKER,
  USER_MARKER,
} from '../../integrations/keycloak/keycloak.types';
import {
  AGENT_CLIENT_PREFIX,
  AgentRepository,
} from '../../modules/agents/agent.repository';
import { EnrollmentRepository } from '../../modules/enrollments/enrollment.repository';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { UserRepository } from '../../modules/users/user.repository';

/** An orphan is deleted only when seen twice, at least this far apart. */
export const GC_CONFIRM_MS = 2 * 60 * 1000;

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/** More orphans than this share of a kind → assume a bug, delete none. */
const MAX_ORPHAN_SHARE = 0.5;
const ALWAYS_ALLOWED = 5;

export interface GcResult {
  deleted: number;
  /** Seen once; deleted by a later run if still orphaned. */
  pending: number;
}

interface Orphan {
  key: string;
  label: string;
  remove: () => Promise<void>;
}

/**
 * Removes Keycloak objects that are OURS but have no live DB row
 * (closes I-20 / TODO-07): agent clients `otel-agent-<id>` without a live
 * agent or an open enrollment, users marked mtco_user_id and groups marked
 * mtco_tenant_id whose row is gone or deleted. Sources: rolled-back inline
 * creates, v0.6 leftovers, manual mistakes. Objects without our marker or
 * prefix are never touched.
 *
 * Safety: an object is deleted only when it is orphaned on two runs at
 * least GC_CONFIRM_MS apart (an inline create still inside its DB
 * transaction is invisible for a moment), and never when a suspiciously
 * large share of a kind looks orphaned. Runs with the resync.
 */
@Injectable()
export class KeycloakGarbageCollector {
  private readonly logger = new Logger(KeycloakGarbageCollector.name);

  /** Orphan key → first time seen (per process). */
  private readonly firstSeen = new Map<string, number>();

  constructor(
    private readonly keycloak: KeycloakClient,
    private readonly agents: AgentRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly users: UserRepository,
    private readonly tenants: TenantRepository,
  ) {}

  async run(): Promise<GcResult> {
    const orphans = [
      ...(await this.orphanClients()),
      ...(await this.orphanUsers()),
      ...(await this.orphanGroups()),
    ];

    const now = Date.now();
    const current = new Set(orphans.map((orphan) => orphan.key));

    for (const key of [...this.firstSeen.keys()]) {
      if (!current.has(key)) {
        this.firstSeen.delete(key);
      }
    }

    let deleted = 0;
    let pending = 0;

    for (const orphan of orphans) {
      const seen = this.firstSeen.get(orphan.key);

      if (seen === undefined) {
        this.firstSeen.set(orphan.key, now);
        pending += 1;
        continue;
      }

      if (now - seen < GC_CONFIRM_MS) {
        pending += 1;
        continue;
      }

      await orphan.remove();
      this.firstSeen.delete(orphan.key);
      deleted += 1;
      this.logger.log(`Deleted orphan Keycloak ${orphan.label}`);
    }

    if (pending > 0) {
      this.logger.log(
        `${pending} orphan Keycloak object(s) seen; deleted by a later run if still orphaned`,
      );
    }

    return { deleted, pending };
  }

  private async orphanClients(): Promise<Orphan[]> {
    const clients = (
      await this.pages((first, max) =>
        this.keycloak.listClients(AGENT_CLIENT_PREFIX, first, max),
      )
    ).filter((client) => client.clientId.startsWith(AGENT_CLIENT_PREFIX));

    const keep = new Set([
      ...(await this.agents.liveIds()),
      ...(await this.enrollments.openAgentIds()),
    ]);

    const orphans = clients
      .filter((client) => {
        const agentId = client.clientId.slice(AGENT_CLIENT_PREFIX.length);

        return isUuid(agentId) && !keep.has(agentId.toLowerCase());
      })
      .map((client): Orphan => ({
        key: `client:${client.id}`,
        label: `client ${client.clientId}`,
        remove: () => this.keycloak.deleteClient(client.id),
      }));

    return this.sane('agent clients', orphans, clients.length);
  }

  private async orphanUsers(): Promise<Orphan[]> {
    const marked = (
      await this.pages((first, max) => this.keycloak.listUsers(first, max))
    )
      .map((user) => ({ user, rowId: attr(user.attributes, USER_MARKER) }))
      .filter((entry): entry is typeof entry & { rowId: string } =>
        isUuid(entry.rowId),
      );

    const live = new Set(
      await this.users.findActiveIds(marked.map((entry) => entry.rowId)),
    );

    const orphans = marked
      .filter((entry) => !live.has(entry.rowId.toLowerCase()))
      .map(({ user }): Orphan => ({
        key: `user:${user.id}`,
        label: `user ${user.username}`,
        remove: () => this.keycloak.deleteUser(user.id),
      }));

    return this.sane('users', orphans, marked.length);
  }

  private async orphanGroups(): Promise<Orphan[]> {
    const marked = (
      await this.pages((first, max) => this.keycloak.listGroups(first, max))
    )
      .map((group) => ({ group, rowId: attr(group.attributes, TENANT_MARKER) }))
      .filter((entry): entry is typeof entry & { rowId: string } =>
        isUuid(entry.rowId),
      );

    const live = new Set(
      await this.tenants.findActiveIds(marked.map((entry) => entry.rowId)),
    );

    const orphans = marked
      .filter((entry) => !live.has(entry.rowId.toLowerCase()))
      .map(({ group }): Orphan => ({
        key: `group:${group.id}`,
        label: `group ${group.name}`,
        remove: () => this.keycloak.deleteGroup(group.id),
      }));

    return this.sane('groups', orphans, marked.length);
  }

  /** Refuses a kind when "almost everything is an orphan" (bug, restored DB…). */
  private sane(kind: string, orphans: Orphan[], total: number): Orphan[] {
    if (
      orphans.length > ALWAYS_ALLOWED &&
      orphans.length > total * MAX_ORPHAN_SHARE
    ) {
      this.logger.error(
        `GC refused: ${orphans.length} of ${total} ${kind} look orphaned; check the DB before deleting anything by hand`,
      );
      return [];
    }

    return orphans;
  }

  private async pages<T>(
    fetchPage: (first: number, max: number) => Promise<T[]>,
  ): Promise<T[]> {
    const all: T[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const items = await fetchPage(page * PAGE_SIZE, PAGE_SIZE);

      all.push(...items);

      if (items.length < PAGE_SIZE) {
        break;
      }
    }

    return all;
  }
}
