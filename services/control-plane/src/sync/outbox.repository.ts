import { Injectable } from '@nestjs/common';

import {
  DatabaseService,
  type Queryable,
} from '../database/database.service';

export type AggregateType = 'tenant' | 'user';

export interface OutboxEvent {
  id: string;
  aggregateType: AggregateType;
  aggregateId: string;
  attempts: number;
}

export interface OutboxStatus {
  pending: number;
  failing: number;
  oldestPendingSeconds: number | null;
  recentErrors: {
    aggregateType: AggregateType;
    aggregateId: string;
    attempts: number;
    lastError: string | null;
  }[];
}

interface EventRow {
  id: string;
  aggregate_type: AggregateType;
  aggregate_id: string;
  attempts: number;
}

/** Lease while a worker processes a claimed event. */
const LEASE_SECONDS = 120;

/** Retry delay: 5s, 10s, 20s ... capped at 10 minutes. */
export function retryDelaySeconds(
  attempts: number,
): number {
  return Math.min(
    5 * 2 ** Math.max(attempts - 1, 0),
    600,
  );
}

@Injectable()
export class OutboxRepository {
  constructor(
    private readonly db: DatabaseService,
  ) {}

  /**
   * Records "this aggregate changed, converge its mirrors".
   * Must be called with the transaction of the business change.
   * At most one pending event per aggregate (unique partial index):
   * a second enqueue only pulls the pending one forward.
   */
  async enqueue(
    q: Queryable,
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<void> {
    await q.query(
      `
      INSERT INTO outbox (
        aggregate_type,
        aggregate_id
      )
      VALUES ($1, $2)
      ON CONFLICT (aggregate_type, aggregate_id)
        WHERE processed_at IS NULL
      DO UPDATE SET
        next_attempt_at = LEAST(
          outbox.next_attempt_at,
          now()
        )
      `,
      [
        aggregateType,
        aggregateId,
      ],
    );
  }

  /**
   * Claims due events for this worker. FOR UPDATE SKIP LOCKED + lease
   * makes it safe to run several control-plane replicas.
   */
  async claim(
    limit: number,
  ): Promise<OutboxEvent[]> {
    const result =
      await this.db.query<EventRow>(
        `
        UPDATE outbox
        SET
          locked_until = now() + ($2 || ' seconds')::interval,
          attempts = attempts + 1
        WHERE id IN (
          SELECT id
          FROM outbox
          WHERE processed_at IS NULL
            AND next_attempt_at <= now()
            AND (
              locked_until IS NULL
              OR locked_until < now()
            )
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          id,
          aggregate_type,
          aggregate_id,
          attempts
        `,
        [
          limit,
          String(LEASE_SECONDS),
        ],
      );

    return result.rows.map((row) => ({
      id: String(row.id),
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      attempts: row.attempts,
    }));
  }

  async markDone(
    id: string,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE outbox
      SET
        processed_at = now(),
        locked_until = NULL,
        last_error = NULL
      WHERE id = $1
      `,
      [id],
    );
  }

  async markFailed(
    event: OutboxEvent,
    error: string,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE outbox
      SET
        locked_until = NULL,
        last_error = $2,
        next_attempt_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1
      `,
      [
        event.id,
        error.slice(0, 2000),
        String(
          retryDelaySeconds(
            event.attempts,
          ),
        ),
      ],
    );
  }

  /** Housekeeping: keep processed events for 7 days. */
  async purgeProcessed(): Promise<void> {
    await this.db.query(
      `
      DELETE FROM outbox
      WHERE processed_at < now() - interval '7 days'
      `,
    );
  }

  async status(): Promise<OutboxStatus> {
    const counts =
      await this.db.query<{
        pending: string;
        failing: string;
        oldest: string | null;
      }>(
        `
        SELECT
          count(*) AS pending,
          count(*) FILTER (WHERE attempts >= 3) AS failing,
          EXTRACT(EPOCH FROM now() - min(created_at)) AS oldest
        FROM outbox
        WHERE processed_at IS NULL
        `,
      );

    const errors =
      await this.db.query<{
        aggregate_type: AggregateType;
        aggregate_id: string;
        attempts: number;
        last_error: string | null;
      }>(
        `
        SELECT
          aggregate_type,
          aggregate_id,
          attempts,
          last_error
        FROM outbox
        WHERE processed_at IS NULL
          AND last_error IS NOT NULL
        ORDER BY attempts DESC
        LIMIT 10
        `,
      );

    const row = counts.rows[0];

    return {
      pending: Number(row?.pending ?? 0),
      failing: Number(row?.failing ?? 0),
      oldestPendingSeconds:
        row?.oldest === null || row?.oldest === undefined
          ? null
          : Math.round(Number(row.oldest)),
      recentErrors: errors.rows.map((e) => ({
        aggregateType: e.aggregate_type,
        aggregateId: e.aggregate_id,
        attempts: e.attempts,
        lastError: e.last_error,
      })),
    };
  }
}
