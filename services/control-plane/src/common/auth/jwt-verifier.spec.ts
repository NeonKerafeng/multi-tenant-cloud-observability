import jwt from 'jsonwebtoken';
import { createHmac, generateKeyPairSync } from 'node:crypto';

import { AppConfig } from '../../config/app-config';

import { JwtVerifier } from './jwt-verifier';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

class TestVerifier extends JwtVerifier {
  protected resolveKey(): Promise<string> {
    return Promise.resolve(PUBLIC_PEM);
  }
}

describe('JwtVerifier JWKS loading', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('loads RSA signing keys by kid and verifies with them', async () => {
    const jwk = publicKey.export({ format: 'jwk' });

    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }],
          }),
        ),
      ),
    );
    global.fetch = fetchMock;

    const verifier = new JwtVerifier(config);

    await expect(verifier.verify(sign({ sub: 'kc-1' }))).resolves.toEqual({
      sub: 'kc-1',
    });
    await expect(verifier.verify(sign({ sub: 'kc-2' }))).resolves.toEqual({
      sub: 'kc-2',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      verifier.verify(sign({ sub: 'kc-3' }, { keyid: 'other' })),
    ).rejects.toThrow(/unknown signing key/);
    // The refetch is rate limited.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

const config = AppConfig.forTest();

function sign(
  claims: Record<string, unknown>,
  options: jwt.SignOptions = {},
): string {
  return jwt.sign(claims, privateKey, {
    algorithm: 'RS256',
    keyid: 'k1',
    issuer: config.keycloak.issuer,
    audience: config.keycloak.audience,
    expiresIn: 300,
    ...options,
  });
}

describe('JwtVerifier', () => {
  const verifier = new TestVerifier(config);

  it('accepts a valid token and returns its subject', async () => {
    await expect(verifier.verify(sign({ sub: 'kc-1' }))).resolves.toEqual({
      sub: 'kc-1',
    });
  });

  it.each([
    ['wrong issuer', { issuer: 'http://evil/realms/observability' }],
    ['wrong audience', { audience: 'query-gateway' }],
    ['expired', { expiresIn: -120 }],
  ])('rejects a token with %s', async (_label, options) => {
    await expect(
      verifier.verify(sign({ sub: 'kc-1' }, options)),
    ).rejects.toThrow();
  });

  it('rejects a token without subject', async () => {
    await expect(verifier.verify(sign({}))).rejects.toThrow(/subject/);
  });

  it('rejects garbage', async () => {
    await expect(verifier.verify('not-a-jwt')).rejects.toThrow(/malformed/);
  });

  it('rejects HS256 signed with the public key (algorithm confusion)', async () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT', kid: 'k1' })}.${encode(
      {
        sub: 'kc-1',
        iss: config.keycloak.issuer,
        aud: config.keycloak.audience,
        exp: now + 300,
      },
    )}`;
    const signature = createHmac('sha256', PUBLIC_PEM)
      .update(unsigned)
      .digest('base64url');

    await expect(verifier.verify(`${unsigned}.${signature}`)).rejects.toThrow();
  });
});
