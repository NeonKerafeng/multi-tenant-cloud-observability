import { ApiProperty } from '@nestjs/swagger';

/** POST /tenants/{tenantKey}/agent-enrollments (FROZEN field names). */
export class EnrollmentCreated {
  @ApiProperty({
    description:
      'One-time token for client/bootstrap.sh on the host; shown only here',
  })
  enrollmentToken!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
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
