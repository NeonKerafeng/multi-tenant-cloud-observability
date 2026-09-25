import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

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

    if (isSearch) {
      req.body = this.applyTenantFilter(req.body ?? {}, tenantId);
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

  private applyTenantFilter(
    body: Record<string, unknown>,
    tenantId: string,
  ): Record<string, unknown> {
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

  private rewriteMsearch(rawBody: unknown, tenantId: string): Buffer {
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
      throw new BadRequestException('Expected NDJSON msearch body');
    }

    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;

    const lines = text.split('\n').filter((line) => line.length > 0);

    if (lines.length % 2 !== 0) {
      throw new BadRequestException('Invalid _msearch NDJSON');
    }

    const output: string[] = [];

    for (let i = 0; i < lines.length; i += 2) {
      const header = JSON.parse(lines[i]) as Record<string, unknown>;

      const query = JSON.parse(lines[i + 1]) as Record<string, unknown>;

      header.index = 'otel-logs*';

      output.push(JSON.stringify(header));
      output.push(JSON.stringify(this.applyTenantFilter(query, tenantId)));
    }

    return Buffer.from(`${output.join('\n')}\n`, 'utf8');
  }
}
