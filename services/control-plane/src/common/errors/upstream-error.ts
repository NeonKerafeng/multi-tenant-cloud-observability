export type UpstreamService = 'keycloak' | 'grafana';

/**
 * A call to Keycloak or Grafana failed. `message` is for logs only (it may
 * contain an excerpt of the upstream body); clients get a generic message.
 */
export abstract class UpstreamError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;

  constructor(
    readonly service: UpstreamService,
    readonly upstreamStatus: number | null,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Network error, timeout, or 502/503/504 from the upstream. */
export class UpstreamUnavailableError extends UpstreamError {
  readonly status = 503;
  readonly code = 'upstream_unavailable';
}

/** The upstream answered, but not with what we expected. */
export class UpstreamBadResponseError extends UpstreamError {
  readonly status = 502;
  readonly code = 'upstream_bad_response';
}
