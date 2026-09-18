import { All, Controller, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { HttpProxyService } from './http-proxy.service';

@Controller('query/opensearch')
export class OpenSearchController {
  constructor(
    private readonly proxy: HttpProxyService,
    private readonly config: ConfigService,
  ) {}

  @All('*path')
  async proxyRequest(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const baseUrl =
      this.config.getOrThrow<string>('OPENSEARCH_URL');

    const username =
      this.config.getOrThrow<string>('OPENSEARCH_USERNAME');

    const password =
      this.config.getOrThrow<string>('OPENSEARCH_PASSWORD');

    const authorization =
      `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

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