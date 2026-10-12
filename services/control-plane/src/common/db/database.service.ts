import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

import { AppConfig } from '../../config/app-config';

/**
 * Anything that can run a query: the pool itself or a client inside a
 * transaction. Repositories accept it so one transaction can hold the
 * business change, the outbox event and an inline mirror write.
 */
export interface Queryable {
  query<T extends QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy, Queryable {
  private readonly pool: Pool;

  constructor(config: AppConfig) {
    this.pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.name,
      user: config.db.user,
      password: config.db.password,
      max: config.db.poolMax,
    });
  }

  query<T extends QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  /**
   * Runs fn inside BEGIN/COMMIT on one connection. Any thrown error rolls
   * the transaction back and is rethrown.
   */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await fn(client);

      await client.query('COMMIT');

      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs fn only while THIS process holds the session advisory lock `key`
   * (pg_try_advisory_lock on a dedicated connection, released after).
   * Another replica holding it → `{ acquired: false }`, fn not run.
   */
  async withAdvisoryLock<T>(
    key: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const client = await this.pool.connect();

    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [key],
      );

      if (!rows[0]?.locked) {
        return { acquired: false };
      }

      try {
        return { acquired: true, result: await fn() };
      } finally {
        await client
          .query('SELECT pg_advisory_unlock($1)', [key])
          .catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  /** Dedicated connection for LISTEN/NOTIFY; the caller releases it. */
  connectListener(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /** Readiness check. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres error helpers. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === 'string' ? constraint : undefined;
  }

  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
