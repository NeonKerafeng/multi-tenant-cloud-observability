import { Injectable, Logger } from '@nestjs/common';

import type { Queryable } from '../../common/db/database.service';
import { ConflictError } from '../../common/errors/domain-error';
import { isUuid } from '../../common/http/validation';
import { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import {
  attr,
  type Attributes,
  type KcGroup,
  TENANT_MARKER,
} from '../../integrations/keycloak/keycloak.types';
import {
  type TenantRecord,
  TenantRepository,
} from '../../modules/tenants/tenant.repository';
import type { MirrorHandler } from '../../sync/mirror';

/** Written by v0.6 and earlier; replaced by the ownership marker. */
const LEGACY_ATTRIBUTE = 'mtco_tenant';

/**
 * Tenant → top-level Keycloak group (FROZEN contract, CLAUDE.md §18.3.5):
 * name = tenantKey, attribute vm_account_id = [n] (aggregated into the
 * `vm_account_id` claim that query-gateway trusts), plus the ownership
 * marker mtco_tenant_id = [tenants.id].
 */
@Injectable()
export class KeycloakTenantMirror implements MirrorHandler {
  readonly target = 'keycloak' as const;
  readonly aggregate = 'tenant' as const;

  private readonly logger = new Logger(KeycloakTenantMirror.name);

  constructor(
    private readonly keycloak: KeycloakClient,
    private readonly tenants: TenantRepository,
  ) {}

  async sync(tenantId: string): Promise<void> {
    const tenant = await this.tenants.findById(tenantId);

    if (tenant) {
      await this.apply(tenant);
    }
  }

  /** Converges one tenant. `q` = caller's transaction for inline creates. */
  async apply(tenant: TenantRecord, q?: Queryable): Promise<void> {
    if (tenant.status === 'active') {
      const groupId = await this.ensureGroup(tenant);

      if (groupId !== tenant.keycloakGroupId) {
        await this.tenants.setKeycloakGroupId(tenant.id, groupId, q);
      }

      return;
    }

    const group = await this.ownedGroup(tenant);

    if (group) {
      await this.keycloak.deleteGroup(group.id);
      this.logger.log(`Tenant ${tenant.tenantKey}: Keycloak group deleted`);
    }

    if (tenant.keycloakGroupId !== null) {
      await this.tenants.setKeycloakGroupId(tenant.id, null, q);
    }
  }

  private async ensureGroup(tenant: TenantRecord): Promise<string> {
    const group = await this.resolveForWrite(tenant);

    const attributes: Attributes = {
      ...withoutKey(group?.attributes, LEGACY_ATTRIBUTE),
      vm_account_id: [tenant.vmAccountId],
      [TENANT_MARKER]: [tenant.id],
    };

    if (!group) {
      const id = await this.keycloak.createGroup({
        name: tenant.tenantKey,
        attributes,
      });

      this.logger.log(`Tenant ${tenant.tenantKey}: Keycloak group created`);

      return id;
    }

    if (
      group.name !== tenant.tenantKey ||
      !sameAttributes(group.attributes, attributes)
    ) {
      await this.keycloak.updateGroup({
        id: group.id,
        name: tenant.tenantKey,
        attributes,
      });
    }

    return group.id;
  }

  /**
   * Adoption rules (§18.3.7): stored id still ours → it; else exact name:
   * our marker → it; marker of a row that is gone/deleted → our orphan,
   * adopt; no marker → foreign group, refuse.
   */
  private async resolveForWrite(tenant: TenantRecord): Promise<KcGroup | null> {
    const stored = await this.storedGroup(tenant);

    if (stored) {
      return stored;
    }

    const byName = await this.keycloak.findTopLevelGroup(tenant.tenantKey);

    if (!byName) {
      return null;
    }

    const marker = attr(byName.attributes, TENANT_MARKER);

    if (marker === tenant.id) {
      return byName;
    }

    if (!marker) {
      throw new ConflictError(
        'identity_conflict',
        `Keycloak group "${tenant.tenantKey}" exists but is not managed by MTCO`,
      );
    }

    const owner = isUuid(marker) ? await this.tenants.findById(marker) : null;

    if (owner && owner.status === 'active') {
      throw new ConflictError(
        'identity_conflict',
        `Keycloak group "${tenant.tenantKey}" belongs to another tenant`,
      );
    }

    this.logger.warn(
      `Tenant ${tenant.tenantKey}: adopting orphan Keycloak group ${byName.id}`,
    );

    return byName;
  }

  /** The group this tenant may DELETE: only one that is provably ours. */
  private async ownedGroup(tenant: TenantRecord): Promise<KcGroup | null> {
    const stored = await this.storedGroup(tenant);

    if (stored) {
      return stored;
    }

    const byName = await this.keycloak.findTopLevelGroup(tenant.tenantKey);

    return byName && attr(byName.attributes, TENANT_MARKER) === tenant.id
      ? byName
      : null;
  }

  private async storedGroup(tenant: TenantRecord): Promise<KcGroup | null> {
    if (!tenant.keycloakGroupId) {
      return null;
    }

    const group = await this.keycloak.getGroup(tenant.keycloakGroupId);

    if (!group) {
      return null;
    }

    const marker = attr(group.attributes, TENANT_MARKER);

    return marker === tenant.id || (!marker && group.name === tenant.tenantKey)
      ? group
      : null;
  }
}

function withoutKey(
  attributes: Attributes | undefined,
  key: string,
): Attributes {
  const copy: Attributes = { ...(attributes ?? {}) };
  delete copy[key];
  return copy;
}

function sameAttributes(
  current: Attributes | undefined,
  desired: Attributes,
): boolean {
  const left = current ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(desired)]);

  for (const key of keys) {
    if (
      JSON.stringify(left[key] ?? null) !== JSON.stringify(desired[key] ?? null)
    ) {
      return false;
    }
  }

  return true;
}
