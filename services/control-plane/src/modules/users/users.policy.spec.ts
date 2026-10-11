import type { Role } from '../../common/auth/actor';
import { ACTORS, user } from '../../common/testing/fixtures';

import { assertCanCreateUser, assertCanManageUser } from './users.policy';

const ALLOW = 'allow';
const DENY = 'deny';

function outcome(fn: () => void): string {
  try {
    fn();
    return ALLOW;
  } catch {
    return DENY;
  }
}

describe('users.policy — role matrix (CLAUDE.md §18.3.1)', () => {
  const actors = {
    'platform-admin': ACTORS.platformAdmin,
    'tenant-admin': ACTORS.alphaAdmin,
    viewer: ACTORS.alphaViewer,
  };

  it.each<[keyof typeof actors, Role, string]>([
    ['platform-admin', 'tenant-admin', ALLOW],
    ['platform-admin', 'viewer', ALLOW],
    ['platform-admin', 'platform-admin', DENY],
    ['tenant-admin', 'viewer', ALLOW],
    ['tenant-admin', 'tenant-admin', DENY],
    ['tenant-admin', 'platform-admin', DENY],
    ['viewer', 'viewer', DENY],
  ])('%s creating a %s → %s', (actor, role, expected) => {
    expect(outcome(() => assertCanCreateUser(actors[actor], role))).toBe(
      expected,
    );
  });

  it.each<[keyof typeof actors, Role, string]>([
    ['platform-admin', 'tenant-admin', ALLOW],
    ['platform-admin', 'viewer', ALLOW],
    ['platform-admin', 'platform-admin', DENY],
    ['tenant-admin', 'viewer', ALLOW],
    ['tenant-admin', 'tenant-admin', DENY],
    ['viewer', 'viewer', DENY],
  ])('%s managing a %s → %s', (actor, role, expected) => {
    expect(
      outcome(() => assertCanManageUser(actors[actor], user({ role }))),
    ).toBe(expected);
  });
});
