import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Request } from 'express';

import { UserRepository } from '../../modules/users/user.repository';
import { ForbiddenError, UnauthenticatedError } from '../errors/domain-error';

import type { Actor, Role } from './actor';
import { JwtVerifier } from './jwt-verifier';
import { IS_PUBLIC_KEY, ROLES_KEY } from './metadata';

/**
 * Global guard (APP_GUARD) for every route:
 *  1. @Public → allowed without a token.
 *  2. Bearer JWT verified (RS256, iss, aud, exp).
 *  3. Actor loaded from the DB by Keycloak user id: unknown → 403
 *     not_registered, disabled → 403 account_disabled.
 *  4. @Roles: actor.role must be listed. A route without @Roles is a
 *     programming error and is refused (fail closed).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
    private readonly users: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    const token = bearerToken(request.header('authorization'));

    if (!token) {
      throw new UnauthenticatedError();
    }

    let sub: string;

    try {
      sub = (await this.verifier.verify(token)).sub;
    } catch (error) {
      this.logger.debug(`Token rejected: ${String(error)}`);
      throw new UnauthenticatedError('Invalid or expired access token');
    }

    const user = await this.users.findActiveByKeycloakId(sub);

    if (!user || user.keycloakUserId === null) {
      throw new ForbiddenError(
        'not_registered',
        'This account is not registered in control-plane',
      );
    }

    if (!user.enabled) {
      throw new ForbiddenError('account_disabled', 'This account is disabled');
    }

    const actor: Actor = {
      userId: user.id,
      keycloakUserId: user.keycloakUserId,
      username: user.username,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      tenantKey: user.tenantKey,
    };

    request.actor = actor;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      targets,
    );

    if (!roles) {
      throw new Error(
        `Route ${request.method} ${request.route ? String((request.route as { path?: unknown }).path) : request.originalUrl} has neither @Public nor @Roles`,
      );
    }

    if (!roles.includes(actor.role)) {
      throw new ForbiddenError(
        'forbidden',
        `Role ${actor.role} may not perform this operation`,
      );
    }

    return true;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return match ? match[1] : null;
}
