import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module';

import { PlatformBootstrapService } from './platform-bootstrap.service';

@Module({
  imports: [UsersModule],
  providers: [PlatformBootstrapService],
})
export class PlatformModule {}
