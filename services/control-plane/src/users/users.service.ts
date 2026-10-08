import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-user';

import {
  TenantRepository,
} from '../tenants/tenant.repository';

import type {
  TenantRecord,
} from '../tenants/tenant.repository';

import { DatabaseService } from '../database/database.service';
import { OutboxRepository } from '../sync/outbox.repository';

import { KeycloakUsersService } from './keycloak-users.service';
import { UserRepository } from './user.repository';

import type {
  HumanRole,
  ManagedHumanUser,
} from './keycloak-users.service';

export interface CreateUserInput {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'tenant-admin' | 'viewer';
}

@Injectable()
export class UsersService {
  constructor(
    private readonly tenants:
      TenantRepository,

    private readonly keycloakUsers:
      KeycloakUsersService,

    private readonly db:
      DatabaseService,

    private readonly users:
      UserRepository,

    private readonly outbox:
      OutboxRepository,
  ) {}

  async list(
    actor: AuthUser,
    tenantId: string,
  ) {
    const tenant =
      await this.requireTenantAccess(
        actor,
        tenantId,
      );

    return this.keycloakUsers
      .listUsersInGroup(
        tenant.keycloakGroupId!,
      );
  }

  async get(
    actor: AuthUser,
    tenantId: string,
    userId: string,
  ) {
    const tenant =
      await this.requireTenantAccess(
        actor,
        tenantId,
      );

    const user =
      await this.keycloakUsers
        .getUserInGroup(
          userId,
          tenant.keycloakGroupId!,
        );

    if (!user) {
      throw new NotFoundException(
        'User not found',
      );
    }

    return user;
  }

  async create(
    actor: AuthUser,
    tenantId: string,
    input: CreateUserInput,
  ) {
    const tenant =
      await this.requireTenantAccess(
        actor,
        tenantId,
      );

    this.validateCreateInput(
      input,
    );

    this.assertCanCreateRole(
      actor,
      input.role,
    );

    const created =
      await this.keycloakUsers
        .createUser({
          groupId:
            tenant.keycloakGroupId!,

          username:
            input.username.trim(),

          password:
            input.password,

          firstName:
            input.firstName.trim(),

          lastName:
            input.lastName.trim(),

          email:
            input.email.trim(),

          role:
            input.role,
        });

    /*
     * Record the user (source of truth) + "mirror into Grafana" in ONE
     * transaction. If that fails, undo the Keycloak user so the two never
     * disagree.
     */
    try {
      await this.db.transaction(
        async (tx) => {
          const id =
            await this.users.upsertActive(
              tx,
              {
                keycloakUserId: created.id,
                username: created.username,
                email: created.email ?? input.email.trim(),
                enabled: created.enabled,
              },
              tenant.id,
              input.role,
            );

          await this.outbox.enqueue(
            tx,
            'user',
            id,
          );
        },
      );
    } catch (error) {
      await this.keycloakUsers
        .deleteUserInGroup(
          created.id,
          tenant.keycloakGroupId!,
        )
        .catch(() => undefined);

      throw error;
    }

    return created;
  }

  async disable(
    actor: AuthUser,
    tenantId: string,
    userId: string,
  ) {
    return this.setEnabled(
      actor,
      tenantId,
      userId,
      false,
    );
  }

  async enable(
    actor: AuthUser,
    tenantId: string,
    userId: string,
  ) {
    return this.setEnabled(
      actor,
      tenantId,
      userId,
      true,
    );
  }

  async delete(
    actor: AuthUser,
    tenantId: string,
    userId: string,
  ) {
    const tenant =
      await this.requireTenantAccess(
        actor,
        tenantId,
      );

    const target =
      await this.requireTargetUser(
        userId,
        tenant.keycloakGroupId!,
      );

    this.assertCanManageTarget(
      actor,
      target,
    );

    const deleted =
      await this.keycloakUsers
        .deleteUserInGroup(
          userId,
          tenant.keycloakGroupId!,
        );

    if (!deleted) {
      throw new NotFoundException(
        'User not found',
      );
    }

    await this.db.transaction(
      async (tx) => {
        const id =
          await this.users.markDeleted(
            tx,
            userId,
          );

        if (id) {
          await this.outbox.enqueue(
            tx,
            'user',
            id,
          );
        }
      },
    );

    return {
      userId,
      deleted: true,
    };
  }

