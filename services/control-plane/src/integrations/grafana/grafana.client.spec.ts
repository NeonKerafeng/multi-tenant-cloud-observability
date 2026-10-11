import { MetricsService } from '../../common/metrics/metrics.service';
import { AppConfig } from '../../config/app-config';

import { GrafanaClient } from './grafana.client';

type Route = () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(routes: Record<string, Route>) {
  const calls: string[] = [];

  global.fetch = jest.fn((url: URL, init: RequestInit) => {
    const parsed = new URL(String(url));
    const key = `${String(init.method)} ${parsed.pathname}${parsed.search}`;
    const headers = init.headers as Record<string, string>;
    const org = headers['X-Grafana-Org-Id'];

    calls.push(org ? `${key} @${org}` : key);

    const route = routes[key];

    return Promise.resolve(route ? route() : json({}, 404));
  });

  return {
    client: new GrafanaClient(AppConfig.forTest(), new MetricsService()),
    calls,
  };
}

describe('GrafanaClient.deleteOrg', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it.each([
    [200, 'deleted'],
    [404, 'deleted'],
    [500, 'refused'],
  ])('status %i -> %s', async (status, expected) => {
    const { client } = setup({
      'DELETE /api/orgs/3': () => json({ message: 'x' }, status),
    });

    await expect(client.deleteOrg(3)).resolves.toBe(expected);
  });

  it('throws on other errors', async () => {
    const { client } = setup({
      'DELETE /api/orgs/3': () => json({ message: 'no' }, 403),
    });

    await expect(client.deleteOrg(3)).rejects.toThrow(/403/);
  });
});

describe('GrafanaClient.retireOrg', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('removes members (not the server admin), datasources, dashboards, folders, then renames', async () => {
    const ok = () => json({ message: 'ok' });

    const { client, calls } = setup({
      'GET /api/orgs/3/users': () =>
        json([
          { userId: 1, login: 'admin' },
          { userId: 9, login: 'root-admin' },
        ]),
      'DELETE /api/orgs/3/users/9': ok,
      'GET /api/datasources': () =>
        json([{ uid: 'opensearch' }, { uid: 'victoriametrics' }]),
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

    await client.retireOrg(3, '[deleted] beta-tenant');

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
    const { client, calls } = setup({
      'GET /api/orgs/3/users': () => json([{ userId: 1, login: 'admin' }]),
      'GET /api/datasources': () => json([]),
      'GET /api/search?type=dash-db&limit=5000': () => json([]),
      'GET /api/folders?limit=1000': () => json([]),
      'GET /api/orgs/3': () => json({ id: 3, name: '[deleted] beta-tenant' }),
    });

    await client.retireOrg(3, '[deleted] beta-tenant');

    expect(calls).not.toContain('PUT /api/orgs/3');
  });
});

describe('GrafanaClient.ensureDashboard', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('creates only when missing and tolerates a concurrent create (412)', async () => {
    const created = setup({
      'POST /api/dashboards/db': () => json({ status: 'success' }),
    });
    await expect(
      created.client.ensureDashboard(7, { uid: 'd', title: 'D' }),
    ).resolves.toBe(true);

    const existing = setup({
      'GET /api/dashboards/uid/d': () => json({ dashboard: {} }),
    });
    await expect(
      existing.client.ensureDashboard(7, { uid: 'd', title: 'D' }),
    ).resolves.toBe(false);

    const raced = setup({ 'POST /api/dashboards/db': () => json({}, 412) });
    await expect(
      raced.client.ensureDashboard(7, { uid: 'd', title: 'D' }),
    ).resolves.toBe(false);
  });
});
