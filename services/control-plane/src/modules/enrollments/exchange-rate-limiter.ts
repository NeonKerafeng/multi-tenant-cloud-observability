import { Injectable } from '@nestjs/common';

import { TooManyRequestsError } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { AppConfig } from '../../config/app-config';

/**
 * Limits the public exchange (brute force of tokens, runaway scripts):
 * per client IP and in total, per pod. Over the limit → 429 rate_limited.
 */
@Injectable()
export class ExchangeRateLimiter {
  private readonly perIp: RateLimiter;
  private readonly total: RateLimiter;

  constructor(config: AppConfig) {
    this.perIp = new RateLimiter(config.enrollmentExchange.perIpPerMinute);
    this.total = new RateLimiter(config.enrollmentExchange.perMinute);
  }

  check(ip: string): void {
    // Per IP first: one noisy host must not use up everybody's budget.
    if (!this.perIp.take(ip) || !this.total.take('*')) {
      throw new TooManyRequestsError(
        'rate_limited',
        'Too many enrollment exchanges; retry in a minute',
      );
    }
  }
}
