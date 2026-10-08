import {
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg';

/**
 * Anything that can run a query: the pool itself or a client inside
 * a transaction. Repositories accept it so callers can compose several
 * writes (business change + outbox event) in ONE transaction.
 */
export interface Queryable {
  query<T extends QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

@Injectable()
export class DatabaseService
  implements OnModuleDestroy, Queryable
{
  private readonly pool: Pool;

  constructor(
    private readonly config: ConfigService,
  ) {
    this.pool = new Pool({
      host:
        this.config.getOrThrow<string>(
          'DB_HOST',
        ),

      port: Number(
        this.config.get<string>(
          'DB_PORT',
          '5432',
        ),
      ),

      database:
        this.config.getOrThrow<string>(
          'DB_NAME',
        ),

      user:
        this.config.getOrThrow<string>(
          'DB_USER',
        ),

      password:
        this.config.getOrThrow<string>(
          'DB_PASSWORD',
        ),

      max: 10,
    });
  }

  query<T extends QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(
      text,
      params,
    );
  }

  /**
   * Runs fn inside BEGIN/COMMIT on a single connection.
   * Any thrown error rolls the transaction back and is rethrown.
   */
  async transaction<T>(
    fn: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    const client =
      await this.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await fn(client);

      await client.query('COMMIT');

      return result;
    } catch (error) {
      await client
        .query('ROLLBACK')
        .catch(() => undefined);

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Dedicated connection for LISTEN/NOTIFY. The caller owns it and
   * must call release() when done.
   */
  async connectListener(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
