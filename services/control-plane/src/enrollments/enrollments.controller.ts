import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EnrollmentsService } from './enrollments.service';

@Controller('agent-enrollments')
export class EnrollmentsController {
  constructor(
    private readonly enrollmentsService: EnrollmentsService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(
    @Req() req: { user: AuthUser },
  ) {
    return this.enrollmentsService.create(req.user);
  }

  @Post('exchange')
  exchange(
    @Body() body: { token?: string },
  ) {
    return this.enrollmentsService.exchange(body.token ?? '');
  }
}
