import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Length, Matches } from 'class-validator';

import { trimLower, trimString } from '../../common/http/validation';

export const MANAGED_ROLES = ['tenant-admin', 'viewer'] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

export class CreateUserDto {
  /** Keycloak lowercases usernames; so do we (unique on lower()). */
  @Transform(trimLower)
  @IsString()
  @Length(1, 255)
  @Matches(/^\S+$/, { message: 'username must not contain whitespace' })
  username!: string;

  /** Policy (length, …) = Keycloak realm policy, TODO-24. */
  @IsString()
  @Length(1, 1024)
  password!: string;

  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  lastName!: string;

  @Transform(trimLower)
  @IsEmail()
  @Length(3, 254)
  email!: string;

  @IsIn(MANAGED_ROLES)
  role!: ManagedRole;
}
