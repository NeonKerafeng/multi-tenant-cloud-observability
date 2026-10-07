import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import { OpenSearchTenantService } from './opensearch-tenant.service';

const TENANT_FILTER = {
  term: { 'resource.tenant.id.keyword': 'tenant-a' },
};

function request(
  path: string,
  body: unknown,
  query: Record<string, unknown> = {},
  method = 'POST',
): Request {
  return {
    method,
    originalUrl: `/query/opensearch${path}`,
    body,
    query,
  } as unknown as Request;
}

describe('OpenSearchTenantService', () => {
  const service = new OpenSearchTenantService();

  describe('_search (tenant user)', () => {
    it('wraps the query with the tenant filter', () => {
      const req = request('/otel-logs*/_search', {
        size: 10,
        query: { match: { body: 'error' } },
      });

      service.enforce(req, 'tenant-a', false);

      expect(req.body).toEqual({
        size: 10,
        query: {
          bool: {
            must: [{ match: { body: 'error' } }],
            filter: [TENANT_FILTER],
          },
        },
      });
    });

    it('adds the filter when no body is sent', () => {
      const req = request('/otel-logs*/_search', undefined);

      service.enforce(req, 'tenant-a', false);

      expect(req.body).toEqual({
        query: {
          bool: { must: [{ match_all: {} }], filter: [TENANT_FILTER] },
        },
      });
    });

    it('keeps normal Grafana aggregations working', () => {
      const req = request('/otel-logs*/_search', {
        size: 0,
        aggs: {
          '2': {
            date_histogram: {
              field: '@timestamp',
              fixed_interval: '30s',
              min_doc_count: 0,
            },
            aggs: {
              '3': { terms: { field: 'severity.text.keyword', size: 10 } },
            },
          },
        },
      });

      expect(() => service.enforce(req, 'tenant-a', false)).not.toThrow();
    });

    it.each([
      ['global aggregation', { aggs: { all: { global: {} } } }],
      [
        'nested global aggregation',
        { aggs: { x: { terms: { field: 'a' }, aggs: { y: { global: {} } } } } },
      ],
      [
        'global under "aggregations"',
        { aggregations: { all: { global: {} } } },
      ],
      [
        'significant_terms',
        { aggs: { s: { significant_terms: { field: 'a' } } } },
      ],
      [
        'significant_text',
        { aggs: { s: { significant_text: { field: 'body' } } } },
      ],
      [
        'suggest',
        {
          suggest: { s: { text: 'x', term: { field: 'resource.tenant.id' } } },
        },
      ],
    ])('rejects %s', (_name, body) => {
      const req = request('/otel-logs*/_search', body);

      expect(() => service.enforce(req, 'tenant-a', false)).toThrow(
        ForbiddenException,
      );
    });

    it('clamps terms min_doc_count 0 to 1', () => {
      const req = request('/otel-logs*/_search', {
        aggs: {
          t: {
            terms: { field: 'resource.tenant.id.keyword', min_doc_count: 0 },
          },
        },
      });

      service.enforce(req, 'tenant-a', false);

      const body = req.body as {
        aggs: { t: { terms: { min_doc_count: number } } };
      };

      expect(body.aggs.t.terms.min_doc_count).toBe(1);
    });

    it.each(['q', 'source', 'source_content_type'])(
      'rejects URL parameter %s',
      (param) => {
        const req = request('/otel-logs*/_search', {}, { [param]: 'x' });

        expect(() => service.enforce(req, 'tenant-a', false)).toThrow(
          ForbiddenException,
        );
      },
    );

    it('rejects a non-object body', () => {
      const req = request('/otel-logs*/_search', Buffer.from('{}'));

      expect(() => service.enforce(req, 'tenant-a', false)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('_msearch (tenant user)', () => {
    it('forces the index and filters every query', () => {
      const ndjson =
        '{"index":"other-index"}\n{"query":{"match_all":{}}}\n' +
        '{"index":"otel-logs*"}\n{"size":0}\n';

      const req = request('/_msearch', Buffer.from(ndjson));

      service.enforce(req, 'tenant-a', false);

      const lines = (req.body as Buffer)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(lines[0]).toEqual({ index: 'otel-logs*' });
      expect(lines[2]).toEqual({ index: 'otel-logs*' });
      expect(lines[1]).toEqual({
        query: {
          bool: { must: [{ match_all: {} }], filter: [TENANT_FILTER] },
        },
      });
      expect(lines[3]).toEqual({
        size: 0,
        query: {
          bool: { must: [{ match_all: {} }], filter: [TENANT_FILTER] },
        },
      });
    });

    it('rejects a global aggregation inside any msearch item', () => {
      const ndjson =
        '{"index":"otel-logs*"}\n{"query":{"match_all":{}}}\n' +
        '{"index":"otel-logs*"}\n{"aggs":{"all":{"global":{}}}}\n';

      const req = request('/_msearch', Buffer.from(ndjson));

      expect(() => service.enforce(req, 'tenant-a', false)).toThrow(
        ForbiddenException,
      );
    });

    it('rejects malformed NDJSON with 400', () => {
      const req = request(
        '/_msearch',
        Buffer.from('{"index":"x"}\nnot-json\n'),
      );

      expect(() => service.enforce(req, 'tenant-a', false)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('endpoint and index rules', () => {
    it.each([
      '/_security/api/internalusers',
      '/otel-logs/_doc/1',
      '/_cat/indices',
    ])('rejects endpoint %s', (path) => {
      expect(() =>
        service.enforce(request(path, {}, {}, 'GET'), 'tenant-a', false),
      ).toThrow(ForbiddenException);
    });

    it('rejects non-otel-logs indices', () => {
      expect(() =>
        service.enforce(request('/.kibana/_search', {}), 'tenant-a', false),
      ).toThrow(ForbiddenException);
    });

    it('rejects writes', () => {
      expect(() =>
        service.enforce(
          request('/otel-logs/_search', {}, {}, 'PUT'),
          'tenant-a',
          false,
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('platform-admin', () => {
    it('is not filtered', () => {
      const body = { aggs: { all: { global: {} } } };
      const req = request('/otel-logs*/_search', body);

      service.enforce(req, null, true);

      expect(req.body).toBe(body);
    });
  });
});