  private async setEnabled(
    actor: AuthUser,
    tenantId: string,
    userId: string,
    enabled: boolean,
  ) {
    const tenant =
      await this.requireTenantAccess(
        actor,
        tenantId,
      );

    const target =
      await this.requireTargetUser(
        userId,
        tenant.keycloakGroupId!,
      );

    this.assertCanManageTarget(
      actor,
      target,
    );

    const updated =
      await this.keycloakUsers
        .setUserEnabled(
          userId,
          tenant.keycloakGroupId!,
          enabled,
        );

    if (!updated) {
      throw new NotFoundException(
        'User not found',
      );
    }

    await this.db.transaction(
      async (tx) => {
        /*
         * Users created before the users table existed are adopted here
         * (target role is tenant-admin or viewer, enforced above).
         */
        const id =
          (await this.users.setEnabled(
            tx,
            userId,
            enabled,
          )) ??
          (await this.users.upsertActive(
            tx,
            {
              keycloakUserId: updated.id,
              username: updated.username,
              email: updated.email ?? '',
              enabled: updated.enabled,
            },
            tenant.id,
            target.role as 'tenant-admin' | 'viewer',
          ));

        await this.outbox.enqueue(
          tx,
          'user',
          id,
        );
      },
    );

    return updated;
  }

  private async requireTenantAccess(
    actor: AuthUser,
    tenantId: string,
  ): Promise<TenantRecord> {
    const tenant =
      await this.tenants.findByKey(
        tenantId,
      );

    if (
      !tenant ||
      tenant.status !== 'active'
    ) {
      throw new NotFoundException(
        'Tenant not found',
      );
    }

    if (!tenant.keycloakGroupId) {
      throw new ConflictException(
        'Tenant is not linked to a Keycloak group',
      );
    }

    if (
      actor.roles.includes(
        'platform-admin',
      )
    ) {
      return tenant;
    }

    if (
      !actor.roles.includes(
        'tenant-admin',
      )
    ) {
      throw new ForbiddenException(
        'tenant-admin or platform-admin role required',
      );
    }

    const groups =
      actor.groups
        .map(
          (group) =>
            group.replace(/^\/+/, ''),
        )
        .filter(Boolean);

    if (
      groups.length !== 1 ||
      groups[0] !== tenantId
    ) {
      throw new ForbiddenException(
        'Cannot manage users from another tenant',
      );
    }

    return tenant;
  }

  private async requireTargetUser(
    userId: string,
    groupId: string,
  ): Promise<ManagedHumanUser> {
    const user =
      await this.keycloakUsers
        .getUserInGroup(
          userId,
          groupId,
        );

    if (!user) {
      throw new NotFoundException(
        'User not found',
      );
    }

    return user;
  }

  private assertCanCreateRole(
    actor: AuthUser,
    role: HumanRole,
  ): void {
    if (
      actor.roles.includes(
        'platform-admin',
      )
    ) {
      if (
        role === 'tenant-admin' ||
        role === 'viewer'
      ) {
        return;
      }

      throw new ForbiddenException(
        'platform-admin can create only tenant-admin or viewer users',
      );
    }

    if (
      actor.roles.includes(
        'tenant-admin',
      ) &&
      role === 'viewer'
    ) {
      return;
    }

    throw new ForbiddenException(
      'tenant-admin can create only viewer users',
    );
  }

  private assertCanManageTarget(
    actor: AuthUser,
    target: ManagedHumanUser,
  ): void {
    /*
     * platform-admin identities themselves
     * are bootstrap/system identities.
     * This API never manages them.
     */
    if (
      target.role === 'platform-admin'
    ) {
      throw new ForbiddenException(
        'platform-admin users cannot be managed through tenant user lifecycle',
      );
    }

    if (
      target.role === 'unknown'
    ) {
      throw new ForbiddenException(
        'User has unsupported role configuration',
      );
    }

    if (
      actor.roles.includes(
        'platform-admin',
      )
    ) {
      return;
    }

    if (
      actor.roles.includes(
        'tenant-admin',
      ) &&
      target.role === 'viewer'
    ) {
      return;
    }

    throw new ForbiddenException(
      'tenant-admin can manage only viewer users',
    );
  }

  private validateCreateInput(
    input: CreateUserInput,
  ): void {
    if (
      !input.username?.trim() ||
      /\s/.test(input.username)
    ) {
      throw new BadRequestException(
        'Invalid username',
      );
    }

    if (!input.password) {
      throw new BadRequestException(
        'Password is required',
      );
    }

    if (
      !input.firstName?.trim() ||
      !input.lastName?.trim()
    ) {
      throw new BadRequestException(
        'firstName and lastName are required',
      );
    }

    if (
      !input.email?.trim() ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(
        input.email,
      )
    ) {
      throw new BadRequestException(
        'Invalid email',
      );
    }

    if (
      input.role !== 'tenant-admin' &&
      input.role !== 'viewer'
    ) {
      throw new BadRequestException(
        'role must be tenant-admin or viewer',
      );
    }
  }
}
