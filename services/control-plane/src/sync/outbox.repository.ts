import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../common/db/base.repository';
import type { Queryable } from '../common/db/database.service';

import {
  type Aggregate,
  ALL_TARGETS,
  MIRROR_TARGETS,
  type Target,
} from './mirror';

export interface OutboxEvent {
  id: string;
  target: Target;
  aggregateType: Aggregate;
  aggregateId: string;
  attempts: number;
  /** requested_seq at claim time (lost-update guard, I-30). */
  claimedSeq: number;
}

export interface TargetStatus {
  pending: number;
  failing: number;
  oldestPendingSeconds: number;
}

export interface OutboxStatus {
  targets: Record<Target, TargetStatus>;
  recentErrors: {
    target: Target;
    aggregateType: Aggregate;
    aggregateId: string;
    attempts: number;
    lastError: string | null;
  }[];
}

interface EventRow {
  id: string;
  target: Target;
  aggregate_type: Aggregate;
  aggregate_id: string;
  attempts: number;
  claimed_seq: string;
}

/** Lease while a worker processes a claimed event. */
export const LEASE_SECONDS = 120;

/** An event counts as failing from this many attempts. */
export const FAILING_ATTEMPTS = 3;

/** Retry delay: 5s, 10s, 20s ... capped at 10 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(5 * 2 ** Math.max(attempts - 1, 0), 600);
}

/**
 * Transactional outbox. At most ONE pending row per (target, aggregate):
 * a new enqueue on a pending row bumps `requested_seq` and pulls the row
 * forward. A worker remembers the seq it claimed; `markDone` only
 * finishes the row if nothing was enqueued meanwhile, otherwise the row
 * runs again at once (fixes I-30, lost update during processing).
 */
@Injectable()
export class OutboxRepository extends BaseRepository<EventRow, OutboxEvent> {
  /**
   * "This aggregate changed, converge its mirrors." Call it with the
   * transaction of the business change. `targets` narrows the fan-out
   * (default: every mirror interested in the aggregate).
   */
  async enqueue(
    q: Queryable,
    aggregateType: Aggregate,
    aggregateId: string,
    targets: readonly Target[] = MIRROR_TARGETS[aggregateType],
  ): Promise<void> {
    for (const target of targets) {
      await q.query(
        `INSERT INTO outbox (target, aggregate_type, aggregate_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (target, aggregate_type, aggregate_id) WHERE processed_at IS NULL
         DO UPDATE SET
           requested_seq = outbox.requested_seq + 1,
           next_attempt_at = LEAST(outbox.next_attempt_at, now())`,
        [target, aggregateType, aggregateId],
      );
    }
  }

  /** Claims due events (FOR UPDATE SKIP LOCKED + lease: multi-replica safe). */
  claim(limit: number): Promise<OutboxEvent[]> {
    return this.many(
      `UPDATE outbox
       SET locked_until = now() + make_interval(secs => $2),
           attempts = attempts + 1,
           claimed_seq = requested_seq
       WHERE id IN (
         SELECT id FROM outbox
         WHERE processed_at IS NULL
           AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, target, aggregate_type, aggregate_id, attempts, claimed_seq`,
      [limit, LEASE_SECONDS],
    );
  }

  /**
   * Returns true when the event is finished; false when the aggregate was
   * enqueued again while it was being processed (it is re-run at once).
   */
  async markDone(event: OutboxEvent): Promise<boolean> {
    const done = await this.exec(
      `UPDATE outbox
       SET processed_at = now(), locked_until = NULL, last_error = NULL
       WHERE id = $1 AND requested_seq = $2`,
      [event.id, event.claimedSeq],
    );

    if (done > 0) {
      return true;
    }

    await this.exec(
      `UPDATE outbox
       SET locked_until = NULL, next_attempt_at = now(), attempts = 0
       WHERE id = $1 AND processed_at IS NULL`,
      [event.id],
    );

    return false;
  }

  async markFailed(event: OutboxEvent, error: string): Promise<void> {
    await this.exec(
      `UPDATE outbox
       SET locked_until = NULL,
           last_error = $2,
           next_attempt_at = now() + make_interval(secs => $3)
       WHERE id = $1`,
      [event.id, error.slice(0, 2000), retryDelaySeconds(event.attempts)],
    );
  }

  /** Housekeeping: keep processed events for 7 days. */
  async purgeProcessed(): Promise<void> {
    await this.exec(
      `DELETE FROM outbox WHERE processed_at < now() - interval '7 days'`,
    );
  }

  async status(): Promise<OutboxStatus> {
    const counts = await this.db.query<{
      target: Target;
      pending: string;
      failing: string;
      oldest: string | null;
    }>(
      `SELECT target,
              count(*) AS pending,
              count(*) FILTER (WHERE attempts >= $1) AS failing,
              EXTRACT(EPOCH FROM now() - min(created_at)) AS oldest
       FROM outbox
       WHERE processed_at IS NULL
       GROUP BY target`,
      [FAILING_ATTEMPTS],
    );

    const errors = await this.db.query<{
      target: Target;
      aggregate_type: Aggregate;
      aggregate_id: string;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT target, aggregate_type, aggregate_id, attempts, last_error
       FROM outbox
       WHERE processed_at IS NULL AND last_error IS NOT NULL
       ORDER BY attempts DESC
       LIMIT 10`,
    );

    const targets = Object.fromEntries(
      ALL_TARGETS.map((target) => [
        target,
        { pending: 0, failing: 0, oldestPendingSeconds: 0 },
      ]),
    ) as Record<Target, TargetStatus>;

    for (const row of counts.rows) {
      targets[row.target] = {
        pending: Number(row.pending),
        failing: Number(row.failing),
        oldestPendingSeconds:
          row.oldest === null ? 0 : Math.round(Number(row.oldest)),
      };
    }

    return {
      targets,
      recentErrors: errors.rows.map((row) => ({
        target: row.target,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        attempts: row.attempts,
        lastError: row.last_error,
      })),
    };
  }

  protected map(row: EventRow): OutboxEvent {
    return {
      id: String(row.id),
      target: row.target,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      attempts: row.attempts,
      claimedSeq: Number(row.claimed_seq),
    };
  }
}
