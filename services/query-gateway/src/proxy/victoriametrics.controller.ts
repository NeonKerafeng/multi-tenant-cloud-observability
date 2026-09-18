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

import { TenantRegistryService } from '../tenant/tenant-registry.service';
import { TenantService } from '../tenant/tenant.service';

import { HttpProxyService } from './http-proxy.service';

@Controller('query/victoriametrics')
@UseGuards(JwtAuthGuard)
export class VictoriaMetricsController {
  constructor(
    private readonly proxy: HttpProxyService,
    private readonly config: ConfigService,
    private readonly tenants: TenantService,
    private readonly registry: TenantRegistryService,
  ) {}

  @All('*path')
  async proxyRequest(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (
      !['GET', 'POST'].includes(
        req.method.toUpperCase(),
      )
    ) {
      throw new ForbiddenException(
        'VictoriaMetrics query gateway is read-only',
      );
    }

    const user = req.user as AuthUser;

    const tenant = this.tenants.resolve(
      user,
      req.header('x-tenant-id'),
    );

    const clientPath =
      req.originalUrl.replace(
        '/query/victoriametrics',
        '',
      );

    if (!clientPath.startsWith('/api/v1/')) {
      throw new ForbiddenException(
        'Unsupported VictoriaMetrics endpoint',
      );
    }

    let vmTenant: string;

    if (
      tenant.platformAdmin &&
      tenant.tenantId === null
    ) {
      vmTenant = 'multitenant';
    } else {
      vmTenant = this.registry.vmTenantId(
        tenant.tenantId!,
      );
    }

    const baseUrl =
      this.config.getOrThrow<string>(
        'VICTORIAMETRICS_URL',
      );

    const targetPath =
      `/select/${vmTenant}/prometheus${clientPath}`;

    await this.proxy.forward(
      baseUrl,
      '/query/victoriametrics',
      req,
      res,
      {},
      targetPath,
    );
  }
}