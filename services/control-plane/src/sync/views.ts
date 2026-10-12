import { ApiProperty } from '@nestjs/swagger';

import { AGGREGATES, type Aggregate, ALL_TARGETS, type Target } from './mirror';

export class TargetStatus {
  @ApiProperty({ description: 'Events not processed yet (≈0 when healthy)' })
  pending!: number;

  @ApiProperty({
    description: 'Pending events that failed 3+ times (0 when healthy)',
  })
  failing!: number;

  @ApiProperty({ description: 'Age of the oldest pending event, 0 when none' })
  oldestPendingSeconds!: number;
}

export class OutboxTargets implements Record<Target, TargetStatus> {
  @ApiProperty({ type: TargetStatus })
  keycloak!: TargetStatus;

  @ApiProperty({ type: TargetStatus })
  grafana!: TargetStatus;
}

export class OutboxError {
  @ApiProperty({ enum: ALL_TARGETS })
  target!: Target;

  @ApiProperty({ enum: AGGREGATES })
  aggregateType!: Aggregate;

  @ApiProperty({ format: 'uuid' })
  aggregateId!: string;

  @ApiProperty()
  attempts!: number;

  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;
}

/** GET /admin/sync/status: health of the Keycloak and Grafana mirrors. */
export class OutboxStatus {
  @ApiProperty({ type: OutboxTargets })
  targets!: OutboxTargets;

  @ApiProperty({ type: [OutboxError] })
  recentErrors!: OutboxError[];
}

/** POST /admin/sync/resync: what was queued for every mirror. */
export class ResyncResult {
  @ApiProperty()
  tenantsQueued!: number;

  @ApiProperty()
  usersQueued!: number;

  @ApiProperty()
  agentsQueued!: number;
}
