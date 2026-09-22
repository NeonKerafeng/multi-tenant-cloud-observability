import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import type { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class HttpProxyService {
  constructor(private readonly http: HttpService) {}

  async forward(
    baseUrl: string,
    prefix: string,
    req: Request,
    res: Response,
    extraHeaders: Record<string, string> = {},
    pathOverride?: string,
  ): Promise<void> {
    const downstreamPath = pathOverride ?? req.originalUrl.replace(prefix, '');

    const url = `${baseUrl}${downstreamPath}`;

    const response = await firstValueFrom(
      this.http.request({
        method: req.method,
        url,
        data: req.body,
        headers: {
          ...this.forwardHeaders(req),
          ...extraHeaders,
        },
        responseType: 'arraybuffer',
        validateStatus: () => true,
      }),
    );

    res.status(response.status);

    const contentType = response.headers['content-type'];

    if (typeof contentType === 'string') {
      res.setHeader('content-type', contentType);
    }

    res.send(response.data);
  }

  private forwardHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};

    if (req.headers['content-type']) {
      headers['content-type'] = req.headers['content-type'];
    }

    if (req.headers.accept) {
      headers.accept = req.headers.accept;
    }

    return headers;
  }
}
