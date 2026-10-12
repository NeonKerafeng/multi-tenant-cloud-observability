import { ApiProperty } from '@nestjs/swagger';

import { type Role, ROLES } from '../../common/auth/actor';
import { listOf } from '../../common/http/list';

import type { UserRecord } from './user.repository';

/** A human user (also the response of GET /me). */
export class UserView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'alpha-tenant',
    description: 'null for platform admins',
  })
  tenantKey!: string | null;

  @ApiProperty({ example: 'alpha-viewer' })
  username!: string;

  @ApiProperty({ example: 'alpha-viewer@example.com' })
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  firstName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastName!: string | null;

  @ApiProperty({ enum: ROLES })
  role!: Role;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export const UserList = listOf(UserView);

export function toUserView(user: UserRecord): UserView {
  return {
    id: user.id,
    tenantKey: user.tenantKey,
    username: user.username,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    enabled: user.enabled,
    createdAt: user.createdAt,
  };
}
