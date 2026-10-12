/**
 * HTTP-level tests of the real controllers, guards, filter, pipe, prefix
 * and OpenAPI document (configureApp = production setup). Services and
 * repositories are mocks: their logic has its own specs.
 */
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  SchemaObject,
} from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

import type { Server } from 'node:http';
import request from 'supertest';

import { API_PREFIX, configureApp, UNPREFIXED_ROUTES } from './app.setup';
import { AuthGuard } from './common/auth/auth.guard';
import { JwtVerifier } from './common/auth/jwt-verifier';
import { DatabaseService } from './common/db/database.service';
import { ErrorFilter } from './common/errors/error.filter';
import { MetricsService } from './common/metrics/metrics.service';
import { agent, IDS, tenant, user } from './common/testing/fixtures';
import { ALL_CONTROLLERS, routeInventory } from './common/testing/routes';
import { AgentsService } from './modules/agents/agents.service';
import { toAgentView } from './modules/agents/views';
import { EnrollmentsService } from './modules/enrollments/enrollments.service';
import { SupportAccessRepository } from './modules/support-access/support-access.repository';
import { SupportAccessService } from './modules/support-access/support-access.service';
import { TenantRepository } from './modules/tenants/tenant.repository';
import { TenantsService } from './modules/tenants/tenants.service';
import { toTenantView } from './modules/tenants/views';
import { UserRepository } from './modules/users/user.repository';
import { UsersService } from './modules/users/users.service';
import { toUserView } from './modules/users/views';
import { OutboxRepository } from './sync/outbox.repository';
import { ResyncService } from './sync/resync.service';

const alpha = tenant();
const beta = tenant({
  id: IDS.beta,
  tenantKey: 'beta-tenant',
  grafanaOrgId: 8,
});

/** Callers; the bearer token is the key. */
const PEOPLE = {
  root: user({
    id: IDS.platformAdmin,
    keycloakUserId: 'kc-root',
    username: 'root-admin',
    role: 'platform-admin',
    tenantId: null,
    tenantKey: null,
  }),
  alphaAdmin: user({
    id: IDS.alphaAdmin,
    keycloakUserId: 'kc-alpha-admin',
    username: 'alpha-admin',
    role: 'tenant-admin',
  }),
  viewer: user(),
  disabled: user({
    id: IDS.betaAdmin,
    keycloakUserId: 'kc-disabled',
    enabled: false,
  }),
};

type Who = keyof typeof PEOPLE;
type Method = 'get' | 'post' | 'patch' | 'delete';

const USER_ID = IDS.alphaViewer;
const AGENT_ID = IDS.agent;
const GRANT_ID = '11111111-2222-4333-8444-555555555555';

