import { Body, Controller, Post } from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Public,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { TenantRecord } from '../tenants/tenant.repository';

import { ExchangeDto } from './dto';
import {
  type EnrollmentCreated,
  EnrollmentsService,
  type ExchangeResult,
} from './enrollments.service';

/**
 * v0.7 LEGACY routes. v0.8: POST /api/v1/tenants/{tenantKey}/agent-enrollments
 * (platform admins too) and POST /api/v1/agent-enrollments/exchange.
 */
@Controller('agent-enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Post()
  @Roles('tenant-admin')
  @TenantScope({ from: 'actor-home' })
  create(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): EnrollmentCreated {
    return this.enrollments.create(actor, tenant);
  }

  @Post('exchange')
  @Public()
  exchange(@Body() body: ExchangeDto): Promise<ExchangeResult> {
    return this.enrollments.exchange(body.token);
  }
}
