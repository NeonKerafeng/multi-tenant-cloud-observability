import { ForbiddenException } from '@nestjs/common';

import { assertSafeRelativePath, resolveDownstreamPath } from './safe-path';

const VM = 'http://vmselect:8481';

describe('assertSafeRelativePath', () => {
  it.each([
    '/api/v1/query?query=up',
    '/api/v1/query_range?query=rate(x[5m])&start=1&end=2&step=15',
    '/api/v1/label/__name__/values',
    '/api/v1/query?query=a/b..c', // dots inside query string are fine
    '/otel-logs*/_search',
  ])('accepts %s', (path) => {
    expect(() => assertSafeRelativePath(path)).not.toThrow();
  });

  it.each([
    '/api/v1/../../../../multitenant/prometheus/api/v1/query',
    '/api/v1/%2e%2e/%2e%2e/%2e%2e/%2e%2e/multitenant/prometheus/api/v1/query',
    '/api/v1/%2E%2E/x',
    '/api/v1/.%2e/x',
    '/api/v1/./query',
    '/api/v1/..\\..\\x',
    '/api/v1/%5c..%5cx',
    '/api/v1/a%2f..%2fb',
    '/api/v1/%zz',
  ])('rejects %s', (path) => {
    expect(() => assertSafeRelativePath(path)).toThrow(ForbiddenException);
  });
});

describe('resolveDownstreamPath', () => {
  it('keeps a normal tenant path and its query string', () => {
    expect(
      resolveDownstreamPath(
        VM,
        '/select/2/prometheus/api/v1/query?query=up',
        '/select/2/prometheus/api/v1/',
      ),
    ).toBe('/select/2/prometheus/api/v1/query?query=up');
  });

  it('rejects traversal into the multitenant endpoint', () => {
    expect(() =>
      resolveDownstreamPath(
        VM,
        '/select/2/prometheus/api/v1/../../../../multitenant/prometheus/api/v1/query',
        '/select/2/prometheus/api/v1/',
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a final path outside the required prefix', () => {
    expect(() =>
      resolveDownstreamPath(
        VM,
        '/select/3/prometheus/api/v1/query',
        '/select/2/prometheus/api/v1/',
      ),
    ).toThrow(ForbiddenException);
  });
});