const mocks = {
  verifier: {
    verify: jest.fn((token: string) =>
      token in PEOPLE
        ? Promise.resolve({ sub: PEOPLE[token as Who].keycloakUserId })
        : Promise.reject(new Error('bad token')),
    ),
  },
  userRepo: {
    findActiveByKeycloakId: jest.fn((sub: string) =>
      Promise.resolve(
        Object.values(PEOPLE).find((p) => p.keycloakUserId === sub) ?? null,
      ),
    ),
  },
  tenantRepo: {
    findByKey: jest.fn((key: string) =>
      Promise.resolve([alpha, beta].find((t) => t.tenantKey === key) ?? null),
    ),
  },
  tenants: {
    list: jest.fn().mockResolvedValue([toTenantView(alpha)]),
    get: jest.fn((_actor: unknown, t: typeof alpha) => toTenantView(t)),
    create: jest.fn((_actor: unknown, tenantKey: string) =>
      Promise.resolve(toTenantView(tenant({ tenantKey, grafanaOrgId: null }))),
    ),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  users: {
    me: jest.fn().mockResolvedValue(toUserView(PEOPLE.viewer)),
    list: jest.fn().mockResolvedValue([toUserView(PEOPLE.viewer)]),
    get: jest.fn().mockResolvedValue(toUserView(PEOPLE.viewer)),
    create: jest.fn().mockResolvedValue(toUserView(PEOPLE.viewer)),
    update: jest.fn().mockResolvedValue(toUserView(PEOPLE.viewer)),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  agents: {
    list: jest.fn().mockResolvedValue([toAgentView(agent())]),
    get: jest.fn().mockResolvedValue(toAgentView(agent())),
    update: jest.fn().mockResolvedValue(toAgentView(agent())),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  enrollments: {
    create: jest.fn(() => ({
      enrollmentToken: 'enroll-token',
      expiresAt: '2026-10-11T12:00:00.000Z',
    })),
    exchange: jest.fn().mockResolvedValue({
      agentId: AGENT_ID,
      clientId: `otel-agent-${AGENT_ID}`,
      tenantKey: 'alpha-tenant',
      clientSecret: 's3cret',
      tokenUrl: 'http://kc/realms/observability/protocol/openid-connect/token',
      gatewayEndpoint: 'http://otel:4318',
    }),
  },
  supportAccess: {
    grant: jest.fn().mockResolvedValue({ id: GRANT_ID }),
    listForTenant: jest.fn().mockResolvedValue([]),
    listAll: jest.fn().mockResolvedValue([]),
    revoke: jest.fn().mockResolvedValue({ id: GRANT_ID }),
  },
  supportAccessRepo: { countActive: jest.fn().mockResolvedValue(0) },
  outbox: {
    status: jest.fn().mockResolvedValue({
      targets: {
        keycloak: { pending: 0, failing: 0, oldestPendingSeconds: 0 },
        grafana: { pending: 0, failing: 0, oldestPendingSeconds: 0 },
      },
      recentErrors: [],
    }),
  },
  resync: {
    run: jest
      .fn()
      .mockResolvedValue({ tenantsQueued: 1, usersQueued: 2, agentsQueued: 0 }),
  },
  db: { ping: jest.fn().mockResolvedValue(undefined) },
};

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: ALL_CONTROLLERS,
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ErrorFilter },
      MetricsService,
      { provide: JwtVerifier, useValue: mocks.verifier },
      { provide: UserRepository, useValue: mocks.userRepo },
      { provide: TenantRepository, useValue: mocks.tenantRepo },
      { provide: TenantsService, useValue: mocks.tenants },
      { provide: UsersService, useValue: mocks.users },
      { provide: AgentsService, useValue: mocks.agents },
      { provide: EnrollmentsService, useValue: mocks.enrollments },
      { provide: SupportAccessService, useValue: mocks.supportAccess },
      { provide: SupportAccessRepository, useValue: mocks.supportAccessRepo },
      { provide: OutboxRepository, useValue: mocks.outbox },
      { provide: ResyncService, useValue: mocks.resync },
      { provide: DatabaseService, useValue: mocks.db },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

function call(
  method: Method,
  path: string,
  who?: Who,
  body?: object,
): request.Test {
  const test = request(app.getHttpServer() as Server)[method](path);

  if (who) {
    void test.set('Authorization', `Bearer ${who}`);
  }

  if (body !== undefined) {
    void test.send(body);
  }

  return test;
}

const api = (path: string): string => `/${API_PREFIX}${path}`;

function errorCode(res: request.Response): unknown {
  return (res.body as { error?: { code?: unknown } }).error?.code;
}

describe('prefix and unprefixed routes', () => {
  it('probes and metrics stay at the root', async () => {
    await call('get', '/healthz').expect(200, { status: 'ok' });
    await call('get', '/readyz').expect(200, { status: 'ok' });

    const metrics = await call('get', '/metrics').expect(200);

    expect(metrics.text).toContain('mtco_outbox_pending_events');
  });

  it.each([
    ['get', '/tenants'],
    ['post', '/agent-enrollments/exchange'],
    ['post', '/agents'],
    ['get', '/sync/status'],
    ['get', '/api/v1/healthz'],
    ['post', '/api/v1/tenants/alpha-tenant/agents'],
    ['post', '/api/v1/tenants/alpha-tenant/users/x/disable'],
  ] as [Method, string][])(
    'old or unknown route %s %s → 404 route_not_found',
    async (method, path) => {
      const res = await call(method, path, 'root').expect(404);

      expect(res.body).toMatchObject({
        error: { code: 'route_not_found' },
        requestId: expect.any(String) as string,
      });
    },
  );

  it('every response carries X-Request-Id', async () => {
    const res = await call('get', api('/me'), 'viewer').expect(200);

    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });
});

describe('authentication and authorization', () => {
  it('no or bad token → 401 unauthenticated', async () => {
    expect(errorCode(await call('get', api('/me')).expect(401))).toBe(
      'unauthenticated',
    );
    expect(
      errorCode(
        await request(app.getHttpServer() as Server)
          .get(api('/me'))
          .set('Authorization', 'Bearer nope')
          .expect(401),
      ),
    ).toBe('unauthenticated');
  });

  it('disabled account → 403 account_disabled (even GET /me)', async () => {
    expect(
      errorCode(await call('get', api('/me'), 'disabled').expect(403)),
    ).toBe('account_disabled');
  });

  it('GET /me works for every role and returns the caller', async () => {
    for (const who of ['root', 'alphaAdmin', 'viewer'] as Who[]) {
      await call('get', api('/me'), who).expect(200);
    }

    expect(mocks.users.me).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: PEOPLE.viewer.id, role: 'viewer' }),
    );
  });

  it('viewer → 403 forbidden on management routes', async () => {
    expect(
      errorCode(
        await call('get', api('/tenants/alpha-tenant/users'), 'viewer').expect(
          403,
        ),
      ),
    ).toBe('forbidden');
  });

  it('tenant admin: own tenant 200, another 403, unknown 404', async () => {
    await call('get', api('/tenants/alpha-tenant'), 'alphaAdmin').expect(200);
    expect(
      errorCode(
        await call('get', api('/tenants/beta-tenant'), 'alphaAdmin').expect(
          403,
        ),
      ),
    ).toBe('forbidden');
    expect(
      errorCode(
        await call('get', api('/tenants/nope'), 'alphaAdmin').expect(404),
      ),
    ).toBe('tenant_not_found');
  });

  it('tenant admin may not list tenants, platform admin may', async () => {
    await call('get', api('/tenants'), 'alphaAdmin').expect(403);

    const res = await call('get', api('/tenants'), 'root').expect(200);

    expect(res.body).toMatchObject({ items: [{ tenantKey: 'alpha-tenant' }] });
  });
});

