import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Length, Matches } from 'class-validator';

import { EnabledPatchDto } from '../../common/http/dto';
import { trimLower, trimString } from '../../common/http/validation';

export const MANAGED_ROLES = ['tenant-admin', 'viewer'] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

export class CreateUserDto {
  /** Keycloak lowercases usernames; so do we (unique on lower()). */
  @ApiProperty({
    example: 'alpha-viewer',
    description: 'Lowercased; no spaces',
  })
  @Transform(trimLower)
  @IsString()
  @Length(1, 255)
  @Matches(/^\S+$/, { message: 'username must not contain whitespace' })
  username!: string;

  /** Policy (length, …) = Keycloak realm policy, TODO-24. */
  @ApiProperty({ format: 'password', writeOnly: true })
  @IsString()
  @Length(1, 1024)
  password!: string;

  @ApiProperty({ example: 'Alpha' })
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @ApiProperty({ example: 'Viewer' })
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  lastName!: string;

  @ApiProperty({
    example: 'alpha-viewer@example.com',
    description: 'Lowercased',
  })
  @Transform(trimLower)
  @IsEmail()
  @Length(3, 254)
  email!: string;

  @ApiProperty({
    enum: MANAGED_ROLES,
    description: 'tenant admins may only create viewers',
  })
  @IsIn(MANAGED_ROLES)
  role!: ManagedRole;
}

/** PATCH /tenants/{tenantKey}/users/{userId}. */
export class UpdateUserDto extends EnabledPatchDto {}
