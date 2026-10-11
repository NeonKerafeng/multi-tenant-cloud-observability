import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import type { PoolClient } from 'pg';

import { DatabaseService } from '../common/db/database.service';
import { AppConfig } from '../config/app-config';

import { MIRROR_HANDLERS, type MirrorHandler } from './mirror';
import { type OutboxEvent, OutboxRepository } from './outbox.repository';

const BATCH_SIZE = 20;
const LISTENER_RETRY_MS = 5000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Drains the outbox and dispatches each event to the MirrorHandler of its
 * (target, aggregate).
 * - Event-driven: LISTEN outbox_new (trigger from migration 003); a short
 *   poll covers retries (next_attempt_at) and a lost LISTEN connection.
 * - Multi-replica safe: FOR UPDATE SKIP LOCKED + lease.
 * - A failing event never blocks the others (retry with backoff, visible in
 *   GET /sync/status and /metrics).
 * - An event re-enqueued while it ran is run again at once (I-30).
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);

  private readonly handlers = new Map<string, MirrorHandler>();

  private listener: PoolClient | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;

  private draining = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly config: AppConfig,
    @Inject(MIRROR_HANDLERS) handlers: MirrorHandler[],
  ) {
    for (const handler of handlers) {
      const key = `${handler.target}:${handler.aggregate}`;

      if (this.handlers.has(key)) {
        throw new Error(`Two mirror handlers for ${key}`);
      }

      this.handlers.set(key, handler);
    }
  }

  onApplicationBootstrap(): void {
    if (!this.config.outbox.workerEnabled) {
      this.logger.log('Outbox worker disabled');
      return;
    }

    void this.listen();

    this.pollTimer = setInterval(
      () => this.kick(),
      this.config.outbox.pollMs || 5000,
    );
    this.pollTimer.unref();

    this.purgeTimer = setInterval(() => {
      this.outbox
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

  private async process(event: OutboxEvent): Promise<void> {
    const handler = this.handlers.get(`${event.target}:${event.aggregateType}`);

    if (!handler) {
      this.logger.warn(
        `No mirror for ${event.target}:${event.aggregateType}; dropping event ${event.id}`,
      );
      await this.outbox.markDone(event);
      return;
    }

    try {
      await handler.sync(event.aggregateId);
    } catch (error) {
      this.logger.warn(
        `Sync ${event.target} ${event.aggregateType} ${event.aggregateId} failed (attempt ${event.attempts}): ${String(error)}`,
      );

      await this.outbox.markFailed(event, String(error)).catch(() => undefined);
      return;
    }

    if (!(await this.outbox.markDone(event))) {
      // Changed again while it was being synced: run it again now.
      this.rerun = true;
    }
  }

  private async listen(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      const client = await this.db.connectListener();

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
