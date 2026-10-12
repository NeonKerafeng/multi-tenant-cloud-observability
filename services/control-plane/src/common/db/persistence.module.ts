import { Global, Module } from '@nestjs/common';

import { AgentRepository } from '../../modules/agents/agent.repository';
import { EnrollmentRepository } from '../../modules/enrollments/enrollment.repository';
import { SupportAccessRepository } from '../../modules/support-access/support-access.repository';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { UserRepository } from '../../modules/users/user.repository';
import { OutboxRepository } from '../../sync/outbox.repository';

import { DatabaseService } from './database.service';

const REPOSITORIES = [
  AgentRepository,
  EnrollmentRepository,
  OutboxRepository,
  SupportAccessRepository,
  TenantRepository,
  UserRepository,
];

/**
 * The DB connection and EVERY repository, global. Services, mirrors and
 * guards all write in shared transactions; providing repositories in one
 * place avoids circular module imports.
 */
@Global()
@Module({
  providers: [DatabaseService, ...REPOSITORIES],
  exports: [DatabaseService, ...REPOSITORIES],
})
export class PersistenceModule {}
