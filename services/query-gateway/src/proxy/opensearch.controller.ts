import {
  All,
  Controller,
  ForbiddenException,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { HttpProxyService } from './http-proxy.service';
import { OpenSearchTenantService } from './opensearch-tenant.service';

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
    const user = req.user;

    const platformAdmin = user.roles.includes('platform-admin');

    let tenantId: string | null = null;

    if (!platformAdmin) {
      const groups = user.groups
        .map((group) => group.replace(/^\/+/, ''))
        .filter(Boolean);

      if (groups.length !== 1) {
        throw new ForbiddenException(
          'User must belong to exactly one tenant group',
        );
      }

      tenantId = groups[0];
    }

    this.tenant.enforce(req, tenantId, platformAdmin);

    const baseUrl = this.config.getOrThrow<string>('OPENSEARCH_URL');

    const username = this.config.getOrThrow<string>('OPENSEARCH_USERNAME');
    const password = this.config.getOrThrow<string>('OPENSEARCH_PASSWORD');

    const authorization = `Basic ${Buffer.from(
      `${username}:${password}`,
    ).toString('base64')}`;

    await this.proxy.forward(baseUrl, '/query/opensearch', req, res, {
      authorization,
    });
  }
}