describe('tenants', () => {
  it('POST {tenantKey} → 201', async () => {
    const res = await call('post', api('/tenants'), 'root', {
      tenantKey: 'gamma-tenant',
    }).expect(201);

    expect(res.body).toMatchObject({
      tenantKey: 'gamma-tenant',
      grafanaOrgId: null,
    });
    expect(mocks.tenants.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'root-admin' }),
      'gamma-tenant',
    );
  });

  it('the v0.7 body {tenantId} is rejected (400 validation_failed)', async () => {
    const res = await call('post', api('/tenants'), 'root', {
      tenantId: 'gamma-tenant',
    }).expect(400);

    expect(res.body).toMatchObject({
      error: {
        code: 'validation_failed',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'tenantId' }),
          expect.objectContaining({ field: 'tenantKey' }),
        ]) as unknown,
      },
    });
    expect(mocks.tenants.create).not.toHaveBeenCalled();
  });

  it('DELETE → 204 without body', async () => {
    const res = await call(
      'delete',
      api('/tenants/beta-tenant'),
      'root',
    ).expect(204);

    expect(res.text).toBe('');
    expect(mocks.tenants.delete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantKey: 'beta-tenant' }),
    );
  });
});

describe('users', () => {
  const base = api('/tenants/alpha-tenant/users');

  it('list / get / create', async () => {
    await call('get', base, 'alphaAdmin').expect(200);
    await call('get', `${base}/${USER_ID}`, 'alphaAdmin').expect(200);
    await call('post', base, 'alphaAdmin', {
      username: 'New-Viewer',
      password: 'a-long-password',
      firstName: 'New',
      lastName: 'Viewer',
      email: 'New@Example.com',
      role: 'viewer',
    }).expect(201);

    expect(mocks.users.get).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantKey: 'alpha-tenant' }),
      USER_ID,
    );
    expect(mocks.users.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        username: 'new-viewer',
        email: 'new@example.com',
      }),
    );
  });

  it('PATCH {enabled} → 200; a non-boolean or unknown field → 400', async () => {
    await call('patch', `${base}/${USER_ID}`, 'alphaAdmin', {
      enabled: false,
    }).expect(200);

    expect(mocks.users.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      USER_ID,
      { enabled: false },
    );

    await call('patch', `${base}/${USER_ID}`, 'alphaAdmin', {
      enabled: 'no',
    }).expect(400);
    await call('patch', `${base}/${USER_ID}`, 'alphaAdmin', {
      role: 'tenant-admin',
    }).expect(400);
    expect(mocks.users.update).toHaveBeenCalledTimes(1);
  });

  it('DELETE → 204', async () => {
    await call('delete', `${base}/${USER_ID}`, 'alphaAdmin').expect(204);
    expect(mocks.users.delete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      USER_ID,
    );
  });
});

