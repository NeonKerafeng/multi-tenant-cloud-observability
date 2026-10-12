import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('allows perMinute requests per key, then refuses until tokens refill', () => {
    let now = 0;
    const limiter = new RateLimiter(3, () => now);

    expect([1, 2, 3, 4].map(() => limiter.take('a'))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(limiter.take('b')).toBe(true);

    now += 20_000; // 1 token per 20 s at 3/min

    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });

  it('never stores more than perMinute tokens', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);

    limiter.take('a');
    now += 10 * 60_000;

    expect([1, 2, 3].map(() => limiter.take('a'))).toEqual([true, true, false]);
  });

  it('perMinute <= 0 disables the limit', () => {
    const limiter = new RateLimiter(0);

    expect(
      Array.from({ length: 50 }, () => limiter.take('a')).every(Boolean),
    ).toBe(true);
  });

  it('forgets idle keys when it tracks too many', () => {
    let now = 0;
    const limiter = new RateLimiter(10, () => now, 3);

    ['a', 'b', 'c'].forEach((key) => limiter.take(key));
    now += 60_000;
    limiter.take('d');

    expect(limiter.size).toBe(1);
  });
});
