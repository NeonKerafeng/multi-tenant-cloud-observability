import {
  All,
  Controller,
  ForbiddenException,
  InternalServerErrorException,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { resolveQueryAccess } from './access';
import { HttpProxyService } from './http-proxy.service';
import { resolveDownstreamPath } from './safe-path';

type AuthenticatedRequest = Request & {
  user: AuthUser;
};

@UseGuards(JwtAuthGuard)
@Controller('query/victoriametrics')
export class VictoriaMetricsController {
  constructor(
    private readonly proxy: HttpProxyService,
    private readonly config: ConfigService,
  ) {}

  @All('*path')
  async proxyRequest(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    if (!['GET', 'POST'].includes(req.method.toUpperCase())) {
      throw new ForbiddenException(
        'VictoriaMetrics query gateway is read-only',
      );
    }

    const clientPath = req.originalUrl.replace('/query/victoriametrics', '');

    if (!clientPath.startsWith('/api/v1/')) {
      throw new ForbiddenException('Unsupported VictoriaMetrics endpoint');
    }

    if (clientPath.startsWith('/api/v1/admin/')) {
      throw new ForbiddenException(
        'VictoriaMetrics admin endpoints are not allowed',
      );
    }

    const access = resolveQueryAccess(req.user);

    let tenantSegment: string;

    if (access.platformAdmin) {
      tenantSegment = 'multitenant';
    } else {
      const vmAccountIds = req.user.vmAccountIds
        .map((accountId) => accountId.trim())
        .filter(Boolean);

      if (vmAccountIds.length !== 1) {
        throw new ForbiddenException(
          'Tenant must have exactly one VictoriaMetrics account ID',
        );
      }

      const accountId = vmAccountIds[0];

      if (!/^\d+$/.test(accountId)) {
        throw new InternalServerErrorException(
          'VictoriaMetrics account ID must be numeric',
        );
      }

      tenantSegment = accountId;
    }

    const requiredPrefix = `/select/${tenantSegment}/prometheus/api/v1/`;

    const baseUrl = this.config.getOrThrow<string>('VICTORIAMETRICS_URL');

    /*
     * Validate the FINAL path (after URL normalization), not the raw
     * client string. See safe-path.ts.
     */
    const targetPath = resolveDownstreamPath(
      baseUrl,
      `/select/${tenantSegment}/prometheus${clientPath}`,
      requiredPrefix,
    );

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
