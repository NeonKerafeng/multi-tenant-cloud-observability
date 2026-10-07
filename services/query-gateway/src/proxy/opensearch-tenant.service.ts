import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Aggregations that compute over documents OUTSIDE the search query scope,
 * and therefore escape the tenant filter:
 * - global: ignores the query entirely
 * - significant_terms / significant_text: background set = whole index
 */
const FORBIDDEN_AGGREGATIONS = new Set([
  'global',
  'significant_terms',
  'significant_text',
]);

/**
 * Aggregations where min_doc_count = 0 returns terms that exist in the
 * index even if no tenant document matches (enumerates other tenants'
 * values). They are clamped to 1.
 */
const TERM_ENUMERATING_AGGREGATIONS = new Set(['terms', 'multi_terms']);

/**
 * Top-level body keys that are evaluated outside the query scope.
 */
const FORBIDDEN_BODY_KEYS = new Set(['suggest']);

/**
 * URL parameters that inject a query or a whole body via the URL,
 * replacing the (tenant-filtered) body query.
 */
const FORBIDDEN_QUERY_PARAMS = ['q', 'source', 'source_content_type'];

@Injectable()
export class OpenSearchTenantService {
  enforce(req: Request, tenantId: string | null, platformAdmin: boolean): void {
    const method = req.method.toUpperCase();

    if (!['GET', 'POST'].includes(method)) {
      throw new ForbiddenException('OpenSearch gateway is read-only');
    }

    const path = req.originalUrl.replace('/query/opensearch', '').split('?')[0];

    const isSearch = path.endsWith('/_search');
    const isMsearch = path === '/_msearch' || path.endsWith('/_msearch');

    const metadata =
      path.endsWith('/_field_caps') ||
      path.endsWith('/_mapping') ||
      path.startsWith('/_resolve/index/');

    if (!isSearch && !isMsearch && !metadata) {
      throw new ForbiddenException(
        'OpenSearch endpoint is not allowed through query gateway',
      );
    }

    this.assertLogsIndex(path);

    if (platformAdmin && tenantId === null) {
      return;
    }

    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    this.assertNoQueryInjectionParams(req);

    if (isSearch) {
      req.body = this.applyTenantFilter(this.toSearchBody(req.body), tenantId);
    }

    if (isMsearch) {
      req.body = this.rewriteMsearch(req.body, tenantId);
    }
  }

  private assertLogsIndex(path: string): void {
    const first = path.split('/').filter(Boolean)[0];

    if (first && !first.startsWith('_') && !first.startsWith('otel-logs')) {
      throw new ForbiddenException('Only otel-logs indices are queryable');
    }
  }

  private assertNoQueryInjectionParams(req: Request): void {
    const query = (req.query ?? {}) as Record<string, unknown>;

    for (const param of FORBIDDEN_QUERY_PARAMS) {
      if (param in query) {
        throw new ForbiddenException(
          `Query parameter "${param}" is not allowed`,
        );
      }
    }
  }

  private toSearchBody(rawBody: unknown): Record<string, unknown> {
    if (rawBody === undefined || rawBody === null) {
      return {};
    }

    if (
      typeof rawBody !== 'object' ||
      Array.isArray(rawBody) ||
      Buffer.isBuffer(rawBody)
    ) {
      throw new BadRequestException('Expected JSON object search body');
    }

    return rawBody as Record<string, unknown>;
  }

  private applyTenantFilter(
    body: Record<string, unknown>,
    tenantId: string,
  ): Record<string, unknown> {
    this.assertNoTenantEscape(body);

    const originalQuery = body.query ?? { match_all: {} };

    return {
      ...body,

      query: {
        bool: {
          must: [originalQuery],

          filter: [
            {
              term: {
                'resource.tenant.id.keyword': tenantId,
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Rejects (or neutralizes) body constructs that are evaluated outside
   * the query scope and would therefore bypass the tenant filter.
   */
  private assertNoTenantEscape(body: Record<string, unknown>): void {
    for (const key of Object.keys(body)) {
      if (FORBIDDEN_BODY_KEYS.has(key)) {
        throw new ForbiddenException(`Search body key "${key}" is not allowed`);
      }
    }

    this.checkAggregations(body.aggs);
    this.checkAggregations(body.aggregations);
  }

  private checkAggregations(aggregations: unknown): void {
    if (aggregations === undefined) {
      return;
    }

    if (!this.isPlainObject(aggregations)) {
      throw new BadRequestException('Invalid aggregations');
    }

    for (const definition of Object.values(aggregations)) {
      if (!this.isPlainObject(definition)) {
        throw new BadRequestException('Invalid aggregation definition');
      }

      for (const [type, settings] of Object.entries(definition)) {
        if (FORBIDDEN_AGGREGATIONS.has(type)) {
          throw new ForbiddenException(`Aggregation "${type}" is not allowed`);
        }

        if (
          TERM_ENUMERATING_AGGREGATIONS.has(type) &&
          this.isPlainObject(settings) &&
          Number(settings.min_doc_count) === 0 &&
          settings.min_doc_count !== undefined
        ) {
          settings.min_doc_count = 1;
        }
      }

      this.checkAggregations(definition.aggs);
      this.checkAggregations(definition.aggregations);
    }
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !Buffer.isBuffer(value)
    );
  }

  private rewriteMsearch(rawBody: unknown, tenantId: string): Buffer {
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
      throw new BadRequestException('Expected NDJSON msearch body');
    }

    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;

    const lines = text.split('\n').filter((line) => line.trim().length > 0);

    if (lines.length % 2 !== 0) {
      throw new BadRequestException('Invalid _msearch NDJSON');
    }

    const output: string[] = [];

    for (let i = 0; i < lines.length; i += 2) {
      const header = this.parseNdjsonLine(lines[i]);

      const query = this.parseNdjsonLine(lines[i + 1]);

      header.index = 'otel-logs*';

      output.push(JSON.stringify(header));
      output.push(JSON.stringify(this.applyTenantFilter(query, tenantId)));
    }

    return Buffer.from(`${output.join('\n')}\n`, 'utf8');
  }

  private parseNdjsonLine(line: string): Record<string, unknown> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      throw new BadRequestException('Invalid _msearch NDJSON');
    }

    if (!this.isPlainObject(parsed)) {
      throw new BadRequestException('Invalid _msearch NDJSON');
    }

    return parsed;
  }
}
