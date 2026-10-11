import { ConflictError } from '../../common/errors/domain-error';
import { IDS, tenant } from '../../common/testing/fixtures';
import type { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import type { KcGroup } from '../../integrations/keycloak/keycloak.types';
import type {
  TenantRecord,
  TenantRepository,
} from '../../modules/tenants/tenant.repository';

import { KeycloakTenantMirror } from './keycloak-tenant.mirror';

function setup(opts: {
  byId?: KcGroup | null;
  byName?: KcGroup | null;
  owner?: TenantRecord | null;
}) {
  const keycloak = {
    getGroup: jest.fn().mockResolvedValue(opts.byId ?? null),
    findTopLevelGroup: jest.fn().mockResolvedValue(opts.byName ?? null),
    createGroup: jest.fn().mockResolvedValue('g-new'),
    updateGroup: jest.fn().mockResolvedValue(undefined),
    deleteGroup: jest.fn().mockResolvedValue(undefined),
  };

  const tenants = {
    findById: jest.fn().mockResolvedValue(opts.owner ?? null),
    setKeycloakGroupId: jest.fn().mockResolvedValue(undefined),
  };

  const mirror = new KeycloakTenantMirror(
    keycloak as unknown as KeycloakClient,
    tenants as unknown as TenantRepository,
  );

  return { mirror, keycloak, tenants };
}

const desiredAttributes = { vm_account_id: ['2'], mtco_tenant_id: [IDS.alpha] };

describe('KeycloakTenantMirror (active tenant)', () => {
  it('creates the group with vm_account_id and the marker, stores its id', async () => {
    const { mirror, keycloak, tenants } = setup({});

    await mirror.apply(tenant({ keycloakGroupId: null }));

    expect(keycloak.createGroup).toHaveBeenCalledWith({
      name: 'alpha-tenant',
      attributes: desiredAttributes,
    });
    expect(tenants.setKeycloakGroupId).toHaveBeenCalledWith(
      IDS.alpha,
      'g-new',
      undefined,
    );
  });

  it('adopts the legacy group by stored id: adds the marker, drops mtco_tenant', async () => {
    const { mirror, keycloak, tenants } = setup({
      byId: {
        id: 'g-alpha',
        name: 'alpha-tenant',
        attributes: { vm_account_id: ['2'], mtco_tenant: ['true'] },
      },
    });

    await mirror.apply(tenant());

    expect(keycloak.updateGroup).toHaveBeenCalledWith({
      id: 'g-alpha',
      name: 'alpha-tenant',
      attributes: desiredAttributes,
    });
    expect(keycloak.createGroup).not.toHaveBeenCalled();
    expect(tenants.setKeycloakGroupId).not.toHaveBeenCalled();
  });

  it('does nothing when already converged', async () => {
    const { mirror, keycloak } = setup({
      byId: {
        id: 'g-alpha',
        name: 'alpha-tenant',
        attributes: desiredAttributes,
      },
    });

    await mirror.apply(tenant());

    expect(keycloak.updateGroup).not.toHaveBeenCalled();
    expect(keycloak.createGroup).not.toHaveBeenCalled();
  });

  it('refuses a same-name group that MTCO does not manage', async () => {
    const { mirror } = setup({
      byName: { id: 'g-x', name: 'alpha-tenant', attributes: {} },
    });

    await expect(
      mirror.apply(tenant({ keycloakGroupId: null })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('adopts an orphan group whose marker points to a row that does not exist', async () => {
    const { mirror, keycloak, tenants } = setup({
      byName: {
        id: 'g-orphan',
        name: 'alpha-tenant',
        attributes: {
          mtco_tenant_id: ['00000000-0000-4000-8000-00000000dead'],
        },
      },
      owner: null,
    });

    await mirror.apply(tenant({ keycloakGroupId: null }));

    expect(keycloak.updateGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'g-orphan',
        attributes: desiredAttributes,
      }),
    );
    expect(tenants.setKeycloakGroupId).toHaveBeenCalledWith(
      IDS.alpha,
      'g-orphan',
      undefined,
    );
  });

  it('refuses a group owned by another active tenant', async () => {
    const { mirror } = setup({
      byName: {
        id: 'g-b',
        name: 'alpha-tenant',
        attributes: { mtco_tenant_id: [IDS.beta] },
      },
      owner: tenant({ id: IDS.beta, tenantKey: 'beta-tenant' }),
    });

    await expect(
      mirror.apply(tenant({ keycloakGroupId: null })),
    ).rejects.toThrow(/another tenant/);
  });
});

describe('KeycloakTenantMirror (deleted tenant)', () => {
  it('deletes its group and clears the pointer', async () => {
    const { mirror, keycloak, tenants } = setup({
      byId: {
        id: 'g-alpha',
        name: 'alpha-tenant',
        attributes: desiredAttributes,
      },
    });

    await mirror.apply(tenant({ status: 'deleted' }));

    expect(keycloak.deleteGroup).toHaveBeenCalledWith('g-alpha');
    expect(tenants.setKeycloakGroupId).toHaveBeenCalledWith(
      IDS.alpha,
      null,
      undefined,
    );
  });

  it('never deletes a group it cannot prove is its own', async () => {
    const { mirror, keycloak } = setup({
      byName: { id: 'g-x', name: 'alpha-tenant', attributes: {} },
    });

    await mirror.apply(tenant({ status: 'deleted', keycloakGroupId: null }));

    expect(keycloak.deleteGroup).not.toHaveBeenCalled();
  });
});
