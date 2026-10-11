import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

import { trimString } from '../../common/http/validation';

export const GRANT_ROLES = ['Viewer', 'Editor'] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];

/** POST /tenants/:tenant/support-access. Upper bound of minutes: service. */
export class GrantDto {
  @Transform(trimString)
  @IsString()
  @Length(10, 500, {
    message:
      'reason is required (10-500 characters), e.g. a ticket id and what you need to check',
  })
  reason!: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  minutes?: number;

  @IsOptional()
  @IsIn(GRANT_ROLES)
  role?: GrantRole;
}

/** `?active=true|1` → only grants in effect now. */
export function activeOnly(value: unknown): boolean {
  return value === 'true' || value === '1';
}
