import { Injectable, Logger } from '@nestjs/common';

import jwt from 'jsonwebtoken';
import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';

import { AppConfig } from '../../config/app-config';

export interface VerifiedToken {
  sub: string;
}

interface Jwks {
  keys?: (JsonWebKey & { kid?: string; use?: string })[];
}

/** Never refetch the JWKS more often than this (unknown kid floods). */
const MIN_REFRESH_MS = 30 * 1000;

/**
 * Verifies Keycloak access tokens: RS256, issuer, audience, expiry
 * (30 s clock tolerance). Signing keys come from the realm JWKS, cached
 * by kid and refetched when an unknown kid appears (key rotation).
 * Plain node:crypto: no jwks-rsa (its jose dependency is ESM-only).
 * Tests override `resolveKey`.
 */
@Injectable()
export class JwtVerifier {
  private readonly logger = new Logger(JwtVerifier.name);

  private keys = new Map<string, KeyObject>();
  private lastFetch = 0;
  private fetching: Promise<void> | null = null;

  constructor(private readonly config: AppConfig) {}

  /** Throws on any problem (callers map it to 401). */
  async verify(token: string): Promise<VerifiedToken> {
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded || typeof decoded === 'string') {
      throw new Error('malformed token');
    }

    const key = await this.resolveKey(decoded.header.kid);

    const payload = jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: this.config.keycloak.issuer,
      audience: this.config.keycloak.audience,
      clockTolerance: 30,
    });

    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      throw new Error('token has no subject');
    }

    return { sub: payload.sub };
  }

  protected async resolveKey(
    kid: string | undefined,
  ): Promise<KeyObject | string> {
    if (!kid) {
      throw new Error('token has no kid');
    }

    let key = this.keys.get(kid);

    if (!key && Date.now() - this.lastFetch >= MIN_REFRESH_MS) {
      await this.refresh();
      key = this.keys.get(kid);
    }

    if (!key) {
      throw new Error(`unknown signing key ${kid}`);
    }

    return key;
  }

  private refresh(): Promise<void> {
    this.fetching ??= this.fetchKeys().finally(() => {
      this.fetching = null;
    });

    return this.fetching;
  }

  private async fetchKeys(): Promise<void> {
    this.lastFetch = Date.now();

    const response = await fetch(this.config.keycloak.jwksUri, {
      signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${response.status}`);
    }

    const jwks = (await response.json()) as Jwks;
    const keys = new Map<string, KeyObject>();

    for (const jwk of jwks.keys ?? []) {
      if (!jwk.kid || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) {
        continue;
      }

      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }

    this.keys = keys;
    this.logger.log(`Loaded ${keys.size} signing key(s) from JWKS`);
  }
}
