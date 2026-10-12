import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { Actor } from '../../common/auth/actor';
import {
  CurrentActor,
  CurrentTenant,
  Public,
  Roles,
  TenantScope,
} from '../../common/auth/decorators';
import type { ListResponse } from '../../common/http/list';
import type { TenantRecord } from '../tenants/tenant.repository';

import { ExchangeDto } from './dto';
import { EnrollmentsService } from './enrollments.service';
import { ExchangeRateLimiter } from './exchange-rate-limiter';
import {
  EnrollmentCreated,
  EnrollmentList,
  EnrollmentView,
  ExchangeResult,
} from './views';

/**
 * Agent enrollment: an admin creates a one-time token for a tenant; the
 * host trades it for its credentials. The tenant of the exchange comes
 * from the enrollment row, never from the caller.
 */
@ApiTags('agent-enrollments')
@Controller()
export class EnrollmentsController {
  constructor(
    private readonly enrollments: EnrollmentsService,
    private readonly limiter: ExchangeRateLimiter,
  ) {}

  /** Platform admins too, for any tenant (I-22a). The token is shown once. */
  @Post('tenants/:tenantKey/agent-enrollments')
  @Roles('platform-admin', 'tenant-admin')
  @TenantScope()
  @ApiCreatedResponse({ type: EnrollmentCreated })
  create(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<EnrollmentCreated> {
    return this.enrollments.create(actor, tenant);
  }

  /** The 100 newest enrollments of the tenant, with their state. */
  @Get('tenants/:tenantKey/agent-enrollments')
  @Roles('platform-admin', 'tenant-admin')
  @TenantScope()
  @ApiOkResponse({ type: EnrollmentList })
  async list(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
  ): Promise<ListResponse<EnrollmentView>> {
    return { items: await this.enrollments.list(actor, tenant) };
  }

  /** An unused token stops working at once (409 if it was already used). */
  @Delete('tenants/:tenantKey/agent-enrollments/:enrollmentId')
  @Roles('platform-admin', 'tenant-admin')
  @TenantScope()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Revoked (or already ended)' })
  async revoke(
    @CurrentActor() actor: Actor,
    @CurrentTenant() tenant: TenantRecord,
    @Param('enrollmentId') enrollmentId: string,
  ): Promise<void> {
    await this.enrollments.revoke(actor, tenant, enrollmentId);
  }

  /**
   * Public: called by client/bootstrap.sh on the host. Retry with the same
   * token after a failure; 410 once it has been used. Rate-limited.
   */
  @Post('agent-enrollments/exchange')
  @Public()
  @ApiCreatedResponse({ type: ExchangeResult })
  exchange(
    @Body() body: ExchangeDto,
    @Ip() ip: string,
  ): Promise<ExchangeResult> {
    this.limiter.check(ip);

    return this.enrollments.exchange(body.token, ip);
  }
}
