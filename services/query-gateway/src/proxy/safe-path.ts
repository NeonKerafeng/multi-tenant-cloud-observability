import { ForbiddenException } from '@nestjs/common';

/**
 * Guards against path traversal when a client-controlled path is appended
 * to a downstream base URL.
 *
 * Node's WHATWG URL parser (used by axios) collapses "." / ".." segments,
 * including their percent-encoded forms ("%2e", "%2e%2e") and treats "\"
 * as "/". Without these checks, a path such as
 *   /api/v1/../../../../multitenant/prometheus/api/v1/query
 * appended to /select/<accountId>/prometheus would be normalized into
 * /select/multitenant/prometheus/api/v1/query (all tenants).
 */
export function assertSafeRelativePath(pathWithQuery: string): void {
  const path = pathWithQuery.split('?', 1)[0];

  if (path.includes('\\')) {
    throw new ForbiddenException('Invalid path');
  }

  for (const rawSegment of path.split('/')) {
    let segment: string;

    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new ForbiddenException('Invalid path encoding');
    }

    if (
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      throw new ForbiddenException('Invalid path');
    }
  }
}

/**
 * Resolves `baseUrl + targetPath` exactly like the HTTP client will, and
 * verifies that the FINAL pathname still lives under `requiredPrefix`.
 *
 * Returns the normalized "pathname + search" to be sent downstream.
 */
export function resolveDownstreamPath(
  baseUrl: string,
  targetPath: string,
  requiredPrefix: string,
): string {
  assertSafeRelativePath(targetPath);

  const url = new URL(`${baseUrl}${targetPath}`);

  if (!url.pathname.startsWith(requiredPrefix)) {
    throw new ForbiddenException('Invalid path');
  }

  return `${url.pathname}${url.search}`;
}
