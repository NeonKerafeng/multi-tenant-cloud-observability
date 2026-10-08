import {
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { OutboxRepository } from './outbox.repository';
import { ResyncService } from './resync.service';

type AuthenticatedRequest = Request & {
  user: AuthUser;
};

/**
 * Operations view of the Keycloak/Grafana mirrors (platform-admin only).
 */
@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly resync: ResyncService,
  ) {}

  /** Pending / failing events. Healthy = pending close to 0, failing 0. */
  @Get('status')
  async status(
    @Req() req: AuthenticatedRequest,
  ) {
    this.requirePlatformAdmin(req.user);

    return this.outbox.status();
  }

  /** Runs the slow resync now (adopt Keycloak users + enqueue all). */
  @Post('resync')
  async runResync(
    @Req() req: AuthenticatedRequest,
  ) {
    this.requirePlatformAdmin(req.user);

    return this.resync.run();
  }

  private requirePlatformAdmin(
    user: AuthUser,
  ): void {
    if (!user.roles.includes('platform-admin')) {
      throw new ForbiddenException(
        'platform-admin role required',
      );
    }
  }
}
