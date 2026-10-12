import { Injectable, Logger } from '@nestjs/common';

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Actor } from '../../common/auth/actor';
import {
  DatabaseService,
  type Queryable,
} from '../../common/db/database.service';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  GoneError,
  InvalidError,
  NotFoundError,
} from '../../common/errors/domain-error';
import { isUuid } from '../../common/http/validation';
import { AppConfig } from '../../config/app-config';
import { AgentsService } from '../agents/agents.service';
import {
  type TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';

import { EnrollmentRepository } from './enrollment.repository';
import {
  type EnrollmentCreated,
  type EnrollmentView,
  type ExchangeResult,
  toEnrollmentView,
} from './views';

/**
 * One-time enrollment tokens for host agents, stored in agent_enrollments
 * (v0.9: survives restarts, works with several replicas — I-05, I-22).
 *
 * The agent id is fixed when the enrollment is created, and the exchange
 * is ONE transaction (lock the enrollment row → agent row → Keycloak
 * client → used_at). Any failure rolls everything back and the host can
 * retry with the SAME token until it expires: it lands on the same agent
 * id and therefore the same Keycloak client (no orphan).
 */
@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly enrollments: EnrollmentRepository,
    private readonly tenants: TenantRepository,
    private readonly agents: AgentsService,
    private readonly config: AppConfig,
  ) {}

  async create(actor: Actor, tenant: TenantRecord): Promise<EnrollmentCreated> {
    const token = randomBytes(32).toString('base64url');

    const enrollment = await this.enrollments.create(this.db, {
      tenantId: tenant.id,
      tokenHash: hashToken(token),
      agentId: randomUUID(),
      createdBy: actor.userId,
      ttlMinutes: this.config.enrollmentTtlMinutes,
    });

    this.logger.log(
      `Enrollment ${enrollment.id} for ${tenant.tenantKey} created by ${actor.username}`,
    );

    return { ...toEnrollmentView(enrollment), enrollmentToken: token };
  }

  async list(_actor: Actor, tenant: TenantRecord): Promise<EnrollmentView[]> {
    return (await this.enrollments.listByTenant(tenant.id)).map(
      toEnrollmentView,
    );
  }

  /** Revoking an expired or already revoked one is a no-op. */
  async revoke(
    actor: Actor,
    tenant: TenantRecord,
    enrollmentId: string,
  ): Promise<void> {
    const enrollment = isUuid(enrollmentId)
      ? await this.enrollments.findById(enrollmentId)
      : null;

    if (!enrollment || enrollment.tenantId !== tenant.id) {
      throw new NotFoundError('enrollment_not_found', 'Enrollment not found');
    }

    if (enrollment.usedAt) {
      throw new ConflictError(
        'enrollment_used',
        'This enrollment was already used; delete its agent instead',
      );
    }

    if (await this.enrollments.revoke(this.db, enrollment.id, actor.userId)) {
      this.logger.log(
        `Enrollment ${enrollment.id} revoked by ${actor.username}`,
      );
    }
  }

  /** Public: the host trades the token for its credentials, once. */
  async exchange(token: string, ip: string): Promise<ExchangeResult> {
    try {
      const result = await this.db.transaction((tx) =>
        this.exchangeIn(tx, hashToken(token)),
      );

      this.logger.log(
        `Enrollment exchanged from ${ip}: agent ${result.agentId} (${result.tenantKey})`,
      );

      return result;
    } catch (error) {
      if (error instanceof DomainError) {
        // Never log the token.
        this.logger.warn(
          `Enrollment exchange refused from ${ip}: ${error.code}`,
        );
      }

      throw error;
    }
  }

  private async exchangeIn(
    tx: Queryable,
    tokenHash: string,
  ): Promise<ExchangeResult> {
    // A concurrent exchange of the same token waits here.
    const enrollment = await this.enrollments.lockByTokenHash(tx, tokenHash);

    if (!enrollment) {
      throw new ForbiddenError(
        'enrollment_invalid',
        'Invalid enrollment token',
      );
    }

    if (enrollment.usedAt) {
      throw new GoneError(
        'enrollment_used',
        'This enrollment token was already used',
      );
    }

    if (enrollment.revokedAt) {
      throw new GoneError(
        'enrollment_revoked',
        'This enrollment token was revoked',
      );
    }

    if (enrollment.expired) {
      throw new GoneError('enrollment_expired', 'Enrollment token expired');
    }

    const tenant = await this.tenants.findById(enrollment.tenantId, tx);

    if (!tenant || tenant.status !== 'active') {
      throw new InvalidError(
        'tenant_not_active',
        'The tenant is no longer active',
      );
    }

    const issued = await this.agents.issue(tx, tenant, {
      agentId: enrollment.agentId,
      enrollmentId: enrollment.id,
    });

    await this.enrollments.markUsed(tx, enrollment.id);

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
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
