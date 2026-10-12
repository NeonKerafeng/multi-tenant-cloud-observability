/**
 * Typed, validated configuration, loaded ONCE from the environment.
 *
 * Replaces @nestjs/config (ESM-only since v12, which forced jest.mock in
 * every spec). Tests build it directly: `new AppConfig({...})` or
 * `AppConfig.forTest({...overrides})`.
 */

import type { LogLevel } from '@nestjs/common';

/** From the most to the least severe; LOG_LEVEL keeps a prefix of it. */
export const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

export interface AppConfigValues {
  port: number;

  /** LOG_LEVEL (default `log`): `debug` also shows debug lines. */
  logLevels: LogLevel[];

  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMax: number;
  };

  keycloak: {
    /** Expected `iss` of human access tokens. */
    issuer: string;
    jwksUri: string;
    /** Expected `aud` of human access tokens. */
    audience: string;
    /** Base URL for the admin API (in-cluster). */
    url: string;
    realm: string;
    adminClientId: string;
    adminClientSecret: string;
    /** Base URL that enrolled hosts use to fetch tokens. */
    publicUrl: string;
  };

  otelGatewayPublicUrl: string;

  grafana: {
    url: string;
    adminUser: string;
    adminPassword: string;
    /** Tenant that owns Grafana org 1 (platform admins live there). */
    defaultTenant: string;
  };

  queryGatewayUrl: string;

  platformAdmin: {
    username: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  };

  supportAccess: {
    maxMinutes: number;
    sweepMs: number;
  };

  resyncIntervalMs: number;

  outbox: {
    workerEnabled: boolean;
    pollMs: number;
  };

  upstreamTimeoutMs: number;

  enrollmentTtlMinutes: number;

  /** Public exchange limits per pod (0 = no limit). */
  enrollmentExchange: {
    perIpPerMinute: number;
    perMinute: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export class AppConfig implements AppConfigValues {
  declare readonly port: number;
  declare readonly logLevels: LogLevel[];
  declare readonly db: AppConfigValues['db'];
  declare readonly keycloak: AppConfigValues['keycloak'];
  declare readonly otelGatewayPublicUrl: string;
  declare readonly grafana: AppConfigValues['grafana'];
  declare readonly queryGatewayUrl: string;
  declare readonly platformAdmin: AppConfigValues['platformAdmin'];
  declare readonly supportAccess: AppConfigValues['supportAccess'];
  declare readonly resyncIntervalMs: number;
  declare readonly outbox: AppConfigValues['outbox'];
  declare readonly upstreamTimeoutMs: number;
  declare readonly enrollmentTtlMinutes: number;
  declare readonly enrollmentExchange: AppConfigValues['enrollmentExchange'];

  constructor(values: AppConfigValues) {
    Object.assign(this, values);
  }

  /** Reads and validates process.env; lists EVERY problem at once. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const reader = new EnvReader(env);

    const values: AppConfigValues = {
      port: reader.int('PORT', 8080),

      logLevels: reader.logLevels('LOG_LEVEL', 'log'),

      db: {
        host: reader.required('DB_HOST'),
        port: reader.int('DB_PORT', 5432),
        name: reader.required('DB_NAME'),
        user: reader.required('DB_USER'),
        password: reader.required('DB_PASSWORD'),
        poolMax: reader.int('DB_POOL_MAX', 10),
      },

      keycloak: {
        issuer: reader.required('KEYCLOAK_ISSUER'),
        jwksUri: reader.required('KEYCLOAK_JWKS_URI'),
        audience: reader.required('KEYCLOAK_AUDIENCE'),
        url: reader.url('KEYCLOAK_URL'),
        realm: reader.required('KEYCLOAK_REALM'),
        adminClientId: reader.required('KEYCLOAK_ADMIN_CLIENT_ID'),
        adminClientSecret: reader.required('KEYCLOAK_ADMIN_CLIENT_SECRET'),
        publicUrl: reader.url('KEYCLOAK_PUBLIC_URL'),
      },

      otelGatewayPublicUrl: reader.required('OTEL_GATEWAY_PUBLIC_URL'),

      grafana: {
        url: reader.url('GRAFANA_URL'),
        adminUser: reader.required('GRAFANA_ADMIN_USER'),
        adminPassword: reader.required('GRAFANA_ADMIN_PASSWORD'),
        defaultTenant: reader.optional(
          'GRAFANA_DEFAULT_TENANT',
          'admin-tenant',
        ),
      },

      queryGatewayUrl: reader.optional(
        'QUERY_GATEWAY_URL',
        'http://query-gateway:8080',
      ),

      platformAdmin: {
        username: reader.optional('PLATFORM_ADMIN_USERNAME', ''),
        email: reader.optional('PLATFORM_ADMIN_EMAIL', ''),
        password: reader.optional('PLATFORM_ADMIN_PASSWORD', '', false),
        firstName: reader.optional('PLATFORM_ADMIN_FIRST_NAME', 'Platform'),
        lastName: reader.optional('PLATFORM_ADMIN_LAST_NAME', 'Admin'),
      },

      supportAccess: {
        maxMinutes: reader.int('SUPPORT_ACCESS_MAX_MINUTES', 8 * 60),
        sweepMs: reader.int('SUPPORT_ACCESS_SWEEP_MS', 30 * 1000),
      },

      resyncIntervalMs: reader.int(
        'GRAFANA_RESYNC_INTERVAL_MS',
        60 * 60 * 1000,
      ),

      outbox: {
        workerEnabled: reader.bool('OUTBOX_WORKER_ENABLED', true),
        pollMs: reader.int('OUTBOX_POLL_MS', 5000),
      },

      upstreamTimeoutMs: reader.int('UPSTREAM_TIMEOUT_MS', 10 * 1000),

      enrollmentTtlMinutes: reader.int('ENROLLMENT_TTL_MINUTES', 10, 1),

      enrollmentExchange: {
        perIpPerMinute: reader.int('ENROLLMENT_EXCHANGE_PER_IP_PER_MINUTE', 10),
        perMinute: reader.int('ENROLLMENT_EXCHANGE_PER_MINUTE', 100),
      },
    };

    reader.throwIfProblems();

    return new AppConfig(values);
  }

  /** Complete, valid config for unit tests. */
  static forTest(overrides: Partial<AppConfigValues> = {}): AppConfig {
    return new AppConfig({
      port: 8080,
      logLevels: ['fatal', 'error', 'warn', 'log'],
      db: {
        host: 'db',
        port: 5432,
        name: 'mtco',
        user: 'mtco',
        password: 'pw',
        poolMax: 2,
      },
      keycloak: {
        issuer: 'http://localhost:8080/realms/observability',
        jwksUri:
          'http://keycloak:8080/realms/observability/protocol/openid-connect/certs',
        audience: 'control-plane',
        url: 'http://keycloak:8080',
        realm: 'observability',
        adminClientId: 'control-plane-admin',
        adminClientSecret: 'secret',
        publicUrl: 'http://kc.example:8080',
      },
      otelGatewayPublicUrl: 'http://otel.example:4318',
      grafana: {
        url: 'http://grafana:3000',
        adminUser: 'admin',
        adminPassword: 'pw',
        defaultTenant: 'admin-tenant',
      },
      queryGatewayUrl: 'http://query-gateway:8080',
      platformAdmin: {
        username: '',
        email: '',
        password: '',
        firstName: 'Platform',
        lastName: 'Admin',
      },
      supportAccess: { maxMinutes: 480, sweepMs: 0 },
      resyncIntervalMs: 0,
      outbox: { workerEnabled: false, pollMs: 5000 },
      upstreamTimeoutMs: 1000,
      enrollmentTtlMinutes: 10,
      enrollmentExchange: { perIpPerMinute: 10, perMinute: 100 },
      ...overrides,
    });
  }
}

class EnvReader {
  private readonly problems: string[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  required(key: string): string {
    const value = this.env[key]?.trim();

    if (!value) {
      this.problems.push(`${key} is required`);
      return '';
    }

    return value;
  }

  optional(key: string, fallback: string, trim = true): string {
    const raw = this.env[key];

    if (raw === undefined || raw === '') {
      return fallback;
    }

    return trim ? raw.trim() : raw;
  }

  url(key: string): string {
    const value = this.required(key);

    if (value && !/^https?:\/\/[^/]/.test(value)) {
      this.problems.push(`${key} must be an http(s) URL`);
    }

    return value.replace(/\/+$/, '');
  }

  int(key: string, fallback: number, min = 0): number {
    const raw = this.env[key]?.trim();

    if (raw === undefined || raw === '') {
      return fallback;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value < min) {
      this.problems.push(
        min === 0
          ? `${key} must be a non-negative integer`
          : `${key} must be an integer >= ${min}`,
      );
      return fallback;
    }

    return value;
  }

  bool(key: string, fallback: boolean): boolean {
    const raw = this.env[key]?.trim().toLowerCase();

    if (raw === undefined || raw === '') {
      return fallback;
    }

    if (raw === 'true' || raw === '1') {
      return true;
    }

    if (raw === 'false' || raw === '0') {
      return false;
    }

    this.problems.push(`${key} must be true or false`);
    return fallback;
  }

  /** `warn` → fatal, error, warn. */
  logLevels(key: string, fallback: LogLevel): LogLevel[] {
    const raw = (this.env[key]?.trim().toLowerCase() || fallback) as LogLevel;
    const index = LOG_LEVELS.indexOf(raw);

    if (index < 0) {
      this.problems.push(`${key} must be one of ${LOG_LEVELS.join(', ')}`);
      return LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(fallback) + 1);
    }

    return LOG_LEVELS.slice(0, index + 1);
  }

  throwIfProblems(): void {
    if (this.problems.length > 0) {
      throw new ConfigError(this.problems);
    }
  }
}
