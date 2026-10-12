import { Module } from '@nestjs/common';

import { MirrorsModule } from '../../mirrors/mirrors.module';

import { MeController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [MirrorsModule],
  controllers: [UsersController, MeController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
