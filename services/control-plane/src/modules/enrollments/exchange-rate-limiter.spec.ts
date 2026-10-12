import { AppConfig } from '../../config/app-config';

import { ExchangeRateLimiter } from './exchange-rate-limiter';

describe('ExchangeRateLimiter', () => {
  it('per IP, then in total → 429 rate_limited', () => {
    const limiter = new ExchangeRateLimiter(
      AppConfig.forTest({
        enrollmentExchange: { perIpPerMinute: 2, perMinute: 3 },
      }),
    );

    limiter.check('10.0.0.1');
    limiter.check('10.0.0.1');
    expect(() => limiter.check('10.0.0.1')).toThrow(
      expect.objectContaining({ code: 'rate_limited', status: 429 }) as Error,
    );

    limiter.check('10.0.0.2');
    expect(() => limiter.check('10.0.0.3')).toThrow(
      expect.objectContaining({ code: 'rate_limited' }) as Error,
    );
  });
});
