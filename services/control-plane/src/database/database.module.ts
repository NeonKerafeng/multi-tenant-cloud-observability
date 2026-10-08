import {
  Global,
  Module,
} from '@nestjs/common';

import { OutboxRepository } from '../sync/outbox.repository';
import { UserRepository } from '../users/user.repository';

import { DatabaseService } from './database.service';

/**
 * Global persistence: the DB connection plus the repositories that
 * several feature modules write to inside one transaction (users,
 * outbox). Keeping them here avoids circular module imports.
 */
@Global()
@Module({
  providers: [
    DatabaseService,
    OutboxRepository,
    UserRepository,
  ],

  exports: [
    DatabaseService,
    OutboxRepository,
    UserRepository,
  ],
})
export class DatabaseModule {}
