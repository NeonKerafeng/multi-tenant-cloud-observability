import { MetricsService } from '../../common/metrics/metrics.service';
import { AppConfig } from '../../config/app-config';

import { KeycloakClient } from './keycloak.client';

describe('KeycloakClient admin token', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  function setup() {
    const calls: string[] = [];

    global.fetch = jest.fn((url: URL, init: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${String(init.method)} ${path}`);

      if (path.endsWith('/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'tok', expires_in: 300 }),
            { status: 200 },
          ),
        );
      }

      return Promise.resolve(new Response('[]', { status: 200 }));
    });

    return {
      client: new KeycloakClient(AppConfig.forTest(), new MetricsService()),
      calls,
    };
  }

  it('fetches one token for concurrent calls and reuses it', async () => {
    const { client, calls } = setup();

    await Promise.all([
      client.getUserGroups('u1'),
      client.getUserGroups('u2'),
      client.getUserRealmRoles('u3'),
    ]);
    await client.getUserGroups('u4');

    expect(calls.filter((c) => c.endsWith('/token'))).toHaveLength(1);
    expect(
      calls.filter((c) => c.includes('/admin/realms/observability/users/')),
    ).toHaveLength(4);
  });

  it('finds users by exact username, case-insensitively', async () => {
    const { client } = setup();

    global.fetch = jest.fn((url: URL) =>
      Promise.resolve(
        String(url).includes('/token')
          ? new Response(JSON.stringify({ access_token: 't', expires_in: 300 }))
          : new Response(
              JSON.stringify([
                { id: '1', username: 'alice2' },
                { id: '2', username: 'alice' },
              ]),
            ),
      ),
    );

    await expect(client.findUserByUsername('Alice')).resolves.toMatchObject({
      id: '2',
    });
  });
});
