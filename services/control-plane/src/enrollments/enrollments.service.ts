import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
} from '@nestjs/common';

import {
  createHash,
  randomBytes,
} from 'crypto';

import type { AuthUser } from '../auth/auth-user';

import { AgentsService } from '../agents/agents.service';

interface Enrollment {
  tenantId: string;
  expiresAt: number;
}

@Injectable()
export class EnrollmentsService {
  private readonly enrollments =
    new Map<string, Enrollment>();

  constructor(
    private readonly agents:
      AgentsService,
  ) {}

  create(
    user: AuthUser,
  ) {
    if (
      !user.roles.includes(
        'tenant-admin',
      )
    ) {
      throw new ForbiddenException(
        'tenant-admin role required',
      );
    }

    const groups =
      user.groups
        .map(
          (group) =>
            group.replace(/^\/+/, ''),
        )
        .filter(Boolean);

    if (groups.length !== 1) {
      throw new BadRequestException(
        'Exactly one tenant group is required',
      );
    }

    const token =
      randomBytes(32)
        .toString('base64url');

    const tokenHash =
      this.hashToken(token);

    const expiresAt =
      Date.now() +
      10 * 60 * 1000;

    this.enrollments.set(
      tokenHash,
      {
        tenantId:
          groups[0],

        expiresAt,
      },
    );

    return {
      enrollmentToken:
        token,

      expiresAt:
        new Date(
          expiresAt,
        ).toISOString(),
    };
  }

  async exchange(
    token: string,
  ) {
    if (!token) {
      throw new BadRequestException(
        'Enrollment token is required',
      );
    }

    const tokenHash =
      this.hashToken(token);

    const enrollment =
      this.enrollments.get(
        tokenHash,
      );

    if (!enrollment) {
      throw new ForbiddenException(
        'Invalid enrollment token',
      );
    }

    if (
      Date.now() >=
      enrollment.expiresAt
    ) {
      this.enrollments.delete(
        tokenHash,
      );

      throw new GoneException(
        'Enrollment token expired',
      );
    }

    /*
     * Consume BEFORE provisioning.
     * A failed provisioning requires
     * a new enrollment token.
     */
    this.enrollments.delete(
      tokenHash,
    );

    const agent =
      await this.agents
        .provisionAgentForTenant(
          enrollment.tenantId,
        );

    return {
      ...agent,

      tokenUrl:
        `${process.env.KEYCLOAK_PUBLIC_URL}/realms/observability/protocol/openid-connect/token`,

      gatewayEndpoint:
        process.env
          .OTEL_GATEWAY_PUBLIC_URL,
    };
  }

  private hashToken(
    token: string,
  ): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }
}