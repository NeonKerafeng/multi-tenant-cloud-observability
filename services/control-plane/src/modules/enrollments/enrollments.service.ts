import { Injectable } from '@nestjs/common';

import { createHash, randomBytes } from 'node:crypto';

import type { Actor } from '../../common/auth/actor';
import {
  ForbiddenError,
  GoneError,
  InvalidError,
} from '../../common/errors/domain-error';
import { AppConfig } from '../../config/app-config';
import { AgentsService } from '../agents/agents.service';
import {
  type TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';

import type { EnrollmentCreated, ExchangeResult } from './views';

interface PendingEnrollment {
  tenantId: string;
  expiresAt: number;
}

/**
 * One-time enrollment tokens (10 min) for host agents.
 * v0.7: still in process memory (lost on restart, single replica).
 * v0.9 moves them to the agent_enrollments table (I-22, I-05) behind the
 * SAME method signatures.
 */
@Injectable()
export class EnrollmentsService {
  private readonly pending = new Map<string, PendingEnrollment>();

  constructor(
    private readonly agents: AgentsService,
    private readonly tenants: TenantRepository,
    private readonly config: AppConfig,
  ) {}

  create(_actor: Actor, tenant: TenantRecord): EnrollmentCreated {
    this.forgetExpired();

    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.config.enrollmentTtlMinutes * 60 * 1000;

    this.pending.set(hashToken(token), { tenantId: tenant.id, expiresAt });

    return {
      enrollmentToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Public: the host trades the token for its credentials, once. */
  async exchange(token: string): Promise<ExchangeResult> {
    const hash = hashToken(token);
    const enrollment = this.pending.get(hash);

    if (!enrollment) {
      throw new ForbiddenError(
        'enrollment_invalid',
        'Invalid enrollment token',
      );
    }

    // Consumed BEFORE provisioning: a failed provisioning needs a new token
    // (v0.9 makes the exchange retryable with the same token).
    this.pending.delete(hash);

    if (Date.now() >= enrollment.expiresAt) {
      throw new GoneError('enrollment_expired', 'Enrollment token expired');
    }

    const tenant = await this.tenants.findById(enrollment.tenantId);

    if (!tenant || tenant.status !== 'active') {
      throw new InvalidError(
        'tenant_not_active',
        'The tenant is no longer active',
      );
    }

    const issued = await this.agents.issue(tenant);
    const { keycloak, otelGatewayPublicUrl } = this.config;

    return {
      agentId: issued.agent.id,
      clientId: issued.agent.clientId,
      tenantKey: tenant.tenantKey,
      clientSecret: issued.clientSecret,
      tokenUrl: `${keycloak.publicUrl}/realms/${encodeURIComponent(keycloak.realm)}/protocol/openid-connect/token`,
      gatewayEndpoint: otelGatewayPublicUrl,
    };
  }

  private forgetExpired(): void {
    const now = Date.now();

    for (const [hash, enrollment] of this.pending) {
      if (enrollment.expiresAt <= now) {
        this.pending.delete(hash);
      }
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
