import {
  All,
  Controller,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth-user';

import { TenantService } from '../tenant/tenant.service';

import { HttpProxyService } from './http-proxy.service';
import { OpenSearchTenantService } from './opensearch-tenant.service';

@Controller('query/opensearch')
@UseGuards(JwtAuthGuard)
export class OpenSearchController {
  constructor(
    private readonly proxy: HttpProxyService,
    private readonly config: ConfigService,
    private readonly tenants: TenantService,
    private readonly tenantEnforcer: OpenSearchTenantService,
  ) {}

  @All('*path')
  async proxyRequest(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user as AuthUser;

    const tenant = this.tenants.resolve(
      user,
      req.header('x-tenant-id'),
    );

    this.tenantEnforcer.enforce(
      req,
      tenant.tenantId,
      tenant.platformAdmin,
    );

    const baseUrl =
      this.config.getOrThrow<string>('OPENSEARCH_URL');

    const username =
      this.config.getOrThrow<string>(
        'OPENSEARCH_USERNAME',
      );

    const password =
      this.config.getOrThrow<string>(
        'OPENSEARCH_PASSWORD',
      );

    const authorization =
      `Basic ${Buffer.from(
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
    );
  }
}