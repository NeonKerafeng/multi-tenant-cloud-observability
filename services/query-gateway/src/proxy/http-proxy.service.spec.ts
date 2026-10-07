import axios from 'axios';
import express from 'express';
import { once } from 'node:events';
import {
  createServer,
  get,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { from } from 'rxjs';
import request from 'supertest';

/*
 * @nestjs/axios is ESM-only and cannot be required by Jest (CommonJS).
 * HttpService is only a thin Observable wrapper around axios, so the test
 * provides an equivalent object backed by the real axios instance.
 */
jest.mock('@nestjs/axios', () => ({ HttpService: class {} }));

import type { HttpService } from '@nestjs/axios';

import { HttpProxyService } from './http-proxy.service';

const fakeHttpService = {
  request: (config: Parameters<typeof axios.request>[0]) =>
    from(axios.request(config)),
} as unknown as HttpService;

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('HttpProxyService (streaming)', () => {
  let upstream: Server;
  let upstreamUrl: string;
  let proxy: Server;
  let proxyUrl: string;

  let upstreamRequestClosed: Promise<void>;
  let lastUpstreamBody = '';

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));

      req.on('end', () => {
        lastUpstreamBody = body;

        if (req.url === '/gzip') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          });
          res.end(gzipSync(JSON.stringify({ ok: true })));
          return;
        }

        if (req.url === '/missing') {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('nope');
          return;
        }

        if (req.url === '/slow') {
          upstreamRequestClosed = new Promise((resolve) =>
            res.on('close', () => resolve()),
          );
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('first-chunk');
          // Never ends on its own: only a client abort can close it.
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: req.url, method: req.method }));
      });
    });

    upstreamUrl = await listen(upstream);

    const service = new HttpProxyService(fakeHttpService);

    const app = express();
    app.use(express.json());
    app.all('/proxy/*path', (req, res, next) => {
      service.forward(upstreamUrl, '/proxy', req, res).catch(next);
    });

    proxy = createServer(app);
    proxyUrl = await listen(proxy);
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    proxy.closeAllConnections();
    upstream.close();
    proxy.close();
    await Promise.all([once(upstream, 'close'), once(proxy, 'close')]);
  });

  it('forwards path, method, status and body', async () => {
    const res = await request(proxyUrl)
      .post('/proxy/a/b?x=1')
      .send({ hello: 'world' })
      .expect(200);

    expect(res.body).toEqual({ path: '/a/b?x=1', method: 'POST' });
    expect(JSON.parse(lastUpstreamBody)).toEqual({ hello: 'world' });
  });

  it('passes backend error statuses through', async () => {
    const res = await request(proxyUrl).get('/proxy/missing').expect(404);
    expect(res.text).toBe('nope');
  });

  it('passes gzip responses through without decompressing', async () => {
    const raw: IncomingMessage = await new Promise((resolve) =>
      get(`${proxyUrl}/proxy/gzip`, resolve),
    );

    expect(raw.headers['content-encoding']).toBe('gzip');

    const chunks: Buffer[] = [];
    for await (const chunk of raw) chunks.push(chunk as Buffer);

    expect(JSON.parse(gunzipSync(Buffer.concat(chunks)).toString())).toEqual({
      ok: true,
    });
  });

  it('streams the first bytes before the backend finishes, and aborts the backend when the client disconnects', async () => {
    const raw: IncomingMessage = await new Promise((resolve) =>
      get(`${proxyUrl}/proxy/slow`, resolve),
    );

    // Upstream has NOT finished, yet the first chunk is already here.
    const [firstChunk] = (await once(raw, 'data')) as [Buffer];
    expect(firstChunk.toString()).toBe('first-chunk');

    raw.destroy();

    await expect(
      Promise.race([
        upstreamRequestClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('backend not aborted')), 3000),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});
