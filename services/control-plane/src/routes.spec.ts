import { routeInventory } from './common/testing/routes';

/*
 * The complete HTTP API (CLAUDE.md §18.5.1 + v0.9 enrollment list/revoke). Every route except
 * healthz/readyz/metrics is served under /api/v1 (app.setup.ts; checked by
 * app.http.spec.ts). Changing this list = changing the API contract.
 */
describe('route inventory (v0.9)', () => {
  it('every route is @Public or has @Roles (fail closed)', () => {
    expect(routeInventory().filter((r) => r.access === 'MISSING')).toEqual([]);
  });

  it('exposes exactly the expected routes with the expected roles', () => {
    expect(
      routeInventory().map((r) => `${r.method} ${r.path} [${r.access}]`),
    ).toEqual([
      'DELETE /tenants/:tenantKey [platform-admin]',
      'DELETE /tenants/:tenantKey/agent-enrollments/:enrollmentId [platform-admin,tenant-admin]',
      'DELETE /tenants/:tenantKey/agents/:agentId [platform-admin,tenant-admin]',
      'DELETE /tenants/:tenantKey/support-access/:grantId [platform-admin]',
      'DELETE /tenants/:tenantKey/users/:userId [platform-admin,tenant-admin]',
      'GET /admin/sync/status [platform-admin]',
      'GET /healthz [public]',
      'GET /me [platform-admin,tenant-admin,viewer]',
      'GET /metrics [public]',
      'GET /readyz [public]',
      'GET /support-access [platform-admin]',
      'GET /tenants [platform-admin]',
      'GET /tenants/:tenantKey [platform-admin,tenant-admin]',
      'GET /tenants/:tenantKey/agent-enrollments [platform-admin,tenant-admin]',
      'GET /tenants/:tenantKey/agents [platform-admin,tenant-admin]',
      'GET /tenants/:tenantKey/agents/:agentId [platform-admin,tenant-admin]',
      'GET /tenants/:tenantKey/support-access [platform-admin,tenant-admin]',
      'GET /tenants/:tenantKey/users [platform-admin,tenant-admin]',
      'GET /tenants/:tenantKey/users/:userId [platform-admin,tenant-admin]',
      'PATCH /tenants/:tenantKey/agents/:agentId [platform-admin,tenant-admin]',
      'PATCH /tenants/:tenantKey/users/:userId [platform-admin,tenant-admin]',
      'POST /admin/sync/resync [platform-admin]',
      'POST /agent-enrollments/exchange [public]',
      'POST /tenants [platform-admin]',
      'POST /tenants/:tenantKey/agent-enrollments [platform-admin,tenant-admin]',
      'POST /tenants/:tenantKey/support-access [platform-admin]',
      'POST /tenants/:tenantKey/users [platform-admin,tenant-admin]',
    ]);
  });
});
