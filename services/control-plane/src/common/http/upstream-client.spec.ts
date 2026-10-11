import { AppConfig } from '../../config/app-config';
import {
  UpstreamBadResponseError,
  UpstreamUnavailableError,
} from '../errors/upstream-error';
import { MetricsService } from '../metrics/metrics.service';

import { UpstreamClient } from './upstream-client';

class TestClient extends UpstreamClient {
  protected readonly service = 'grafana' as const;
  refreshes = 0;

  protected baseUrl(): string {
    return 'http://upstream';
  }

  protected authHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ Authorization: `Bearer t${this.refreshes}` });
  }

  protected onUnauthorized(): boolean {
    this.refreshes += 1;
    return true;
  }
}

type Reply = number | Error;

function setup(replies: Reply[]) {
  const calls: { url: string; method: string; auth: string | undefined }[] = [];

  global.fetch = jest.fn((url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url: String(url),
      method: String(init.method),
      auth: headers.Authorization,
    });

    const reply = replies.shift() ?? 200;

    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(
          new Response(reply === 204 ? null : '{"ok":true}', { status: reply }),
        );
  });

  const client = new TestClient(AppConfig.forTest(), new MetricsService());

  return { client, calls };
}

describe('UpstreamClient', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('builds the URL with query parameters', async () => {
    const { client, calls } = setup([200]);

    await client.request({
      method: 'GET',
      path: '/api/x',
      query: { a: 'b c', skip: undefined },
    });

    expect(calls[0].url).toBe('http://upstream/api/x?a=b+c');
  });

  it('retries a GET on 503 and network errors, then succeeds', async () => {
    const { client, calls } = setup([503, new TypeError('fetch failed'), 200]);

    await expect(client.json({ method: 'GET', path: '/a' })).resolves.toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(3);
  });

  it('never retries a POST', async () => {
    const { client, calls } = setup([503]);

    await expect(
      client.request({ method: 'POST', path: '/a', body: {} }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it('network failure → 503-class error', async () => {
    const { client } = setup([
      new TypeError('ECONNREFUSED'),
      new TypeError('x'),
      new TypeError('y'),
    ]);

    await expect(
      client.request({ method: 'GET', path: '/a' }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('unexpected status → 502-class error; accepted statuses are returned', async () => {
    const { client } = setup([400, 404]);

    await expect(
      client.request({ method: 'PUT', path: '/a', body: {} }),
    ).rejects.toBeInstanceOf(UpstreamBadResponseError);

    const response = await client.request({
      method: 'GET',
      path: '/a',
      accept: [404],
    });
    expect(response.status).toBe(404);
  });

  it('refreshes credentials once on 401', async () => {
    const { client, calls } = setup([401, 200]);

    await client.request({ method: 'POST', path: '/a' });

    expect(calls.map((c) => c.auth)).toEqual(['Bearer t0', 'Bearer t1']);
  });

  it('gives up after a second 401', async () => {
    const { client } = setup([401, 401]);

    await expect(
      client.request({ method: 'GET', path: '/a' }),
    ).rejects.toBeInstanceOf(UpstreamBadResponseError);
  });
});
