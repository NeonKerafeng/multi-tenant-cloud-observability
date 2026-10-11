import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

import { TENANT_KEY_RE, trimString } from '../../common/http/validation';

const TENANT_KEY_MESSAGE =
  'must be 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen';

/** v0.7 legacy body of POST /tenants (`tenantId` is the tenant KEY). */
export class LegacyCreateTenantDto {
  @Transform(trimString)
  @IsString()
  @Matches(TENANT_KEY_RE, { message: `tenantId ${TENANT_KEY_MESSAGE}` })
  tenantId!: string;
}
