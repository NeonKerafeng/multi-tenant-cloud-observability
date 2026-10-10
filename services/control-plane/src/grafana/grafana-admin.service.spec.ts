jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

import type { ConfigService } from '@nestjs/config';

import { GrafanaAdminService } from './grafana-admin.service';

type Route = (init: RequestInit & { headers: Record<string, string> }) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(routes: Record<string, Route>) {
  const calls: string[] = [];

  const fetchMock = jest.fn((url: string, init: RequestInit) => {
    const path = url.replace('http://grafana:3000', '');
    const key = `${init.method} ${path}`;
    const headers = init.headers as Record<string, string>;
    calls.push(`${key}${headers['X-Grafana-Org-Id'] ? ` @${headers['X-Grafana-Org-Id']}` : ''}`);
    const route = routes[key];
    return Promise.resolve(route ? route({ ...init, headers }) : json({}, 404));
  });

  global.fetch = fetchMock;

  const config = {
    getOrThrow: jest.fn(
      (key: string) =>
        ({
          GRAFANA_URL: 'http://grafana:3000',
          GRAFANA_ADMIN_USER: 'admin',
          GRAFANA_ADMIN_PASSWORD: 'pw',
        })[key],
    ),
  };

  const service = new GrafanaAdminService(config as unknown as ConfigService);

  return { service, calls };
}

describe('GrafanaAdminService.deleteOrg', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it.each([
    [200, 'deleted'],
    [404, 'deleted'],
    [500, 'refused'],
  ])('status %i -> %s', async (status, expected) => {
    const { service } = setup({
      'DELETE /api/orgs/3': () => json({ message: 'x' }, status),
    });

    await expect(service.deleteOrg(3)).resolves.toBe(expected);
  });

  it('throws on other errors', async () => {
    const { service } = setup({
      'DELETE /api/orgs/3': () => json({ message: 'forbidden' }, 403),
    });

    await expect(service.deleteOrg(3)).rejects.toThrow(/403/);
  });
});

describe('GrafanaAdminService.retireOrg', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('removes members (not the server admin), datasources, dashboards, folders, then renames', async () => {
    const ok = () => json({ message: 'ok' });
    const { service, calls } = setup({
      'GET /api/orgs/3/users': () =>
        json([
          { userId: 1, login: 'admin' },
          { userId: 9, login: 'root-admin' },
        ]),
      'DELETE /api/orgs/3/users/9': ok,
      'GET /api/datasources': () => json([{ uid: 'opensearch' }, { uid: 'victoriametrics' }]),
      'DELETE /api/datasources/uid/opensearch': ok,
      'DELETE /api/datasources/uid/victoriametrics': ok,
      'GET /api/search?type=dash-db&limit=5000': () =>
        json([{ uid: 'mtco-host-overview' }, { uid: 'gone' }]),
      'DELETE /api/dashboards/uid/mtco-host-overview': ok,
      'GET /api/folders?limit=1000': () => json([{ uid: 'f1' }]),
      'DELETE /api/folders/f1?forceDeleteRules=true': ok,
      'GET /api/orgs/3': () => json({ id: 3, name: 'beta-tenant' }),
      'PUT /api/orgs/3': ok,
    });

    await service.retireOrg(3, '[deleted] beta-tenant');

    expect(calls).toEqual([
      'GET /api/orgs/3/users',
      'DELETE /api/orgs/3/users/9',
      'GET /api/datasources @3',
      'DELETE /api/datasources/uid/opensearch @3',
      'DELETE /api/datasources/uid/victoriametrics @3',
      'GET /api/search?type=dash-db&limit=5000 @3',
      'DELETE /api/dashboards/uid/mtco-host-overview @3',
      'DELETE /api/dashboards/uid/gone @3',
      'GET /api/folders?limit=1000 @3',
      'DELETE /api/folders/f1?forceDeleteRules=true @3',
      'GET /api/orgs/3',
      'PUT /api/orgs/3',
    ]);
  });

  it('is idempotent on an already retired org', async () => {
    const { service, calls } = setup({
      'GET /api/orgs/3/users': () => json([{ userId: 1, login: 'admin' }]),
      'GET /api/datasources': () => json([]),
      'GET /api/search?type=dash-db&limit=5000': () => json([]),
      'GET /api/folders?limit=1000': () => json([]),
      'GET /api/orgs/3': () => json({ id: 3, name: '[deleted] beta-tenant' }),
    });

    await service.retireOrg(3, '[deleted] beta-tenant');

    expect(calls).not.toContain('PUT /api/orgs/3');
  });
});
