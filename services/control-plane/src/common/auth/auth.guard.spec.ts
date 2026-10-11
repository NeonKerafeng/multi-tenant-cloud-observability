import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { UserRepository } from '../../modules/users/user.repository';
import { ForbiddenError, UnauthenticatedError } from '../errors/domain-error';
import { user } from '../testing/fixtures';

import { AuthGuard, bearerToken } from './auth.guard';
import type { JwtVerifier } from './jwt-verifier';
import { IS_PUBLIC_KEY, ROLES_KEY } from './metadata';

function setup(opts: {
  metadata?: Record<string, unknown>;
  header?: string;
  verify?: () => Promise<{ sub: string }>;
  found?: ReturnType<typeof user> | null;
}) {
  const request: Record<string, unknown> = {
    method: 'GET',
    originalUrl: '/x',
    header: (name: string) =>
      name === 'authorization' ? opts.header : undefined,
  };

  const context = {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const reflector = {
    getAllAndOverride: jest.fn((key: string) => opts.metadata?.[key]),
  };

  const verifier = {
    verify: jest.fn(
      opts.verify ?? (() => Promise.resolve({ sub: 'kc-viewer' })),
    ),
  };

  const users = {
    findActiveByKeycloakId: jest
      .fn()
      .mockResolvedValue(opts.found === undefined ? user() : opts.found),
  };

  const guard = new AuthGuard(
    reflector as unknown as Reflector,
    verifier as unknown as JwtVerifier,
    users as unknown as UserRepository,
  );

  return { guard, context, request, users, verifier };
}

describe('AuthGuard', () => {
  it('lets @Public routes through without a token', async () => {
    const { guard, context, verifier } = setup({
      metadata: { [IS_PUBLIC_KEY]: true },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('401 without a bearer token', async () => {
    const { guard, context } = setup({ metadata: { [ROLES_KEY]: ['viewer'] } });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('401 on an invalid token', async () => {
    const { guard, context } = setup({
      metadata: { [ROLES_KEY]: ['viewer'] },
      header: 'Bearer abc',
      verify: () => Promise.reject(new Error('bad signature')),
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('403 not_registered when the Keycloak account has no active row', async () => {
    const { guard, context } = setup({
      metadata: { [ROLES_KEY]: ['viewer'] },
      header: 'Bearer abc',
      found: null,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'not_registered',
    });
  });

  it('403 account_disabled for a disabled user, even with a valid token (I-35)', async () => {
    const { guard, context } = setup({
      metadata: { [ROLES_KEY]: ['viewer'] },
      header: 'Bearer abc',
      found: user({ enabled: false }),
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'account_disabled',
    });
  });

  it('fails closed on a route with neither @Public nor @Roles', async () => {
    const { guard, context } = setup({ header: 'Bearer abc' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      /neither @Public nor @Roles/,
    );
  });

  it('403 when the role is not allowed', async () => {
    const { guard, context } = setup({
      metadata: { [ROLES_KEY]: ['platform-admin'] },
      header: 'Bearer abc',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('attaches the actor from the DB (role and tenant from the row)', async () => {
    const { guard, context, request, users } = setup({
      metadata: { [ROLES_KEY]: ['viewer', 'tenant-admin'] },
      header: 'Bearer abc',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(users.findActiveByKeycloakId).toHaveBeenCalledWith('kc-viewer');
    expect(request.actor).toMatchObject({
      userId: user().id,
      role: 'viewer',
      tenantKey: 'alpha-tenant',
    });
  });
});

describe('bearerToken', () => {
  it.each([
    [undefined, null],
    ['Basic abc', null],
    ['Bearer abc', 'abc'],
    ['bearer   abc ', 'abc'],
    ['Bearer a b', null],
  ])('%s -> %s', (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });
});
