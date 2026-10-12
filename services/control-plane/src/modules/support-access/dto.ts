import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

/** POST /tenants/{tenantKey}/support-access. Upper bound of minutes: service. */
export class GrantDto {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'TICKET-42 dashboard shows no data',
    description: 'Audited: a ticket id and what you need to check',
  })
  @Transform(trimString)
  @IsString()
  @Length(10, 500, {
    message:
      'reason is required (10-500 characters), e.g. a ticket id and what you need to check',
  })
  reason!: string;

  @ApiPropertyOptional({
    minimum: 5,
    default: 60,
    description: 'At most SUPPORT_ACCESS_MAX_MINUTES (480 by default)',
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  minutes?: number;

  @ApiPropertyOptional({ enum: GRANT_ROLES, default: 'Viewer' })
  @IsOptional()
  @IsIn(GRANT_ROLES)
  role?: GrantRole;
}

const BOOLEAN_STRINGS = ['true', 'false', '1', '0'] as const;

/** `?active=true` → only grants in effect now. */
export class ListGrantsQuery {
  @ApiPropertyOptional({ enum: BOOLEAN_STRINGS })
  @IsOptional()
  @IsIn(BOOLEAN_STRINGS)
  active?: (typeof BOOLEAN_STRINGS)[number];
}

export function activeOnly(query: ListGrantsQuery): boolean {
  return query.active === 'true' || query.active === '1';
}
