import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

import type { AuthUser } from './auth-user';

interface KeycloakPayload {
  sub: string;
  preferred_username?: string;

  realm_access?: {
    roles?: string[];
  };

  groups?: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: config.getOrThrow<string>('KEYCLOAK_JWKS_URI'),
      }),

      issuer: config.getOrThrow<string>('KEYCLOAK_ISSUER'),
      audience: config.getOrThrow<string>('KEYCLOAK_AUDIENCE'),

      algorithms: ['RS256'],
    });
  }

  validate(payload: KeycloakPayload): AuthUser {
    return {
      sub: payload.sub,
      username: payload.preferred_username ?? payload.sub,
      roles: payload.realm_access?.roles ?? [],
      groups: payload.groups ?? [],
    };
  }
}