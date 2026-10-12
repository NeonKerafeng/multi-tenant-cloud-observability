import { AppConfig, ConfigError } from './app-config';

const REQUIRED = {
  DB_HOST: 'db',
  DB_NAME: 'mtco',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  KEYCLOAK_ISSUER: 'http://localhost:8080/realms/observability',
  KEYCLOAK_JWKS_URI: 'http://keycloak:8080/certs',
  KEYCLOAK_AUDIENCE: 'control-plane',
  KEYCLOAK_URL: 'http://keycloak:8080/',
  KEYCLOAK_REALM: 'observability',
  KEYCLOAK_ADMIN_CLIENT_ID: 'control-plane-admin',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 's',
  KEYCLOAK_PUBLIC_URL: 'http://kc.example:8080',
  OTEL_GATEWAY_PUBLIC_URL: 'http://otel.example:4318',
  GRAFANA_URL: 'http://grafana:3000',
  GRAFANA_ADMIN_USER: 'admin',
  GRAFANA_ADMIN_PASSWORD: 'p',
};

describe('AppConfig.fromEnv', () => {
  it('reads required values and applies defaults', () => {
    const config = AppConfig.fromEnv({ ...REQUIRED });

    expect(config.port).toBe(8080);
    expect(config.keycloak.url).toBe('http://keycloak:8080');
    expect(config.grafana.defaultTenant).toBe('admin-tenant');
    expect(config.supportAccess).toEqual({ maxMinutes: 480, sweepMs: 30000 });
    expect(config.outbox).toEqual({ workerEnabled: true, pollMs: 5000 });
    expect(config.enrollmentTtlMinutes).toBe(10);
    expect(config.logLevels).toEqual(['fatal', 'error', 'warn', 'log']);
  });

  it('LOG_LEVEL keeps the levels down to the one named', () => {
    expect(
      AppConfig.fromEnv({ ...REQUIRED, LOG_LEVEL: 'debug' }).logLevels,
    ).toEqual(['fatal', 'error', 'warn', 'log', 'debug']);
    expect(
      AppConfig.fromEnv({ ...REQUIRED, LOG_LEVEL: 'WARN' }).logLevels,
    ).toEqual(['fatal', 'error', 'warn']);
    expect(() => AppConfig.fromEnv({ ...REQUIRED, LOG_LEVEL: 'loud' })).toThrow(
      'LOG_LEVEL must be one of fatal, error, warn, log, debug, verbose',
    );
  });

  it('lists every problem at once', () => {
    let error: unknown;

    try {
      AppConfig.fromEnv({
        ...REQUIRED,
        DB_HOST: '',
        KEYCLOAK_URL: 'keycloak:8080',
        DB_PORT: 'abc',
        OUTBOX_WORKER_ENABLED: 'maybe',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      'DB_HOST is required',
      'DB_PORT must be a non-negative integer',
      'KEYCLOAK_URL must be an http(s) URL',
      'OUTBOX_WORKER_ENABLED must be true or false',
    ]);
  });

  it('keeps the platform admin password untrimmed', () => {
    const config = AppConfig.fromEnv({
      ...REQUIRED,
      PLATFORM_ADMIN_PASSWORD: ' spaced password ',
    });

    expect(config.platformAdmin.password).toBe(' spaced password ');
  });
});
