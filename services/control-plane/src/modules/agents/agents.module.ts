import { Module } from '@nestjs/common';

import { MirrorsModule } from '../../mirrors/mirrors.module';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [MirrorsModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
