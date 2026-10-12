import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

import { TENANT_KEY_RE, trimString } from '../../common/http/validation';

export class CreateTenantDto {
  @ApiProperty({
    example: 'gamma-tenant',
    pattern: TENANT_KEY_RE.source,
    description:
      '1-63 lowercase letters, digits or hyphens; never reusable, even after delete',
  })
  @Transform(trimString)
  @IsString()
  @Matches(TENANT_KEY_RE, {
    message:
      'tenantKey must be 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen',
  })
  tenantKey!: string;
}
