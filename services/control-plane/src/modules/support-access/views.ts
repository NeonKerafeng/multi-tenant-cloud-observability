import { ApiProperty } from '@nestjs/swagger';

import { listOf } from '../../common/http/list';

import { GRANT_ROLES } from './dto';
import type {
  SupportAccessRecord,
  SupportAccessRole,
} from './support-access.repository';

/** A time-boxed access of a platform admin to one tenant's Grafana org. */
export class GrantView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'alpha-tenant' })
  tenantKey!: string;

  @ApiProperty({ description: 'The platform admin who has the access' })
  username!: string;

  @ApiProperty({ enum: GRANT_ROLES })
  role!: SupportAccessRole;

  @ApiProperty({ example: 'TICKET-42 dashboard shows no data' })
  reason!: string;

  @ApiProperty()
  grantedBy!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  revokedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  revokedBy!: string | null;

  @ApiProperty({ description: 'Not revoked and not expired' })
  active!: boolean;
}

export const GrantList = listOf(GrantView);

export function toGrantView(
  grant: SupportAccessRecord,
  now = Date.now(),
): GrantView {
  return {
    id: grant.id,
    tenantKey: grant.tenantKey,
    username: grant.username,
    role: grant.role,
    reason: grant.reason,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    revokedBy: grant.revokedBy,
    active: grant.revokedAt === null && grant.expiresAt.getTime() > now,
  };
}
