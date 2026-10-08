jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

import type { ConfigService } from '@nestjs/config';

import type { DatabaseService } from '../database/database.service';

import type { GrafanaSyncService } from './grafana-sync.service';
import {
  type OutboxEvent,
  type OutboxRepository,
  retryDelaySeconds,
} from './outbox.repository';
import { OutboxWorker } from './outbox.worker';

function event(id: string, aggregateId: string): OutboxEvent {
  return { id, aggregateType: 'user', aggregateId, attempts: 1 };
}

function setup(batches: OutboxEvent[][]) {
  const outbox = {
    claim: jest.fn(() => Promise.resolve(batches.shift() ?? [])),
    markDone: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };

  const sync = {
    handle: jest.fn((_type: string, id: string) =>
      id === 'bad' ? Promise.reject(new Error('grafana down')) : Promise.resolve(),
    ),
  };

  const worker = new OutboxWorker(
    {} as DatabaseService,
    outbox as unknown as OutboxRepository,
    sync as unknown as GrafanaSyncService,
    { get: jest.fn() } as unknown as ConfigService,
  );

  return { worker, outbox, sync };
}

describe('OutboxWorker.drain', () => {
  it('processes every batch until the outbox is empty', async () => {
    const { worker, outbox, sync } = setup([
      [event('1', 'a'), event('2', 'b')],
      [event('3', 'c')],
    ]);

    await worker.drain();

    expect(sync.handle).toHaveBeenCalledTimes(3);
    expect(outbox.markDone.mock.calls.map((c: unknown[]) => c[0])).toEqual(['1', '2', '3']);
    expect(outbox.claim).toHaveBeenCalledTimes(3);
  });

  it('a failing event is marked for retry and does not block the others', async () => {
    const { worker, outbox } = setup([[event('1', 'bad'), event('2', 'ok')]]);

    await worker.drain();

    expect(outbox.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1' }),
      expect.stringContaining('grafana down'),
    );
    expect(outbox.markDone).toHaveBeenCalledWith('2');
  });
});

describe('retryDelaySeconds', () => {
  it('backs off exponentially and caps at 10 minutes', () => {
    expect([1, 2, 3, 4, 8, 50].map(retryDelaySeconds)).toEqual([
      5, 10, 20, 40, 600, 600,
    ]);
  });
});
