import type { DatabaseService } from '../../common/db/database.service';
import {
  ACTORS,
  fakeDb,
  IDS,
  tenant,
  user,
} from '../../common/testing/fixtures';
import type { KeycloakUserMirror } from '../../mirrors/keycloak/keycloak-user.mirror';
import type { OutboxRepository } from '../../sync/outbox.repository';

import type { CreateUserDto } from './dto';
import type { UserRecord, UserRepository } from './user.repository';
import { UsersService } from './users.service';

const dto: CreateUserDto = {
  username: 'bob',
  password: 'pw-123456',
  firstName: 'Bob',
  lastName: 'B',
  email: 'bob@example.com',
  role: 'viewer',
};

function setup(
  opts: { insertError?: unknown; found?: UserRecord | null } = {},
) {
  const { db, tx } = fakeDb();

  const created = user({ id: 'new-id', username: 'bob', keycloakUserId: null });

  const users = {
    insert: jest.fn(() =>
      opts.insertError
        ? Promise.reject(opts.insertError as Error)
        : Promise.resolve(created),
    ),
    findById: jest
      .fn()
      .mockResolvedValue({ ...created, keycloakUserId: 'kc-new' }),
    findActiveInTenant: jest
      .fn()
      .mockResolvedValue(opts.found === undefined ? user() : opts.found),
    listActiveByTenant: jest.fn().mockResolvedValue([user()]),
    setEnabled: jest.fn().mockResolvedValue(undefined),
    markDeleted: jest.fn().mockResolvedValue(undefined),
  };

  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const keycloakUsers = { apply: jest.fn().mockResolvedValue('kc-new') };

  const service = new UsersService(
    db as unknown as DatabaseService,
    users as unknown as UserRepository,
    outbox as unknown as OutboxRepository,
    keycloakUsers as unknown as KeycloakUserMirror,
  );

  return { service, users, outbox, keycloakUsers, tx, created };
}

describe('UsersService.create', () => {
  it('row + inline Keycloak account (with password) + outbox in one transaction', async () => {
    const { service, users, keycloakUsers, outbox, tx, created } = setup();

    const view = await service.create(ACTORS.alphaAdmin, tenant(), dto);

    expect(users.insert).toHaveBeenCalledWith(tx, {
      tenantId: IDS.alpha,
      username: 'bob',
      email: 'bob@example.com',
      firstName: 'Bob',
      lastName: 'B',
      role: 'viewer',
    });
    expect(keycloakUsers.apply).toHaveBeenCalledWith(created, {
      password: 'pw-123456',
      q: tx,
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'user', 'new-id');
    expect(view).toMatchObject({
      id: 'new-id',
      username: 'bob',
      role: 'viewer',
    });
    expect(view).not.toHaveProperty('password');
  });

  it('a tenant admin cannot create a tenant admin', async () => {
    const { service, users } = setup();

    await expect(
      service.create(ACTORS.alphaAdmin, tenant(), {
        ...dto,
        role: 'tenant-admin',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(users.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['uq_users_active_username', 'username_taken'],
    ['uq_users_active_email', 'email_taken'],
  ])('unique violation %s → 409 %s', async (constraint, code) => {
    const { service, keycloakUsers } = setup({
      insertError: Object.assign(new Error('dup'), {
        code: '23505',
        constraint,
      }),
    });

    await expect(
      service.create(ACTORS.platformAdmin, tenant(), dto),
    ).rejects.toMatchObject({
      code,
      status: 409,
    });
    expect(keycloakUsers.apply).not.toHaveBeenCalled();
  });

  it('a Keycloak failure propagates (the transaction rolls back)', async () => {
    const { service, keycloakUsers, outbox } = setup();
    keycloakUsers.apply.mockRejectedValue(new Error('keycloak down'));

    await expect(
      service.create(ACTORS.platformAdmin, tenant(), dto),
    ).rejects.toThrow('keycloak down');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('UsersService.update / delete', () => {
  it('disable = DB change + outbox (mirrors do the rest)', async () => {
    const { service, users, outbox, tx } = setup();

    await service.update(ACTORS.alphaAdmin, tenant(), IDS.alphaViewer, {
      enabled: false,
    });

    expect(users.setEnabled).toHaveBeenCalledWith(tx, IDS.alphaViewer, false);
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'user', IDS.alphaViewer);
  });

  it('no change → no write', async () => {
    const { service, users } = setup();

    await service.update(ACTORS.alphaAdmin, tenant(), IDS.alphaViewer, {
      enabled: true,
    });

    expect(users.setEnabled).not.toHaveBeenCalled();
  });

  it('a tenant admin cannot disable another tenant admin', async () => {
    const { service } = setup({ found: user({ role: 'tenant-admin' }) });

    await expect(
      service.update(ACTORS.alphaAdmin, tenant(), IDS.alphaViewer, {
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('delete = soft delete + outbox', async () => {
    const { service, users, outbox, tx } = setup();

    await service.delete(ACTORS.platformAdmin, tenant(), IDS.alphaViewer);

    expect(users.markDeleted).toHaveBeenCalledWith(tx, IDS.alphaViewer);
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'user', IDS.alphaViewer);
  });

  it.each(['not-a-uuid', IDS.betaAdmin])(
    'unknown or foreign user %s → 404',
    async (id) => {
      const { service, users } = setup({ found: null });

      await expect(
        service.get(ACTORS.alphaAdmin, tenant(), id),
      ).rejects.toMatchObject({
        code: 'user_not_found',
      });

      if (id === 'not-a-uuid') {
        expect(users.findActiveInTenant).not.toHaveBeenCalled();
      }
    },
  );
});
