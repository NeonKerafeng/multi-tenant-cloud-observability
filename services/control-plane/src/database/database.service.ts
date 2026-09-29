import {
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import {
  Pool,
  QueryResult,
  QueryResultRow,
} from 'pg';

@Injectable()
export class DatabaseService
  implements OnModuleDestroy
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

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