describe('agents', () => {
  const base = api('/tenants/alpha-tenant/agents');

  it('list / get / PATCH / DELETE 204', async () => {
    await call('get', base, 'alphaAdmin').expect(200);
    await call('get', `${base}/${AGENT_ID}`, 'alphaAdmin').expect(200);
    await call('patch', `${base}/${AGENT_ID}`, 'alphaAdmin', {
      enabled: false,
    }).expect(200);
    await call('delete', `${base}/${AGENT_ID}`, 'alphaAdmin').expect(204);

    expect(mocks.agents.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantKey: 'alpha-tenant' }),
      AGENT_ID,
      { enabled: false },
    );
  });

  it('another tenant is forbidden before any agent lookup', async () => {
    await call(
      'get',
      api(`/tenants/beta-tenant/agents/${AGENT_ID}`),
      'alphaAdmin',
    ).expect(403);
    expect(mocks.agents.get).not.toHaveBeenCalled();
  });
});

describe('agent enrollments', () => {
  it('platform admins can create one for any tenant (I-22a)', async () => {
    const res = await call(
      'post',
      api('/tenants/beta-tenant/agent-enrollments'),
      'root',
    ).expect(201);

    expect(res.body).toEqual({
      enrollmentToken: 'enroll-token',
      expiresAt: '2026-10-11T12:00:00.000Z',
    });
    expect(mocks.enrollments.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantKey: 'beta-tenant' }),
    );
  });

  it('exchange is public, body {token} (FROZEN, client/bootstrap.sh)', async () => {
    const res = await call(
      'post',
      api('/agent-enrollments/exchange'),
      undefined,
      {
        token: 'enroll-token',
      },
    ).expect(201);

    expect(Object.keys(res.body as object)).toEqual(
      expect.arrayContaining([
        'agentId',
        'clientId',
        'clientSecret',
        'tokenUrl',
        'gatewayEndpoint',
      ]),
    );
    expect(mocks.enrollments.exchange).toHaveBeenCalledWith('enroll-token');

    await call('post', api('/agent-enrollments/exchange'), undefined, {
      enrollmentToken: 'enroll-token',
    }).expect(400);
  });
});

describe('support access', () => {
  const base = api('/tenants/alpha-tenant/support-access');

  it('grant 201, list ?active, revoke 204, list all', async () => {
    await call('post', base, 'root', {
      reason: 'TICKET-1 check dashboards',
    }).expect(201);
    await call('get', `${base}?active=true`, 'alphaAdmin').expect(200);
    await call('delete', `${base}/${GRANT_ID}`, 'root').expect(204);
    await call('get', api('/support-access'), 'root').expect(200);

    expect(mocks.supportAccess.listForTenant).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
    );
    expect(mocks.supportAccess.listAll).toHaveBeenCalledWith(
      expect.anything(),
      false,
    );
    expect(mocks.supportAccess.revoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      GRANT_ID,
    );
  });

  it('tenant admins may only list; bad ?active → 400', async () => {
    await call('post', base, 'alphaAdmin', {
      reason: 'TICKET-1 check dashboards',
    }).expect(403);
    await call('get', `${base}?active=maybe`, 'alphaAdmin').expect(400);
  });
});

