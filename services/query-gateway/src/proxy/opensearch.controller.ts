import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { resolveQueryAccess } from './access';
import { HttpProxyService } from './http-proxy.service';
import { OpenSearchTenantService } from './opensearch-tenant.service';
import { resolveDownstreamPath } from './safe-path';

type AuthenticatedRequest = Request & {
  user: AuthUser;
};

@UseGuards(JwtAuthGuard)
@Controller('query/opensearch')
export class OpenSearchController {
  constructor(
    private readonly proxy: HttpProxyService,
    private readonly config: ConfigService,
    private readonly tenant: OpenSearchTenantService,
  ) {}

  @All('*path')
  async proxyRequest(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const access = resolveQueryAccess(req.user);

    const baseUrl = this.config.getOrThrow<string>('OPENSEARCH_URL');

    /*
     * Reject "." / ".." segments before any path-based decision is made,
     * so the checks in enforce() see the same path OpenSearch will see.
     */
    const clientPath = req.originalUrl.replace('/query/opensearch', '');

    const targetPath = resolveDownstreamPath(baseUrl, clientPath, '/');

    this.tenant.enforce(req, access.tenantId, access.platformAdmin);

    const username = this.config.getOrThrow<string>('OPENSEARCH_USERNAME');
    const password = this.config.getOrThrow<string>('OPENSEARCH_PASSWORD');

    const authorization = `Basic ${Buffer.from(
      `${username}:${password}`,
    ).toString('base64')}`;

    await this.proxy.forward(
      baseUrl,
      '/query/opensearch',
      req,
      res,
      {
        authorization,
      },
      targetPath,
    );
  }
}
