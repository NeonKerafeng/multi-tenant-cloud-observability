import {
  All,
  Controller,
  ForbiddenException,
  Req,
  Res,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { HttpProxyService } from './http-proxy.service';

@Controller('query/victoriametrics')
export class VictoriaMetricsController {
  constructor(
    private readonly proxy: HttpProxyService,
    private readonly config: ConfigService,
  ) {}

  @All('*path')
  async proxyRequest(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!['GET', 'POST'].includes(req.method.toUpperCase())) {
      throw new ForbiddenException(
        'VictoriaMetrics query gateway is read-only',
      );
    }

    const clientPath = req.originalUrl.replace('/query/victoriametrics', '');

    if (!clientPath.startsWith('/api/v1/')) {
      throw new ForbiddenException('Unsupported VictoriaMetrics endpoint');
    }

    const baseUrl = this.config.getOrThrow<string>('VICTORIAMETRICS_URL');

    const targetPath = `/select/0/prometheus${clientPath}`;

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
