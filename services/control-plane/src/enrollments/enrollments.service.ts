import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';

import { AuthUser } from '../auth/auth-user';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';

interface Enrollment {
  tenantId: string;
  vmAccountId: string;
  expiresAt: number;
}

@Injectable()
export class EnrollmentsService {
  private readonly enrollments = new Map<string, Enrollment>();

  constructor(
    private readonly keycloakAdminService: KeycloakAdminService,
  ) {}

  create(user: AuthUser) {
    if (!user.roles.includes('tenant-admin')) {
      throw new ForbiddenException('tenant-admin role required');
    }

    if (user.groups.length !== 1) {
      throw new BadRequestException(
        'Exactly one tenant group is required',
      );
    }

    if (
      user.vmAccountIds.length !== 1 ||
      !/^\d+$/.test(user.vmAccountIds[0])
    ) {
      throw new BadRequestException(
        'Exactly one numeric vm_account_id is required',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(token);

    const expiresAt = Date.now() + 10 * 60 * 1000;

    this.enrollments.set(tokenHash, {
      tenantId: user.groups[0],
      vmAccountId: user.vmAccountIds[0],
      expiresAt,
    });

    return {
      enrollmentToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async exchange(token: string) {
    if (!token) {
      throw new BadRequestException('Enrollment token is required');
    }

    const tokenHash = this.hashToken(token);
    const enrollment = this.enrollments.get(tokenHash);

    if (!enrollment) {
      throw new ForbiddenException('Invalid enrollment token');
    }

    if (Date.now() >= enrollment.expiresAt) {
      this.enrollments.delete(tokenHash);
      throw new GoneException('Enrollment token expired');
    }

    // Consume BEFORE creating the identity.
    // If provisioning fails, tenant admin simply creates a new token.
    this.enrollments.delete(tokenHash);

    const agentId = randomUUID();

    const identity =
      await this.keycloakAdminService.createAgentIdentity({
        agentId,
        tenantId: enrollment.tenantId,
        vmAccountId: enrollment.vmAccountId,
      });

    return {
      agentId,
      tenantId: enrollment.tenantId,
      vmAccountId: enrollment.vmAccountId,
      clientId: identity.clientId,
      clientSecret: identity.clientSecret,

      tokenUrl:
        `${process.env.KEYCLOAK_PUBLIC_URL}/realms/observability/protocol/openid-connect/token`,

      gatewayEndpoint:
        process.env.OTEL_GATEWAY_PUBLIC_URL,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }
}
