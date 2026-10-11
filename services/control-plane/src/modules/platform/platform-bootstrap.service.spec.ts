import { user } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type { UserRecord, UserRepository } from '../users/user.repository';
import type { UsersService } from '../users/users.service';

import { PlatformBootstrapService } from './platform-bootstrap.service';

const ADMIN = {
  username: 'Root-Admin',
  email: 'root@example.com',
  password: 'a-long-password',
  firstName: 'Platform',
  lastName: 'Admin',
};

function setup(opts: {
  admin?: Partial<typeof ADMIN>;
  activeAdmins?: number;
  known?: UserRecord | null;
}) {
  const users = {
    countActivePlatformAdmins: jest
      .fn()
      .mockResolvedValue(opts.activeAdmins ?? 0),
    findLatestByUsername: jest.fn().mockResolvedValue(opts.known ?? null),
  };

  const usersService = {
    createPlatformAdmin: jest.fn().mockResolvedValue(user()),
  };

  const service = new PlatformBootstrapService(
    users as unknown as UserRepository,
    usersService as unknown as UsersService,
    AppConfig.forTest({ platformAdmin: { ...ADMIN, ...opts.admin } }),
  );

  return { service, users, usersService };
}

describe('PlatformBootstrapService.run', () => {
  it('creates the initial admin through the normal user path (lowercased)', async () => {
    const { service, usersService } = setup({});

    await expect(service.run()).resolves.toBe('created');
    expect(usersService.createPlatformAdmin).toHaveBeenCalledWith({
      ...ADMIN,
      username: 'root-admin',
    });
  });

  it('does nothing when an active platform admin exists (restart is idempotent)', async () => {
    const { service, usersService } = setup({ activeAdmins: 1 });

    await expect(service.run()).resolves.toBe('exists');
    expect(usersService.createPlatformAdmin).not.toHaveBeenCalled();
  });

  it('skips when not configured', async () => {
    const { service } = setup({ admin: { username: '' } });

    await expect(service.run()).resolves.toBe('skipped');
  });

  it.each([
    ['a short password', { password: 'short' }, null],
    ['a missing email', { email: '' }, null],
    [
      'a username of a tenant user',
      {},
      user({ username: 'root-admin', role: 'viewer' }),
    ],
    [
      'a deleted initial admin',
      {},
      user({
        username: 'root-admin',
        role: 'platform-admin',
        status: 'deleted',
      }),
    ],
  ])('refuses %s', async (_label, admin, known) => {
    const { service, usersService } = setup({ admin, known });

    await expect(service.run()).resolves.toBe('refused');
    expect(usersService.createPlatformAdmin).not.toHaveBeenCalled();
  });
});
