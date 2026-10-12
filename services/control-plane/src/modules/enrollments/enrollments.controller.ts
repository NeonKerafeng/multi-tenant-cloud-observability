import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';

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
import { EnrollmentsService } from './enrollments.service';
import { EnrollmentCreated, ExchangeResult } from './views';

/**
 * Agent enrollment: an admin creates a one-time token for a tenant; the
 * host trades it for its credentials. The tenant of the exchange comes
 * from the token record, never from the caller.
 */
@ApiTags('agent-enrollments')
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  /** Platform admins too, for any tenant (I-22a). */
  @Post('tenants/:tenantKey/agent-enrollments')
  @Roles('platform-admin', 'tenant-admin')
  @TenantScope()
  @ApiCreatedResponse({ type: EnrollmentCreated })
  create(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): EnrollmentCreated {
    return this.enrollments.create(actor, tenant);
  }

  /** Public: called by client/bootstrap.sh on the host, once per token. */
  @Post('agent-enrollments/exchange')
  @Public()
  @ApiCreatedResponse({ type: ExchangeResult })
  exchange(@Body() body: ExchangeDto): Promise<ExchangeResult> {
    return this.enrollments.exchange(body.token);
  }
}
