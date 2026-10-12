import { Logger } from '@nestjs/common';

import { AppConfig } from '../../config/app-config';
import {
  UpstreamBadResponseError,
  type UpstreamService,
  UpstreamUnavailableError,
} from '../errors/upstream-error';
import { MetricsService } from '../metrics/metrics.service';

export interface UpstreamRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. */
  body?: unknown;
  /** application/x-www-form-urlencoded body (token requests). */
  form?: URLSearchParams;
  headers?: Record<string, string>;
  /** Non-2xx statuses the caller handles itself (e.g. 404, 409). */
  accept?: number[];
  /** false = do not add authentication headers (token endpoint). */
  auth?: boolean;
}

const RETRY_DELAYS_MS = [200, 600];
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Parent of every outbound HTTP client (Keycloak, Grafana): timeout,
 * retry for idempotent GETs only, one 401 refresh hook, error mapping to
 * UpstreamError (→ 502/503 for API clients), latency histogram.
 * Bodies are never logged (they can carry secrets).
 */
export abstract class UpstreamClient {
  protected abstract readonly service: UpstreamService;

  protected readonly logger: Logger;

  constructor(
    protected readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {
    this.logger = new Logger(new.target.name);
  }

  protected abstract baseUrl(): string;

  protected abstract authHeaders(): Promise<Record<string, string>>;

  /**
   * Called once when the upstream answers 401; return true to retry
   * (e.g. after dropping a cached token).
   */
  protected onUnauthorized(): boolean {
    return false;
  }

  /**
   * Sends the request. Resolves with the Response when the status is 2xx
   * or listed in `accept`; otherwise throws an UpstreamError.
   */
  async request(req: UpstreamRequest): Promise<Response> {
    let refreshed = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;

      try {
        response = await this.send(req);
      } catch (error) {
        if (this.canRetry(req, attempt)) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }

        throw new UpstreamUnavailableError(
          this.service,
          null,
          `${req.method} ${req.path}: ${describe(error)}`,
        );
      }

      if (response.ok || req.accept?.includes(response.status)) {
        return response;
      }

      if (
        response.status === 401 &&
        req.auth !== false &&
        !refreshed &&
        this.onUnauthorized()
      ) {
        refreshed = true;
        await discard(response);
        continue;
      }

      if (UNAVAILABLE_STATUSES.has(response.status)) {
        if (this.canRetry(req, attempt)) {
          await discard(response);
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }

        throw new UpstreamUnavailableError(
          this.service,
          response.status,
          `${req.method} ${req.path} -> ${response.status}${await excerpt(response)}`,
        );
      }

      throw new UpstreamBadResponseError(
        this.service,
        response.status,
        `${req.method} ${req.path} -> ${response.status}${await excerpt(response)}`,
      );
    }
  }

  /** request() + JSON body. */
  async json<T>(req: UpstreamRequest): Promise<T> {
    const response = await this.request(req);

    return (await response.json()) as T;
  }

  /** Id from the Location header of a 201 Created. */
  protected locationId(response: Response, what: string): string {
    const id = response.headers.get('location')?.split('/').pop();

    if (!id) {
      throw new UpstreamBadResponseError(
        this.service,
        response.status,
        `${what}: no Location header in the response`,
      );
    }

    return id;
  }

  private canRetry(req: UpstreamRequest, attempt: number): boolean {
    return req.method === 'GET' && attempt < RETRY_DELAYS_MS.length;
  }

  private async send(req: UpstreamRequest): Promise<Response> {
    const url = new URL(`${this.baseUrl()}${req.path}`);

    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(req.auth === false ? {} : await this.authHeaders()),
      ...req.headers,
    };

    let body: string | URLSearchParams | undefined;

    if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = req.form;
    } else if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    const started = process.hrtime.bigint();
    let outcome = 'network_error';

    try {
      const response = await fetch(url, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
      });

      // `expected_<status>`: a non-2xx the caller handles as a normal
      // answer (404 on a lookup, 409 on create, Grafana's 500 on org
      // delete); `http_<status>`: a real failure (F-b).
      outcome = response.ok
        ? 'ok'
        : req.accept?.includes(response.status)
          ? `expected_${response.status}`
          : `http_${response.status}`;

      return response;
    } finally {
      this.metrics.upstreamDuration.observe(
        { service: this.service, outcome },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timeout' : error.message;
  }

  return String(error);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Short body excerpt for LOGS only (never returned to API clients). */
async function excerpt(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');

  return text ? `: ${text.slice(0, 300)}` : '';
}
