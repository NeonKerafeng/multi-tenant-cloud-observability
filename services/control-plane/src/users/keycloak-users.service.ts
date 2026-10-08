import {
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';

export type HumanRole =
  | 'platform-admin'
  | 'tenant-admin'
  | 'viewer'
  | 'unknown';

export interface ManagedHumanUser {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  enabled: boolean;
  role: HumanRole;
  roles: string[];
}

export interface CreateHumanUserInput {
  groupId: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'tenant-admin' | 'viewer';
}

interface KeycloakUserRepresentation {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled?: boolean;
}

interface KeycloakRoleRepresentation {
  id: string;
  name: string;
}

interface KeycloakGroupRepresentation {
  id: string;
}

@Injectable()
export class KeycloakUsersService {
  constructor(
    private readonly config: ConfigService,

    private readonly keycloak:
      KeycloakAdminService,
  ) {}

  async createUser(
    input: CreateHumanUserInput,
  ): Promise<ManagedHumanUser> {
    const token =
      await this.keycloak
        .getAdminAccessToken();

    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users`,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          username:
            input.username,

          firstName:
            input.firstName,

          lastName:
            input.lastName,

          email:
            input.email,

          emailVerified: true,

          enabled: true,

          requiredActions: [],
        }),
      },
    );

    if (response.status === 409) {
      throw new ConflictException(
        'Username or email already exists',
      );
    }

    if (!response.ok) {
      throw new Error(
        `Failed to create Keycloak user: ${response.status}`,
      );
    }

    const location =
      response.headers.get(
        'location',
      );

    const userId =
      location
        ?.split('/')
        .pop();

    if (!userId) {
      throw new Error(
        'Keycloak did not return user ID',
      );
    }

    try {
      await this.setPassword(
        userId,
        input.password,
        token,
      );

      await this.joinGroup(
        userId,
        input.groupId,
        token,
      );

      await this.assignRealmRole(
        userId,
        input.role,
        token,
      );

      const user =
        await this.getUserInGroup(
          userId,
          input.groupId,
        );

      if (!user) {
        throw new Error(
          'Created user is not visible in tenant group',
        );
      }

      return user;
    } catch (error) {
      /*
       * Avoid leaving a half-created
       * human identity behind.
       */
      await this.deleteUserById(
        userId,
        token,
      ).catch(() => undefined);

      throw error;
    }
  }

  async listUsersInGroup(
    groupId: string,
  ): Promise<ManagedHumanUser[]> {
    const token =
      await this.keycloak
        .getAdminAccessToken();

    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/groups/${groupId}/members?first=0&max=1000`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to list tenant users: ${response.status}`,
      );
    }

    const users = await response.json() as KeycloakUserRepresentation[];

    return Promise.all(
      users.map(
        (user) =>
          this.toManagedUser(
            user,
            token,
          ),
      ),
    );
  }

  /**
   * Users holding a realm role (used to adopt platform admins, which are
   * bootstrap identities not created through this API).
   */
  async listUsersWithRealmRole(
    roleName: string,
  ): Promise<ManagedHumanUser[]> {
    const token =
      await this.keycloak
        .getAdminAccessToken();

    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}/users?first=0&max=1000`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to list users with role ${roleName}: ${response.status}`,
      );
    }

    const users = (await response.json()) as KeycloakUserRepresentation[];

    return Promise.all(
      users.map(
        (user) =>
          this.toManagedUser(
            user,
            token,
          ),
      ),
    );
  }

  async getUserInGroup(
    userId: string,
    groupId: string,
  ): Promise<ManagedHumanUser | null> {
    const token =
      await this.keycloak
        .getAdminAccessToken();

    const user =
      await this.getUser(
        userId,
        token,
      );

    if (!user) {
      return null;
    }

    const groups =
      await this.getUserGroups(
        userId,
        token,
      );

    if (
      !groups.some(
        (group) =>
          group.id === groupId,
      )
    ) {
      return null;
    }

    return this.toManagedUser(
      user,
      token,
    );
  }

  async setUserEnabled(
    userId: string,
    groupId: string,
    enabled: boolean,
  ): Promise<ManagedHumanUser | null> {
    const current =
      await this.getUserInGroup(
        userId,
        groupId,
      );

    if (!current) {
      return null;
    }

    const token =
      await this.keycloak
        .getAdminAccessToken();

    const user =
      await this.getUser(
        userId,
        token,
      );

    if (!user) {
      return null;
    }

    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}`,
      {
        method: 'PUT',

        headers: {
          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          ...user,
          enabled,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to update Keycloak user: ${response.status}`,
      );
    }

    return this.getUserInGroup(
      userId,
      groupId,
    );
  }

  async deleteUserInGroup(
    userId: string,
    groupId: string,
  ): Promise<boolean> {
    const user =
      await this.getUserInGroup(
        userId,
        groupId,
      );

    if (!user) {
      return false;
    }

    const token =
      await this.keycloak
        .getAdminAccessToken();

    await this.deleteUserById(
      userId,
      token,
    );

    return true;
  }

  private async setPassword(
    userId: string,
    password: string,
    token: string,
  ): Promise<void> {
    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}/reset-password`,
      {
        method: 'PUT',

        headers: {
          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          type: 'password',
          value: password,
          temporary: false,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to set user password: ${response.status}`,
      );
    }
  }

  private async joinGroup(
    userId: string,
    groupId: string,
    token: string,
  ): Promise<void> {
    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}/groups/${groupId}`,
      {
        method: 'PUT',

        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to add user to tenant group: ${response.status}`,
      );
    }
  }

  private async assignRealmRole(
    userId: string,
    roleName:
      'tenant-admin' | 'viewer',
    token: string,
  ): Promise<void> {
    const { baseUrl, realm } =
      this.getConfig();

    const roleResponse =
      await fetch(
        `${baseUrl}/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}`,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
          },
        },
      );

    if (!roleResponse.ok) {
      throw new Error(
        `Failed to read realm role ${roleName}: ${roleResponse.status}`,
      );
    }

    const role = (await roleResponse.json()) as KeycloakRoleRepresentation;

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json',
        },

        body: JSON.stringify([
          role,
        ]),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to assign realm role: ${response.status}`,
      );
    }
  }

  private async getUser(
    userId: string,
    token: string,
  ): Promise<KeycloakUserRepresentation | null> {
    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to read Keycloak user: ${response.status}`,
      );
    }

    const user = (await response.json()) as KeycloakUserRepresentation;

    return user;
  }

  private async getUserGroups(
    userId: string,
    token: string,
  ): Promise<KeycloakGroupRepresentation[]> {
    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}/groups?first=0&max=1000`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to read user groups: ${response.status}`,
      );
    }

    const groups =
      (await response.json()) as KeycloakGroupRepresentation[];

    return groups;
  }

  private async getUserRoles(
    userId: string,
    token: string,
  ): Promise<string[]> {
    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to read user roles: ${response.status}`,
      );
    }

    const roles = (await response.json()) as KeycloakRoleRepresentation[];

    return roles.map(
      (role) => role.name,
    );
  }

  private async toManagedUser(
    user: KeycloakUserRepresentation,
    token: string,
  ): Promise<ManagedHumanUser> {
    const roles =
      await this.getUserRoles(
        user.id,
        token,
      );

    return {
      id: user.id,

      username:
        user.username ?? '',

      firstName:
        user.firstName ?? null,

      lastName:
        user.lastName ?? null,

      email:
        user.email ?? null,

      enabled:
        user.enabled ?? false,

      role:
        this.getManagedRole(
          roles,
        ),

      roles,
    };
  }

  private getManagedRole(
    roles: string[],
  ): HumanRole {
    if (
      roles.includes(
        'platform-admin',
      )
    ) {
      return 'platform-admin';
    }

    if (
      roles.includes(
        'tenant-admin',
      )
    ) {
      return 'tenant-admin';
    }

    if (
      roles.includes(
        'viewer',
      )
    ) {
      return 'viewer';
    }

    return 'unknown';
  }

  private async deleteUserById(
    userId: string,
    token: string,
  ): Promise<void> {
    const { baseUrl, realm } =
      this.getConfig();

    const response = await fetch(
      `${baseUrl}/admin/realms/${realm}/users/${userId}`,
      {
        method: 'DELETE',

        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      },
    );

    if (
      !response.ok &&
      response.status !== 404
    ) {
      throw new Error(
        `Failed to delete Keycloak user: ${response.status}`,
      );
    }
  }

  private getConfig() {
    return {
      baseUrl:
        this.config.getOrThrow<string>(
          'KEYCLOAK_URL',
        ),

      realm:
        this.config.getOrThrow<string>(
          'KEYCLOAK_REALM',
        ),
    };
  }
}
