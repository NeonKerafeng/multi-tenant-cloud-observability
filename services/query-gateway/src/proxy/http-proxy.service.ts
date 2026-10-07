import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import type { AxiosResponse } from 'axios';
import type { Request, Response } from 'express';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { firstValueFrom } from 'rxjs';

/**
 * Response headers copied from the storage backend to the client.
 * content-encoding is passed through together with the still-compressed
 * body (decompress: false), so gzip responses are never inflated here.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'vary',
];

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Streaming reverse proxy.
 *
 * - The request body is already fully parsed (it must be inspected and,
 *   for OpenSearch, rewritten with the tenant filter), so it is sent as-is.
 * - The response is NOT buffered: bytes are piped to the client as soon as
 *   the backend produces them. Gateway memory no longer grows with the
 *   response size.
 * - Connections to backends are reused (keep-alive).
 * - If the client disconnects, the backend request is aborted.
 */
@Injectable()
export class HttpProxyService {
  private readonly logger = new Logger(HttpProxyService.name);

  private readonly httpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: 100,
  });

  private readonly httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 100,
  });

  private readonly timeoutMs =
    Number(process.env.PROXY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  constructor(private readonly http: HttpService) {}

  async forward(
    baseUrl: string,
    prefix: string,
    req: Request,
    res: Response,
    extraHeaders: Record<string, string> = {},
    pathOverride?: string,
  ): Promise<void> {
    const downstreamPath = pathOverride ?? req.originalUrl.replace(prefix, '');

    const url = `${baseUrl}${downstreamPath}`;

    const abort = new AbortController();

    const onClientClose = (): void => {
      if (!res.writableFinished) {
        abort.abort();
      }
    };

    res.on('close', onClientClose);

    try {
      let upstream: AxiosResponse<Readable>;

      try {
        upstream = await firstValueFrom(
          this.http.request<Readable>({
            method: req.method,
            url,
            data: req.body as unknown,
            headers: {
              ...this.forwardHeaders(req),
              ...extraHeaders,
            },
            responseType: 'stream',
            decompress: false,
            validateStatus: () => true,
            signal: abort.signal,
            timeout: this.timeoutMs,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
          }),
        );
      } catch (error) {
        // Client disconnected before the backend answered: nothing to send.
        if (abort.signal.aborted) {
          return;
        }

        throw error;
      }

      res.status(upstream.status);

      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value: unknown = upstream.headers[name];

        if (typeof value === 'string' || typeof value === 'number') {
          res.setHeader(name, String(value));
        }
      }

      try {
        await pipeline(upstream.data, res);
      } catch (error) {
        // Client went away mid-stream: expected, nothing to report.
        if (!abort.signal.aborted) {
          this.logger.warn(
            `Stream from ${baseUrl} interrupted: ${String(error)}`,
          );
        }
      }
    } finally {
      res.off('close', onClientClose);
    }
  }

  private forwardHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const name of ['content-type', 'accept', 'accept-encoding']) {
      const value = req.headers[name];

      if (typeof value === 'string') {
        headers[name] = value;
      }
    }

    return headers;
  }
}
