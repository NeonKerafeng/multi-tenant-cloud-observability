import type { DatabaseService } from '../common/db/database.service';
import { AppConfig } from '../config/app-config';

import type { Aggregate, MirrorHandler, Target } from './mirror';
import {
  type OutboxEvent,
  type OutboxRepository,
  retryDelaySeconds,
} from './outbox.repository';
import { OutboxWorker } from './outbox.worker';

function event(
  id: string,
  aggregateId: string,
  target: Target = 'grafana',
  aggregateType: Aggregate = 'user',
): OutboxEvent {
  return { id, target, aggregateType, aggregateId, attempts: 1, claimedSeq: 1 };
}

function handler(target: Target, aggregate: Aggregate) {
  return {
    target,
    aggregate,
    sync: jest.fn((id: string) =>
      id === 'bad'
        ? Promise.reject(new Error(`${target} down`))
        : Promise.resolve(),
    ),
  };
}

function setup(
  batches: OutboxEvent[][],
  done: (e: OutboxEvent) => boolean = () => true,
) {
  const outbox = {
    claim: jest.fn(() => Promise.resolve(batches.shift() ?? [])),
    markDone: jest.fn((e: OutboxEvent) => Promise.resolve(done(e))),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };

  const grafanaUser = handler('grafana', 'user');
  const keycloakUser = handler('keycloak', 'user');

  const worker = new OutboxWorker(
    {} as DatabaseService,
    outbox as unknown as OutboxRepository,
    AppConfig.forTest(),
    [grafanaUser, keycloakUser] as MirrorHandler[],
  );

  return { worker, outbox, grafanaUser, keycloakUser };
}

describe('OutboxWorker.drain', () => {
  it('dispatches each event to the handler of its target and aggregate', async () => {
    const { worker, grafanaUser, keycloakUser, outbox } = setup([
      [event('1', 'a', 'grafana'), event('2', 'a', 'keycloak')],
      [event('3', 'b', 'keycloak')],
    ]);

    await worker.drain();

    expect(grafanaUser.sync.mock.calls).toEqual([['a']]);
    expect(keycloakUser.sync.mock.calls).toEqual([['a'], ['b']]);
    expect(outbox.markDone).toHaveBeenCalledTimes(3);
  });

  it('a failing event is retried later and does not block the others', async () => {
    const { worker, outbox } = setup([[event('1', 'bad'), event('2', 'ok')]]);

    await worker.drain();

    expect(outbox.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1' }),
      expect.stringContaining('grafana down'),
    );
    expect(outbox.markDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: '2' }),
    );
  });

  it('an event without handler is dropped (markDone) instead of looping', async () => {
    const { worker, outbox } = setup([[event('1', 'x', 'keycloak', 'agent')]]);

    await worker.drain();

    expect(outbox.markDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1' }),
    );
  });

  it('claims again when an event changed while it was processed (I-30)', async () => {
    let first = true;

    const { worker, outbox } = setup(
      [[event('1', 'a')], [], [event('1', 'a')], []],
      () => {
        const result = !first;
        first = false;
        return result;
      },
    );

    await worker.drain();

    expect(outbox.markDone).toHaveBeenCalledTimes(2);
    expect(outbox.claim.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses two handlers for the same pair', () => {
    expect(
      () =>
        new OutboxWorker(
          {} as DatabaseService,
          {} as OutboxRepository,
          AppConfig.forTest(),
          [
            handler('grafana', 'user'),
            handler('grafana', 'user'),
          ] as MirrorHandler[],
        ),
    ).toThrow(/Two mirror handlers/);
  });
});

describe('retryDelaySeconds', () => {
  it('backs off exponentially and caps at 10 minutes', () => {
    expect([1, 2, 3, 4, 8, 50].map(retryDelaySeconds)).toEqual([
      5, 10, 20, 40, 600, 600,
    ]);
  });
});
