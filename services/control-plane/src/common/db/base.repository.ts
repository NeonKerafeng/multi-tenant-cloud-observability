import { Injectable } from '@nestjs/common';

import type { QueryResultRow } from 'pg';

import { DatabaseService, type Queryable } from './database.service';

/**
 * Parent of every repository: raw parameterised SQL, snake_case rows
 * mapped to camelCase records by the subclass. Every method takes an
 * optional Queryable so it can run inside the caller's transaction.
 */
@Injectable()
export abstract class BaseRepository<Row extends QueryResultRow, Rec> {
  constructor(protected readonly db: DatabaseService) {}

  protected abstract map(row: Row): Rec;

  protected async one(
    sql: string,
    params: unknown[] = [],
    q: Queryable = this.db,
  ): Promise<Rec | null> {
    const result = await q.query<Row>(sql, params);
    const row = result.rows[0];

    return row ? this.map(row) : null;
  }

  protected async many(
    sql: string,
    params: unknown[] = [],
    q: Queryable = this.db,
  ): Promise<Rec[]> {
    const result = await q.query<Row>(sql, params);

    return result.rows.map((row) => this.map(row));
  }

  /** Returns the affected row count. */
  protected async exec(
    sql: string,
    params: unknown[] = [],
    q: Queryable = this.db,
  ): Promise<number> {
    const result = await q.query(sql, params);

    return result.rowCount ?? 0;
  }

  /** `RETURNING id` (or any single text column named `id`). */
  protected async ids(
    sql: string,
    params: unknown[] = [],
    q: Queryable = this.db,
  ): Promise<string[]> {
    const result = await q.query<{ id: string }>(sql, params);

    return result.rows.map((row) => String(row.id));
  }
}