describe('admin sync', () => {
  it('status 200 and resync 202 for platform admins only', async () => {
    await call('get', api('/admin/sync/status'), 'root').expect(200);

    const res = await call('post', api('/admin/sync/resync'), 'root').expect(
      202,
    );

    expect(res.body).toEqual({
      tenantsQueued: 1,
      usersQueued: 2,
      agentsQueued: 0,
    });
    await call('get', api('/admin/sync/status'), 'alphaAdmin').expect(403);
  });
});

describe('OpenAPI document', () => {
  const HTTP_METHODS = ['get', 'post', 'patch', 'delete'] as const;

  async function document(): Promise<OpenAPIObject> {
    return (await call('get', '/api/docs-json').expect(200))
      .body as OpenAPIObject;
  }

  function docPath(path: string): string {
    return `/${API_PREFIX}${path.replace(/:(\w+)/g, '{$1}')}`;
  }

  const apiRoutes = routeInventory().filter(
    (r) => !UNPREFIXED_ROUTES.includes(r.path.slice(1)),
  );

  it('lists exactly the /api/v1 routes (no probes, no metrics)', async () => {
    const doc = await document();
    const documented = Object.entries(doc.paths).flatMap(([path, item]) =>
      HTTP_METHODS.filter((m) => item[m]).map(
        (m) => `${m.toUpperCase()} ${path}`,
      ),
    );

    expect(documented.sort()).toEqual(
      apiRoutes.map((r) => `${r.method} ${docPath(r.path)}`).sort(),
    );
  });

  it('each operation: bearer iff not public, its path params once, one success response, the error envelope', async () => {
    const doc = await document();

    for (const route of apiRoutes) {
      const item = doc.paths[docPath(route.path)];
      const operation = item[
        route.method.toLowerCase() as (typeof HTTP_METHODS)[number]
      ] as OperationObject;
      const label = `${route.method} ${route.path}`;

      expect([label, operation.security ?? []]).toEqual([
        label,
        route.access === 'public' ? [] : [{ bearer: [] }],
      ]);

      const names = (operation.parameters ?? []).map(
        (p) => (p as ParameterObject).name,
      );
      const pathParams = (route.path.match(/:(\w+)/g) ?? []).map((p) =>
        p.slice(1),
      );

      expect([label, [...new Set(names)].length]).toEqual([
        label,
        names.length,
      ]);
      expect([label, names]).toEqual([
        label,
        expect.arrayContaining(pathParams),
      ]);

      const success = Object.keys(operation.responses).filter((code) =>
        code.startsWith('2'),
      );

      expect([label, success.length]).toEqual([label, 1]);
      expect([label, operation.responses.default]).toEqual([
        label,
        expect.objectContaining({ description: 'Error' }),
      ]);
    }
  });

  it('documents the views and DTOs field by field', async () => {
    const schemas = (await document()).components?.schemas as Record<
      string,
      SchemaObject
    >;
    const fields = (name: string) =>
      Object.keys(schemas[name]?.properties ?? {}).sort();

    expect(fields('UserView')).toEqual(
      Object.keys(toUserView(PEOPLE.viewer)).sort(),
    );
    expect(fields('TenantView')).toEqual(
      Object.keys(toTenantView(alpha)).sort(),
    );
    expect(fields('AgentView')).toEqual(
      Object.keys(toAgentView(agent())).sort(),
    );
    expect(fields('TenantList')).toEqual(['items']);
    expect(fields('ErrorResponse')).toEqual(['error', 'requestId']);
    expect(fields('CreateTenantDto')).toEqual(['tenantKey']);
    expect(fields('ExchangeDto')).toEqual(['token']);
    expect(fields('UpdateUserDto')).toEqual(['enabled']);
    expect(schemas.CreateUserDto.properties?.password).toMatchObject({
      writeOnly: true,
    });
  });

  it('serves Swagger UI', async () => {
    const res = await call('get', '/api/docs').expect(200);

    expect(res.text).toContain('swagger');
  });
});
