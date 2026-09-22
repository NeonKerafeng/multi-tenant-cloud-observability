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

import { HttpProxyService } from './http-proxy.service';

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

    const clientPath =
      req.originalUrl.replace('/query/victoriametrics', '');

    if (!clientPath.startsWith('/api/v1/')) {
      throw new ForbiddenException(
        'Unsupported VictoriaMetrics endpoint',
      );
    }

    const user = req.user;

    const platformAdmin =
      user.roles.includes('platform-admin');

    let targetPath: string;

    if (platformAdmin) {
      targetPath =
        `/select/multitenant/prometheus${clientPath}`;
    } else {
      const groups = user.groups
        .map((group) => group.replace(/^\/+/, ''))
        .filter(Boolean);

      if (groups.length !== 1) {
        throw new ForbiddenException(
          'User must belong to exactly one tenant group',
        );
      }

      const vmAccountIds = user.vmAccountIds
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

      targetPath =
        `/select/${accountId}/prometheus${clientPath}`;
    }

    const baseUrl =
      this.config.getOrThrow<string>(
        'VICTORIAMETRICS_URL',
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