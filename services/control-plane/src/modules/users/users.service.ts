import { Injectable } from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  DatabaseService,
  PG_UNIQUE_VIOLATION,
  pgConstraint,
  pgErrorCode,
  type Queryable,
} from '../../common/db/database.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import { isUuid } from '../../common/http/validation';
import { KeycloakUserMirror } from '../../mirrors/keycloak/keycloak-user.mirror';
import { OutboxRepository } from '../../sync/outbox.repository';
import type { TenantRecord } from '../tenants/tenant.repository';

import type { CreateUserDto } from './dto';
import {
  EMAIL_CONSTRAINT,
  type NewUser,
  type UserRecord,
  UserRepository,
  USERNAME_CONSTRAINT,
} from './user.repository';
import { assertCanCreateUser, assertCanManageUser } from './users.policy';
import { toUserView, type UserView } from './views';

export interface UpdateUserInput {
  enabled?: boolean;
}

export interface NewPlatformAdmin {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * Human users of a tenant. The DB is the source of truth; Keycloak and
 * Grafana follow through the outbox. Creation runs the Keycloak mirror
 * inline (the password is set on the account and never stored).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly users: UserRepository,
    private readonly outbox: OutboxRepository,
    private readonly keycloakUsers: KeycloakUserMirror,
  ) {}

  /** GET /me: the caller's own user (the guard already loaded it). */
  async me(actor: Actor): Promise<UserView> {
    const user = await this.users.findById(actor.userId);

    if (!user) {
      throw new NotFoundError('user_not_found', 'User not found');
    }

    return toUserView(user);
  }

  async list(_actor: Actor, tenant: TenantRecord): Promise<UserView[]> {
    return (await this.users.listActiveByTenant(tenant.id)).map(toUserView);
  }

  async get(
    _actor: Actor,
    tenant: TenantRecord,
    userId: string,
  ): Promise<UserView> {
    return toUserView(await this.requireUser(tenant, userId));
  }

  async create(
    actor: Actor,
    tenant: TenantRecord,
    dto: CreateUserDto,
  ): Promise<UserView> {
    assertCanCreateUser(actor, dto.role);

    return toUserView(
      await this.createWithIdentity(
        {
          tenantId: tenant.id,
          username: dto.username,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          role: dto.role,
        },
        dto.password,
      ),
    );
  }

  async update(
    actor: Actor,
    tenant: TenantRecord,
    userId: string,
    input: UpdateUserInput,
  ): Promise<UserView> {
    const target = await this.requireUser(tenant, userId);

    assertCanManageUser(actor, target);

    if (input.enabled !== undefined && input.enabled !== target.enabled) {
      const enabled = input.enabled;

      await this.db.transaction(async (tx) => {
        await this.users.setEnabled(tx, target.id, enabled);
        await this.outbox.enqueue(tx, 'user', target.id);
      });
    }

    return toUserView((await this.users.findById(target.id)) ?? target);
  }

  async delete(
    actor: Actor,
    tenant: TenantRecord,
    userId: string,
  ): Promise<void> {
    const target = await this.requireUser(tenant, userId);

    assertCanManageUser(actor, target);

    await this.db.transaction(async (tx) => {
      await this.users.markDeleted(tx, target.id);
      await this.outbox.enqueue(tx, 'user', target.id);
    });
  }

  /** The initial platform admin (PlatformBootstrapService only). */
  async createPlatformAdmin(input: NewPlatformAdmin): Promise<UserRecord> {
    return this.createWithIdentity(
      {
        tenantId: null,
        username: input.username.toLowerCase(),
        email: input.email.toLowerCase(),
        firstName: input.firstName,
        lastName: input.lastName,
        role: 'platform-admin',
      },
      input.password,
    );
  }

  /**
   * Row + Keycloak account (inline, with password) + outbox in ONE
   * transaction. Keycloak down → nothing is created; a half-created
   * Keycloak account carries our marker and is adopted on the next try.
   */
  private createWithIdentity(
    user: NewUser,
    password: string,
  ): Promise<UserRecord> {
    return this.db.transaction(async (tx) => {
      const created = await this.insert(tx, user);

      await this.keycloakUsers.apply(created, { password, q: tx });
      await this.outbox.enqueue(tx, 'user', created.id);

      return (await this.users.findById(created.id, tx)) ?? created;
    });
  }

  private async insert(tx: Queryable, user: NewUser): Promise<UserRecord> {
    try {
      return await this.users.insert(tx, user);
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        const constraint = pgConstraint(error);

        if (constraint === USERNAME_CONSTRAINT) {
          throw new ConflictError(
            'username_taken',
            'This username is already used',
          );
        }

        if (constraint === EMAIL_CONSTRAINT) {
          throw new ConflictError('email_taken', 'This email is already used');
        }
      }

      throw error;
    }
  }

  private async requireUser(
    tenant: TenantRecord,
    userId: string,
  ): Promise<UserRecord> {
    const user = isUuid(userId)
      ? await this.users.findActiveInTenant(tenant.id, userId)
      : null;

    if (!user) {
      throw new NotFoundError('user_not_found', 'User not found');
    }

    return user;
  }
}
