import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

import { GrafanaSyncService } from './grafana-sync.service';

import {
  type OutboxEvent,
  OutboxRepository,
} from './outbox.repository';

const BATCH_SIZE = 20;
const DEFAULT_POLL_MS = 5000;
const LISTENER_RETRY_MS = 5000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Drains the outbox.
 *
 * - Event-driven: LISTEN outbox_new wakes it the moment an event is
 *   committed (trigger in migration 003).
 * - A short poll is the fallback for retries (next_attempt_at) and for a
 *   lost LISTEN connection.
 * - Safe with several control-plane replicas: events are claimed with
 *   FOR UPDATE SKIP LOCKED + a lease.
 * - A failing event never blocks the others; it is retried with backoff
 *   and visible in GET /sync/status.
 */
@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger =
    new Logger(OutboxWorker.name);

  private listener: PoolClient | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;

  private draining = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly sync: GrafanaSyncService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (
      this.config.get<string>('OUTBOX_WORKER_ENABLED') === 'false'
    ) {
      this.logger.log('Outbox worker disabled');
      return;
    }

    void this.listen();

    this.pollTimer = setInterval(
      () => this.kick(),
      Number(
        this.config.get<string>('OUTBOX_POLL_MS') ?? DEFAULT_POLL_MS,
      ) || DEFAULT_POLL_MS,
    );
    this.pollTimer.unref();

    this.purgeTimer = setInterval(() => {
      void this.outbox
        .purgeProcessed()
        .catch((error) =>
          this.logger.warn(`Outbox purge failed: ${String(error)}`),
        );
    }, PURGE_EVERY_MS);
    this.purgeTimer.unref();

    this.kick();
  }

  onModuleDestroy(): void {
    this.stopped = true;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);

    this.releaseListener();
  }

  /** Requests a drain; coalesces while one is running. */
  kick(): void {
    if (this.stopped) {
      return;
    }

    if (this.draining) {
      this.rerun = true;
      return;
    }

    void this.drain();
  }

  /** Processes due events until none are left. Exposed for tests. */
  async drain(): Promise<void> {
    this.draining = true;

    try {
      do {
        this.rerun = false;

        let batch: OutboxEvent[];

        while (
          !this.stopped &&
          (batch = await this.outbox.claim(BATCH_SIZE)).length > 0
        ) {
          for (const event of batch) {
            await this.process(event);
          }
        }
      } while (this.rerun && !this.stopped);
    } catch (error) {
      this.logger.warn(`Outbox drain failed: ${String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  private async process(
    event: OutboxEvent,
  ): Promise<void> {
    try {
      await this.sync.handle(
        event.aggregateType,
        event.aggregateId,
      );

      await this.outbox.markDone(event.id);
    } catch (error) {
      this.logger.warn(
        `Sync ${event.aggregateType} ${event.aggregateId} failed (attempt ${event.attempts}): ${String(error)}`,
      );

      await this.outbox
        .markFailed(event, String(error))
        .catch(() => undefined);
    }
  }

  private async listen(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      const client =
        await this.db.connectListener();

      client.on('notification', () => this.kick());

      client.on('error', (error) => {
        this.logger.warn(`Outbox LISTEN connection lost: ${String(error)}`);
        this.releaseListener();
        setTimeout(() => void this.listen(), LISTENER_RETRY_MS).unref();
      });

      await client.query('LISTEN outbox_new');

      this.listener = client;
    } catch (error) {
      this.logger.warn(`Outbox LISTEN failed: ${String(error)}`);
      setTimeout(() => void this.listen(), LISTENER_RETRY_MS).unref();
    }
  }

  private releaseListener(): void {
    const client = this.listener;
    this.listener = null;

    if (client) {
      try {
        client.release(true);
      } catch {
        // already released / pool closed
      }
    }
  }
}
