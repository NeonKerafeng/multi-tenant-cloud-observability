import { ApiProperty } from '@nestjs/swagger';

import { listOf } from '../../common/http/list';

import type { EnrollmentRecord } from './enrollment.repository';

export const ENROLLMENT_STATES = [
  'pending',
  'used',
  'expired',
  'revoked',
] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/** A one-time agent enrollment (the token itself is never stored). */
export class EnrollmentView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'alpha-tenant' })
  tenantKey!: string;

  @ApiProperty({ description: 'Username of the admin who created it' })
  createdBy!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  usedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  revokedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  revokedBy!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The agent it created (once used)',
  })
  agentId!: string | null;

  @ApiProperty({ enum: ENROLLMENT_STATES })
  state!: EnrollmentState;
}

export const EnrollmentList = listOf(EnrollmentView);

/** POST /tenants/{tenantKey}/agent-enrollments: the token is shown ONCE. */
export class EnrollmentCreated extends EnrollmentView {
  @ApiProperty({
    description:
      'One-time token for client/bootstrap.sh on the host (FROZEN field name)',
  })
  enrollmentToken!: string;
}

/** POST /agent-enrollments/exchange. FROZEN fields used by client/bootstrap.sh (§18.3.6). */
export class ExchangeResult {
  @ApiProperty({ format: 'uuid' })
  agentId!: string;

  @ApiProperty({ example: 'otel-agent-6e012d7d-c990-4a18-8990-6dd62b22d63d' })
  clientId!: string;

  @ApiProperty({ example: 'alpha-tenant' })
  tenantKey!: string;

  @ApiProperty({ description: 'Keycloak client secret; returned only once' })
  clientSecret!: string;

  @ApiProperty({
    example:
      'http://keycloak.example:8080/realms/observability/protocol/openid-connect/token',
  })
  tokenUrl!: string;

  @ApiProperty({ example: 'http://otel.example:4318' })
  gatewayEndpoint!: string;
}

export function enrollmentState(enrollment: EnrollmentRecord): EnrollmentState {
  if (enrollment.usedAt) {
    return 'used';
  }

  if (enrollment.revokedAt) {
    return 'revoked';
  }

  return enrollment.expired ? 'expired' : 'pending';
}

export function toEnrollmentView(enrollment: EnrollmentRecord): EnrollmentView {
  return {
    id: enrollment.id,
    tenantKey: enrollment.tenantKey,
    createdBy: enrollment.createdByUsername,
    createdAt: enrollment.createdAt,
    expiresAt: enrollment.expiresAt,
    usedAt: enrollment.usedAt,
    revokedAt: enrollment.revokedAt,
    revokedBy: enrollment.revokedByUsername,
    agentId: enrollment.usedAt ? enrollment.agentId : null,
    state: enrollmentState(enrollment),
  };
}
